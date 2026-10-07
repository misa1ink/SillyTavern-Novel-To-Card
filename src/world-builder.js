/**
 * 世界书构建：
 *   - 生成可直接导入酒馆的世界书 JSON（/api/worldinfo 格式）
 *   - 生成可内嵌进 V3 角色卡的 character_book 对象
 */

import { toText } from './card-builder.js';

/** 酒馆世界书条目的 position 取值 */
export const POSITION = {
    before_char: 0,
    after_char: 1,
    before_an: 2,
    after_an: 3,
    at_depth: 4, // @D：按 depth 插进聊天记录
    em_top: 5,
    em_bottom: 6,
};

const DEFAULT_CATEGORY = '设定';

/**
 * 通用词 / 指示代词做触发词没有意义（会在任何对话里误触发），整词丢弃。
 * 用集合整词比对，而不是正则前缀匹配：整词语义明确，也不会误伤
 * 含通用词的专有名词（如「对方阵营」「他自己的剑」）。
 */
const GENERIC_KEYS = new Set([
    // 人称代词
    '他', '她', '它', '祂', '他们', '她们', '它们',
    '我', '你', '您', '我们', '你们', '咱们', '自己', '大家', '人们', '众人', '对方',
    // 指示代词
    '这个', '那个', '这些', '那些', '这里', '那里', '这边', '那边', '这样', '那样',
    '这个地方', '那个地方', '这个地方的', '那个地方的',
    // 虚词与口头语
    '什么', '怎么', '为什么', '然后', '于是', '所以', '但是', '因为', '如果',
    '已经', '可能', '知道', '觉得', '一个', '东西', '事情', '时候',
]);

/** 去掉零宽字符与首尾空白，避免模型输出里夹带不可见字符导致比对失败 */
function normalizeKeyText(value) {
    return String(value ?? '')
        .replace(/[\u200b-\u200f\u2028\u2029\ufeff]/g, '')
        .trim();
}

function isGenericKey(key) {
    return GENERIC_KEYS.has(key);
}

/**
 * 关键词允许是字符串、逗号分隔的字符串，或嵌套数组（模型经常写成 [["甲","乙"]]）。
 */
function flattenKeys(value, out = []) {
    if (value === null || value === undefined) return out;
    if (Array.isArray(value)) {
        for (const item of value) flattenKeys(item, out);
        return out;
    }
    if (typeof value === 'object') {
        flattenKeys(value.key ?? value.keys ?? value.value, out);
        return out;
    }
    const text = normalizeKeyText(value);
    if (!text) return out;
    for (const part of text.split(/[,，、;；|]/)) {
        const key = normalizeKeyText(part);
        if (key) out.push(key);
    }
    return out;
}

function normalizeKeyList(value) {
    const keys = flattenKeys(value).filter(key => key.length >= 2 && !isGenericKey(key));
    return [...new Set(keys)].slice(0, 8);
}

/** 世界书内容里不允许出现未转义的 HTML 标签，简单清洗一下 */
function sanitizeContent(text) {
    return toText(text)
        .replace(/<\s*(script|iframe|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
        .trim();
}

/**
 * 把 AI 输出整理成统一的条目数组。
 * @param {Array<object>} rawEntries
 * @returns {Array<{comment: string, keys: string[], content: string, category: string, constant: boolean}>}
 */
export function normalizeEntries(rawEntries) {
    const out = [];
    const seen = new Set();

    for (const item of Array.isArray(rawEntries) ? rawEntries : []) {
        if (!item || typeof item !== 'object') continue;
        const content = sanitizeContent(item.content ?? item.value ?? item.text);
        if (!content) continue;

        const keys = normalizeKeyList(item.keys ?? item.key ?? item.keywords);
        const comment = String(item.comment ?? item.title ?? item.name ?? keys[0] ?? '').trim() || `条目 ${out.length + 1}`;
        const dedupeKey = `${comment}::${content.slice(0, 60)}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        out.push({
            comment,
            keys: keys.length ? keys : [comment],
            content,
            category: String(item.category ?? DEFAULT_CATEGORY).trim() || DEFAULT_CATEGORY,
            constant: item.constant === true || item.constant === 'true',
        });
    }
    return out;
}

let entryUid = 0;

function nextUid() {
    entryUid += 1;
    return entryUid;
}

/**
 * 生成酒馆世界书数据对象（loadWorldInfo / saveWorldInfo 用的结构）。
 *
 * @param {Array<object>} entries normalizeEntries 的结果
 * @param {{name?: string, description?: string, scanDepth?: number, tokenBudget?: number, recursive?: boolean}} meta
 */
export function buildWorldInfoData(entries, meta = {}) {
    const data = {
        name: meta.name || '小说世界书',
        description: meta.description || '由小说文本自动提取',
        scan_depth: Number(meta.scanDepth) || 4,
        token_budget: Number(meta.tokenBudget) || 2048,
        recursive_scanning: meta.recursive !== false,
        extensions: {
            novel_to_card: {
                created_at: new Date().toISOString(),
                entries: entries.length,
            },
        },
        entries: {},
    };

    entries.forEach((entry, index) => {
        const uid = nextUid();
        data.entries[uid] = {
            uid,
            key: entry.keys,
            keysecondary: [],
            comment: entry.comment,
            content: entry.content,
            constant: entry.constant,
            vectorized: false,
            selective: true,
            selectiveLogic: 0,
            addMemo: true,
            order: 100 + index,
            position: entry.constant ? POSITION.before_char : POSITION.after_char,
            disable: false,
            excludeRecursion: false,
            preventRecursion: false,
            delayUntilRecursion: false,
            probability: 100,
            useProbability: true,
            depth: 4,
            group: entry.category || DEFAULT_CATEGORY,
            groupOverride: false,
            groupWeight: 100,
            scanDepth: null,
            caseSensitive: null,
            matchWholeWords: null,
            useGroupScoring: null,
            automationId: '',
            role: 0,
            sticky: null,
            cooldown: null,
            delay: null,
            displayIndex: index,
        };
    });

    return data;
}

/**
 * 生成角色卡内嵌的 character_book（V2/V3 规范）。
 */
export function buildCharacterBook(entries, meta = {}) {
    return {
        name: meta.name || '小说世界书',
        description: meta.description || '由小说文本自动提取，随角色卡一起导入',
        scan_depth: Number(meta.scanDepth) || 4,
        token_budget: Number(meta.tokenBudget) || 2048,
        recursive_scanning: meta.recursive !== false,
        extensions: {},
        entries: entries.map((entry, index) => ({
            keys: entry.keys,
            content: entry.content,
            extensions: {
                position: entry.constant ? POSITION.before_char : POSITION.after_char,
                exclude_recursion: false,
                display_index: index,
                probability: 100,
                useProbability: true,
                group: entry.category || DEFAULT_CATEGORY,
            },
            enabled: true,
            insertion_order: 100 + index,
            case_sensitive: false,
            name: entry.comment,
            priority: 10,
            id: index,
            comment: entry.comment,
            selective: true,
            secondary_keys: [],
            constant: entry.constant,
            position: entry.constant ? 'before_char' : 'after_char',
        })),
    };
}

/** 统计信息，给 UI 显示用 */
export function summarizeEntries(entries) {
    const byCategory = new Map();
    for (const entry of entries) {
        byCategory.set(entry.category, (byCategory.get(entry.category) || 0) + 1);
    }
    return {
        total: entries.length,
        constant: entries.filter(entry => entry.constant).length,
        categories: [...byCategory.entries()].sort((a, b) => b[1] - a[1]),
    };
}
