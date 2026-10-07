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
    buildClassifyPrompt,
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

const REQUEST_TIMEOUT_MS = 600_000;

/** 把用户填的地址规范成 OpenAI 兼容的 base（自动补 /v1，去掉多余的 /chat/completions） */
export function normalizeApiBase(raw) {
    const base = String(raw ?? '').trim().replace(/\/+$/, '');
    if (!base) return '';
    const withoutEndpoint = base.replace(/\/chat\/completions$/i, '');
    if (/\/(v\d+|beta)$/i.test(withoutEndpoint)) return withoutEndpoint;
    return `${withoutEndpoint}/v1`;
}

function extractContentFromResponse(data) {
    const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
    if (choice?.message?.content !== undefined) return String(choice.message.content);
    if (choice?.text !== undefined) return String(choice.text);
    if (typeof data?.content === 'string') return data.content;
    if (typeof data?.text === 'string') return data.text;
    return '';
}

/** 非流式响应里的 SSE 文本（有些中转站无视 stream:false，仍回 SSE） */
function readSseText(body) {
    const pieces = [];
    for (const line of String(body).split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
            const chunk = JSON.parse(payload);
            const delta = chunk.choices?.[0]?.delta?.content;
            const message = chunk.choices?.[0]?.message?.content;
            if (typeof delta === 'string') pieces.push(delta);
            else if (typeof message === 'string') pieces.push(message);
        } catch {
            // 不是 JSON 的行直接跳过
        }
    }
    return pieces.join('');
}

/**
 * 通过酒馆后端转发一次 chat completion 请求。
 * 走 /api/backends/chat-completions/generate，出站请求与酒馆自身的生成同源同形。
 */
