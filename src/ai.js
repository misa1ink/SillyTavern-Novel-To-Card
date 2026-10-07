/**
 * AI 提取管线：分段扫描 → 合并同一角色 → 收集原文证据 → 出结构化档案。
 *
 * 文本生成统一走酒馆主通道 getContext().generateRaw()，
 * 只有当前连接、当前上下文，不污染聊天记录，也不进预设注入。
 */

import {
    buildDiscoveryPrompt,
    buildProfilePrompt,
    buildWorldPrompt,
    parseModelJson,
    asArray,
} from './prompts.js';

const DEFAULT_CHUNK_CHARS = 6000;

// ---------------------------------------------------------------- 并发闸门

function createLimiter(concurrency) {
    const limit = Math.max(1, Number(concurrency) || 1);
    let active = 0;
    const queue = [];

    const next = () => {
        if (active >= limit || !queue.length) return;
        active++;
        const { fn, resolve, reject } = queue.shift();
        Promise.resolve()
            .then(fn)
            .then(resolve, reject)
            .finally(() => {
                active--;
                next();
            });
    };

    return (fn) => new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject });
        next();
    });
}

// ---------------------------------------------------------------- 模型调用

export function createModelClient(context) {
    if (!context || typeof context.generateRaw !== 'function') {
        throw new Error('当前环境不支持 generateRaw，无法调用模型（请确认酒馆版本或酒馆助手扩展已加载）');
    }

    return async function callModel(messages, { maxTokens, retries = 2, signal } = {}) {
        let lastError = null;
        for (let attempt = 0; attempt <= retries; attempt++) {
            if (signal?.aborted) throw new Error('已取消');
            try {
                const options = { prompt: messages };
                if (Number.isFinite(maxTokens) && maxTokens > 0) {
                    options.responseLength = Math.floor(maxTokens);
                }
                const text = await context.generateRaw(options);
                const result = String(text ?? '').trim();
                if (!result) throw new Error('模型返回空内容');
                return result;
            } catch (error) {
                lastError = error;
                if (attempt >= retries) break;
                const wait = 1200 * (attempt + 1);
                await sleep(wait, signal);
            }
        }
        throw new Error(`模型调用失败：${lastError?.message || lastError}`);
    };
}

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        if (signal) {
            signal.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(new Error('已取消'));
            }, { once: true });
        }
    });
}

// ---------------------------------------------------------------- 分段

/**
 * 按字数切分小说，尽量落在段落边界上，段间保留少量重叠以保护跨段对话。
 * @param {string} text
 * @param {{chunkChars?: number, overlapChars?: number}} options
 * @returns {string[]}
 */
export function splitNovel(text, options = {}) {
    const chunkChars = Math.max(1200, Number(options.chunkChars) || DEFAULT_CHUNK_CHARS);
    const overlap = Math.min(Math.floor(chunkChars * 0.2), Math.max(0, Number(options.overlapChars) || 0));

    const normalized = String(text ?? '')
        .replace(/\r\n?/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    if (!normalized) return [];
    if (normalized.length <= chunkChars) return [normalized];

    const paragraphs = normalized.split(/\n(?=\S)/);
    const chunks = [];
    let buffer = '';

    const flush = () => {
        const text = buffer.trim();
        if (text) chunks.push(text);
        buffer = '';
    };

    for (const paragraph of paragraphs) {
        if (paragraph.length > chunkChars) {
            flush();
            for (let index = 0; index < paragraph.length; index += chunkChars - overlap) {
                const piece = paragraph.slice(index, index + chunkChars).trim();
                if (piece) chunks.push(piece);
            }
            continue;
        }
        if ((buffer + '\n' + paragraph).length > chunkChars) {
            flush();
            if (overlap > 0 && chunks.length) {
                buffer = chunks[chunks.length - 1].slice(-overlap) + '\n';
            }
        }
        buffer += (buffer ? '\n' : '') + paragraph;
    }
    flush();

    return chunks;
}

/** 均匀抽样若干段，用于不需要全文的粗粒度任务（如世界书） */
export function sampleChunks(chunks, maxCount) {
    if (chunks.length <= maxCount) return chunks.map((text, index) => ({ text, index }));
    const picked = [];
    const step = chunks.length / maxCount;
    for (let i = 0; i < maxCount; i++) {
        const index = Math.min(chunks.length - 1, Math.floor(i * step));
        picked.push({ text: chunks[index], index });
    }
    return picked;
}

// ---------------------------------------------------------------- 角色合并

/** 归一化名字用于比对：去空白、去标点、去常见后缀 */
export function canonicalName(name) {
    return String(name ?? '')
        .replace(/[\s\u3000]/g, '')
        .replace(/[《》〈〉「」『』【】\[\]()（）·・.,，。:：;；!！?？'"“”‘’\-_]/g, '')
        .toLowerCase();
}

const SCREEN_TIME_WEIGHT = { high: 3, mid: 2, low: 1 };

/**
 * 把各分段的发现结果合并成角色列表。
 * 同名或互为别名的条目会被归并，同时累计出现次数与出处。
 *
 * @param {Array<{name: string, aliases?: string[], role?: string, screen_time?: string, chunkIndex: number}>} discoveries
 * @returns {Array<object>}
 */
export function mergeCharacters(discoveries) {
    /** @type {Map<string, {names: Set<string>, aliases: Set<string>, roles: Map<string, number>, chunks: Set<number>, screenTime: Set<string>}>} */
    const groups = new Map();

    const findGroup = (key) => {
        for (const [, group] of groups) {
            if (group.names.has(key)) return group;
            for (const alias of group.aliases) {
                if (alias === key) return group;
            }
        }
        return null;
    };

    for (const item of discoveries) {
        const name = String(item?.name ?? '').trim();
        const nameKey = canonicalName(name);
        if (!nameKey || nameKey.length < 1) continue;

        const aliases = (Array.isArray(item?.aliases) ? item.aliases : [])
            .map(alias => String(alias ?? '').trim())
            .filter(Boolean);
        const aliasKeys = aliases.map(canonicalName).filter(Boolean);

        let group = findGroup(nameKey) || aliasKeys.map(findGroup).find(Boolean) || null;
        if (!group) {
            group = {
                names: new Set(),
                aliases: new Set(),
                roles: new Map(),
                chunks: new Set(),
                screenTime: new Set(),
            };
            groups.set(nameKey, group);
        }

        group.names.add(nameKey);
        for (const aliasKey of aliasKeys) group.aliases.add(aliasKey);
        for (const alias of aliases) group.aliases.add(canonicalName(alias));

        const role = String(item?.role ?? '').trim();
        if (role) group.roles.set(role, (group.roles.get(role) || 0) + 1);
        if (Number.isFinite(item?.chunkIndex)) group.chunks.add(item.chunkIndex);
        if (item?.screen_time) group.screenTime.add(String(item.screen_time).toLowerCase());

        // 记录显示名：优先取最长的原名
        group.names.add(nameKey);
        group.displayName = pickDisplayName(group.displayName, name);
    }

    const results = [];
    for (const group of groups.values()) {
        const role = [...group.roles.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
        const screenTime = group.screenTime.has('high') ? 'high'
            : group.screenTime.has('mid') ? 'mid'
                : group.screenTime.has('low') ? 'low' : 'mid';
        const score = (SCREEN_TIME_WEIGHT[screenTime] || 1) * 10 + group.chunks.size;

        results.push({
            name: group.displayName || [...group.names][0],
            aliases: [...group.aliases].filter(alias => !group.names.has(alias)),
            role,
            screen_time: screenTime,
            chunkIndexes: [...group.chunks].sort((a, b) => a - b),
            score,
        });
    }

    return results.sort((a, b) => b.score - a.score);
}

function pickDisplayName(current, candidate) {
    if (!current) return candidate;
    // 中文名通常 2-4 字，选更长的那个能避开"小玉"这类简称
    return candidate.length > current.length ? candidate : current;
}

// ---------------------------------------------------------------- 证据收集

/**
 * 为某个角色从全文里挑出最相关的片段。
 * 命中别名越多的段落排越前，命中处附带前后文。
 */
export function collectEvidence(chunks, character, options = {}) {
    const { maxChunks = 8, windowSize = 1400, maxChars = 12000 } = options;

    const keys = [character.name, ...(character.aliases || [])]
        .map(name => String(name ?? '').trim())
        .filter(name => name.length >= 2);
    if (!keys.length) return '';

    const scored = [];
    chunks.forEach((text, index) => {
        let hits = 0;
        const positions = [];
        for (const key of keys) {
            let from = 0;
            while (hits < 60) {
                const at = text.indexOf(key, from);
                if (at < 0) break;
                hits++;
                positions.push(at);
                from = at + key.length;
            }
        }
        if (!hits) return;
        scored.push({ index, hits, positions: positions.sort((a, b) => a - b), text });
    });

    scored.sort((a, b) => b.hits - a.hits || a.index - b.index);

    const pieces = [];
    let used = 0;
    for (const item of scored.slice(0, maxChunks)) {
        const snippet = extractWindow(item.text, item.positions, windowSize);
        if (!snippet) continue;
        const block = `【第 ${item.index + 1} 段片段】\n${snippet}`;
        if (used + block.length > maxChars) break;
        pieces.push(block);
        used += block.length;
    }

    // 按原文顺序重排，帮助模型理解时间线
    return pieces.sort((left, right) => {
        const leftIndex = Number(left.match(/第 (\d+) 段/)?.[1] || 0);
        const rightIndex = Number(right.match(/第 (\d+) 段/)?.[1] || 0);
        return leftIndex - rightIndex;
    }).join('\n\n');
}

/** 以命中位置为中心取窗口，命中点互相接近时合并 */
function extractWindow(text, positions, windowSize) {
    if (!positions.length) return '';
    const half = Math.floor(windowSize / 2);
    const ranges = [];
    for (const position of positions) {
        const start = Math.max(0, position - half);
        const end = Math.min(text.length, position + half);
        const last = ranges[ranges.length - 1];
        if (last && start <= last.end + 200) {
            last.end = Math.max(last.end, end);
        } else {
            ranges.push({ start, end });
        }
    }
    return ranges
        .map(range => text.slice(range.start, range.end).trim())
        .filter(Boolean)
        .join('\n……\n');
}

// ---------------------------------------------------------------- 主流程

/**
 * 阶段 A：分段扫描出场人物。
 */
export async function discoverCharacters({ chunks, novelTitle, callModel, concurrency = 3, maxCharsPerCall = 9000, onProgress, signal }) {
    const limiter = createLimiter(concurrency);
    const batches = [];
    // 把过短的段落合批，减少请求数
    let current = [];
    let currentChars = 0;
    chunks.forEach((text, index) => {
        current.push({ text, index });
        currentChars += text.length;
        if (currentChars >= maxCharsPerCall) {
            batches.push(current);
            current = [];
            currentChars = 0;
        }
    });
    if (current.length) batches.push(current);

    const knownNames = [];
    let done = 0;
    const tasks = batches.map((batch, batchIndex) => limiter(async () => {
        if (signal?.aborted) throw new Error('已取消');
        const messages = buildDiscoveryPrompt({
            chunks: batch.map(item => item.text),
            novelTitle,
            knownNames,
        });
        const raw = await callModel(messages, { maxTokens: 3000, signal });
        let parsed;
        try {
            parsed = asArray(parseModelJson(raw), 'characters');
        } catch (error) {
            console.warn(`[小说转角色卡] 第 ${batchIndex + 1} 批人物扫描解析失败，已跳过：`, error);
            parsed = [];
        }

        const baseIndex = batch[0]?.index ?? 0;
        const items = [];
        for (const entry of parsed) {
            const name = String(entry?.name ?? '').trim();
            if (!name) continue;
            items.push({
                name,
                aliases: Array.isArray(entry?.aliases) ? entry.aliases : [],
                role: entry?.role,
                screen_time: entry?.screen_time,
                chunkIndex: baseIndex,
            });
            if (!knownNames.includes(name)) knownNames.push(name);
        }

        done++;
        onProgress?.(done, batches.length, `扫描人物 ${done}/${batches.length}`);
        return items;
    }));

    const settled = await Promise.all(tasks);
    return settled.flat();
}

/**
 * 阶段 C：单个角色的结构化档案。
 */
export async function extractProfile({ character, evidence, novelTitle, callModel, instruction, signal }) {
    const messages = buildProfilePrompt({
        name: character.name,
        aliases: character.aliases,
        evidence,
        novelTitle,
        instruction,
    });
    const raw = await callModel(messages, { maxTokens: 6000, signal });
    const parsed = parseModelJson(raw);
    const profile = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!profile || typeof profile !== 'object') {
        throw new Error(`${character.name} 的档案格式不正确`);
    }
    return { ...profile, name: String(profile.name || character.name).trim() };
}

/**
 * 世界书条目抽取。
 */
export async function extractWorldEntries({ chunks, novelTitle, characters, categories, callModel, instruction, signal, sampleCount = 8 }) {
    const picks = sampleChunks(chunks, sampleCount);
    const evidence = picks
        .map(item => `【第 ${item.index + 1} 段节选】\n${item.text.slice(0, 5000)}`)
        .join('\n\n');

    const messages = buildWorldPrompt({
        characters,
        evidence,
        novelTitle,
        categories,
        instruction,
    });
    const raw = await callModel(messages, { maxTokens: 8000, signal });
    return asArray(parseModelJson(raw), 'entries');
}