async function callCustomApi({ apiConfig, messages, maxTokens, signal, getRequestHeaders }) {
    const url = normalizeApiBase(apiConfig.url);
    if (!url) throw new Error('独立 API 未填写接口地址');
    if (!apiConfig.model) throw new Error('独立 API 未填写模型名');

    const payload = {
        messages,
        model: apiConfig.model,
        chat_completion_source: 'openai',
        reverse_proxy: url,
        proxy_password: apiConfig.key || '',
        stream: apiConfig.stream === true,
    };
    if (Number.isFinite(maxTokens) && maxTokens > 0) payload.max_tokens = Math.floor(maxTokens);
    for (const key of ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty']) {
        const value = Number(apiConfig[key]);
        if (Number.isFinite(value)) payload[key] = value;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), REQUEST_TIMEOUT_MS);
    if (signal) {
        signal.addEventListener('abort', () => controller.abort('cancelled'), { once: true });
    }

    try {
        const response = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: { ...(getRequestHeaders?.() || {}), 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });

        const bodyText = await response.text();

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}：${bodyText.slice(0, 300)}`);
        }

        // 优先按 JSON 解析；解析不出或内容为空时再尝试 SSE
        let text = '';
        try {
            const data = JSON.parse(bodyText);
            if (data?.error) throw new Error(String(data.message || data.error?.message || 'API 返回错误'));
            text = extractContentFromResponse(data);
        } catch (error) {
            if (error instanceof SyntaxError) {
                text = readSseText(bodyText);
            } else {
                throw error;
            }
        }
        if (!text.trim()) {
            text = readSseText(bodyText);
        }
        if (!text.trim()) throw new Error('API 返回内容为空');
        return text;
    } catch (error) {
        const message = String(error?.message || error);
        if (error?.name === 'AbortError' || message === 'timeout') {
            throw new Error('独立 API 请求超时');
        }
        if (message === 'cancelled') throw new Error('已取消');
        if (/Failed to fetch|NetworkError|ECONNREFUSED/i.test(message)) {
            throw new Error(`连不上独立 API（${message}）。检查地址、Key 和网络`);
        }
        throw new Error(message);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 主通道：酒馆当前连接（generateRaw）。
 */
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

/**
 * 带重试的独立 API 客户端。
 */
export function createCustomApiClient(context, apiConfig) {
    const getRequestHeaders = context?.getRequestHeaders?.bind(context);
    return async function callCustom(messages, { maxTokens, retries = 2, signal } = {}) {
        let lastError = null;
        for (let attempt = 0; attempt <= retries; attempt++) {
            if (signal?.aborted) throw new Error('已取消');
            try {
                return await callCustomApi({ apiConfig, messages, maxTokens, signal, getRequestHeaders });
            } catch (error) {
                lastError = error;
                // 配置类错误重试没意义，直接抛出
                if (/未填写|连不上/.test(String(error.message))) throw error;
                if (attempt >= retries) break;
                await sleep(1200 * (attempt + 1), signal);
            }
        }
        throw new Error(`独立 API 调用失败：${lastError?.message || lastError}`);
    };
}

/**
 * 按设置挑一个模型客户端。
 * @param {object} context 酒馆上下文
 * @param {{client?: 'tavern'|'custom', custom?: object}} settings
 */
export function createConfiguredModelClient(context, settings = {}) {
    if (settings.client === 'custom') {
        if (typeof fetch !== 'function') throw new Error('当前环境不支持 fetch，无法使用独立 API');
        return createCustomApiClient(context, settings.custom || {});
    }
    return createModelClient(context);
}

/** 探测独立 API 是否可达：拉一次 /models 或发一个最小请求 */
export async function testCustomApi({ apiConfig, getRequestHeaders }) {
    const url = normalizeApiBase(apiConfig.url);
    if (!url) throw new Error('未填写接口地址');
    if (!apiConfig.model) throw new Error('未填写模型名');

    const started = Date.now();
    const text = await callCustomApi({
        apiConfig,
        messages: [{ role: 'user', content: '回复两个字：可用' }],
        maxTokens: 16,
        getRequestHeaders,
    });
    return { ok: true, elapsedMs: Date.now() - started, sample: text.slice(0, 60) };
}

/** 从各种可能的返回形状里抠出模型 id 列表 */
export function extractModelIds(payload) {
    const rows = Array.isArray(payload?.data) ? payload.data
        : Array.isArray(payload?.models) ? payload.models
            : Array.isArray(payload) ? payload
                : [];
    const ids = [];
    for (const row of rows) {
        const id = typeof row === 'string' ? row : (row?.id ?? row?.name ?? row?.model);
        const text = String(id ?? '').trim();
        if (text) ids.push(text);
    }
    return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
}

/**
 * 拉取可用模型列表。
 *
 * 两条路径：先走酒馆后端代理（与生成请求同源，不受 CORS 影响），
 * 失败再直连 {base}/models 兜底（部分中转站只认直连）。
 *
 * @param {{apiConfig: {url: string, key?: string}, getRequestHeaders?: Function}} options
 * @returns {Promise<{models: string[], via: 'tavern'|'direct'}>}
 */
export async function fetchModelList({ apiConfig, getRequestHeaders }) {
    const base = normalizeApiBase(apiConfig.url);
    if (!base) throw new Error('请先填写接口地址');
    const key = apiConfig.key || '';

    const attempts = [];

    // 路径一：酒馆后端代理
    try {
        const response = await fetch('/api/backends/chat-completions/status', {
            method: 'POST',
            headers: { ...(getRequestHeaders?.() || {}), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_completion_source: 'openai',
                reverse_proxy: base,
                proxy_password: key,
            }),
        });
        if (response.ok) {
            const models = extractModelIds(await response.json());
            if (models.length) return { models, via: 'tavern' };
            attempts.push('酒馆代理返回空列表');
        } else {
            const detail = await response.text().catch(() => '');
            attempts.push(`酒馆代理 HTTP ${response.status} ${detail.slice(0, 120)}`.trim());
        }
    } catch (error) {
        attempts.push(`酒馆代理失败：${error?.message || error}`);
    }

    // 路径二：直连 /models
    try {
        const response = await fetch(`${base}/models`, {
            headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        });
        if (response.ok) {
            const models = extractModelIds(await response.json());
            if (models.length) return { models, via: 'direct' };
            attempts.push('直连返回空列表');
        } else {
            attempts.push(`直连 HTTP ${response.status}`);
        }
    } catch (error) {
        attempts.push(`直连失败：${error?.message || error}`);
    }

    throw new Error(`拿不到模型列表。${attempts.join('；')}`);
}

/**
 * 把模型名按与关键词的匹配度排序，方便在国家/厂商混杂的长列表里找。
 * 不改变大小写，只重排。
 */
export function sortModelsByRelevance(models, keyword) {
    const needle = String(keyword ?? '').trim().toLowerCase();
    if (!needle) return [...models];
    const score = name => {
        const lower = name.toLowerCase();
        if (lower === needle) return 0;
        if (lower.startsWith(needle)) return 1;
        if (lower.includes(needle)) return 2;
        return 3;
    };
    return [...models].sort((left, right) => score(left) - score(right) || left.localeCompare(right));
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
export async function extractProfile({ character, evidence, novelTitle, callModel, instruction, signal, tier }) {
    const messages = buildProfilePrompt({
        name: character.name,
        aliases: character.aliases,
        evidence,
        novelTitle,
        instruction,
        tier,
    });
    const raw = await callModel(messages, { maxTokens: isBriefTier(tier) ? 3000 : 6000, signal });
    const parsed = parseModelJson(raw);
    const profile = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!profile || typeof profile !== 'object') {
        throw new Error(`${character.name} 的档案格式不正确`);
    }
    return { ...profile, name: String(profile.name || character.name).trim() };
}

/** 是否走精简档案 */
export function isBriefTier(tier) {
    return tier === '次要配角' || tier === 'brief';
}

/**
 * 角色分级：主角 / 主要配角 / 次要配角。
 *
 * 只发名单 + 抽样原文，一次请求搞定。分级结果决定后续档案的详细度与配额，
 * 所以宁可多花这一次请求，也好过给一堆路人出完整人设。
 *
 * @returns {Map<string, {tier: string, reason: string}>} key 为归一化名字
 */
export async function classifyCharacters({
    characters,
    chunks,
    novelTitle,
    callModel,
    signal,
    sampleCount = 6,
}) {
    const names = characters.map(character => character.name).filter(Boolean);
    if (!names.length) return new Map();

    const picks = sampleChunks(chunks, sampleCount);
    const evidence = picks
        .map(item => `【第 ${item.index + 1} 段节选】\n${item.text.slice(0, 4000)}`)
        .join('\n\n');

    const messages = buildClassifyPrompt({ names, evidence, novelTitle });
    const raw = await callModel(messages, { maxTokens: 2000, signal });
    const parsed = asArray(parseModelJson(raw), 'characters');

    const result = new Map();
    for (const entry of parsed) {
        const name = String(entry?.name ?? '').trim();
        if (!name) continue;
        const tier = normalizeTier(entry?.tier);
        result.set(canonicalName(name), { tier, reason: String(entry?.reason ?? '').trim() });
    }
    return result;
}

/**
 * 档位归一：显式词表优先，再做保守兜底。
 *
 * 为什么不用子串/前缀判断：中文里「第一主角」包含「配角」两个字，
 * 「主要配角」又包含「主角」两个字，任何朴素的 includes/startsWith 都会判错其中一边。
 * 词表把常见写法写死，剩下的交给严格正则。
 */
const TIER_ALIASES = new Map([
    ['主角', '主角'], ['主人公', '主角'], ['男主', '主角'], ['女主', '主角'],
    ['第一主角', '主角'], ['视角人物', '主角'], ['主视角', '主角'],
    ['protagonist', '主角'], ['main', '主角'], ['main character', '主角'],
    ['主要配角', '主要配角'], ['重要配角', '主要配角'], ['配角', '主要配角'],
    ['次主角', '主要配角'], ['男二', '主要配角'], ['女二', '主要配角'],
    ['supporting', '主要配角'], ['supporting character', '主要配角'], ['major', '主要配角'],
    ['次要配角', '次要配角'], ['龙套', '次要配角'], ['背景人物', '次要配角'],
    ['路人', '次要配角'], ['npc', '次要配角'], ['minor', '次要配角'], ['side', '次要配角'],
]);

/** 明确的"次要"线索，优先级最高：出现它就不再往上升级 */
const MINOR_HINT = /次要|龙套|背景|路人|npc|minor|side character/i;

export function normalizeTier(value) {
    const text = String(value ?? '').trim();
    if (!text) return '主要配角';
    const lower = text.toLowerCase();

    // 1) 降级线索优先：「配角（龙套）」这种带次要注释的写法不能被词表的「配角」吃掉
    if (MINOR_HINT.test(text)) return '次要配角';

    // 2) 显式词表
    if (TIER_ALIASES.has(lower)) return TIER_ALIASES.get(lower);

    // 3) 带注释的写法：「主角（视角人物）」→ 取头部再查一次
    const head = text.split(/[（(【\s,，、:：/]/)[0].trim().toLowerCase();
    if (TIER_ALIASES.has(head)) return TIER_ALIASES.get(head);

    // 4) 兜底：写着"主角"且不含"配角"才算主角；「第一主角」这类靠词表和这里共同兜住
    const saysSupporting = text.includes('配角');
    if (!saysSupporting && /主角|主人公|protagonist/i.test(text)) return '主角';
    if (saysSupporting || /主要|重要|supporting|major/i.test(text)) return '主要配角';

    // 认不出来就当主要配角，至少不会被误降级成精简档案
    return '主要配角';
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
