/**
 * 角色卡构建：把 AI 抽出的结构化档案转成 Character Card V2 / V3 对象。
 *
 * V2 规范：{ spec: 'chara_card_v2', spec_version: '2.0', data: {...} }
 * V3 规范：{ spec: 'chara_card_v3', spec_version: '3.0', data: {...} }，字段为 V2 超集
 */

const SPEC_V2 = 'chara_card_v2';
const SPEC_V3 = 'chara_card_v3';

/** 模型有时会把内容写成数组或对象，这里统一压成字符串 */
export function toText(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
        return value.map(item => toText(item)).filter(Boolean).join('\n');
    }
    if (typeof value === 'object') {
        return Object.entries(value)
            .map(([key, item]) => {
                const text = toText(item);
                return text ? `${key}：${text}` : '';
            })
            .filter(Boolean)
            .join('\n');
    }
    return String(value);
}

function toTextList(value) {
    if (value === null || value === undefined) return [];
    if (Array.isArray(value)) return value.map(item => toText(item)).filter(Boolean);
    const text = toText(value);
    if (!text) return [];
    return text
        .split(/\r?\n|;|；|\|/)
        .map(line => line.replace(/^[-*·•\d.、)）\s]+/, '').trim())
        .filter(Boolean);
}

/** 把若干条内容拼成带小标题的段落，跳过空项 */
function sections(pairs) {
    return pairs
        .map(([title, body]) => {
            const text = toText(body);
            if (!text) return '';
            return title ? `${title}：${text}` : text;
        })
        .filter(Boolean)
        .join('\n');
}

/** 清洗名字：去掉书名号、引号、空白 */
export function normalizeName(name) {
    return String(name ?? '')
        .replace(/[《》〈〉「」『』【】\[\]"'“”‘’]/g, '')
        .replace(/\s+/g, '')
        .trim();
}

/**
 * 生成安全的文件名 / avatar 名。
 * 只剔除真正非法的字符，保留圆点、书名号等中文排版常见符号。
 */
export function safeFileName(name, fallback = 'character') {
    const cleaned = String(name ?? '')
        .replace(/[\\/:*?"<>|\r\n\t]/g, '')
        .replace(/^\.+/, '')
        .trim();
    return (cleaned || fallback).slice(0, 80);
}

/**
 * 用档案里的样例台词拼 mes_example。
 * 每段用 <START> 分隔，行首加 {{char}}: / {{user}}: 便于模型学会说话风格。
 */
export function buildMesExample(profile) {
    const lines = toTextList(profile.example_dialogue);
    if (!lines.length) return '';

    const blocks = [];
    let current = [];
    for (const line of lines) {
        const isUser = /^(user|{{user}}|玩家|我)[:：]/.test(line);
        const cleaned = line
            .replace(/^({{char}}|char|角色|\{\{user\}\}|user|玩家|我)\s*[:：]\s*/, '')
            .trim();
        if (!cleaned) continue;
        current.push(`${isUser ? '{{user}}' : '{{char}}'}: ${cleaned}`);
        if (current.length >= 2) {
            blocks.push(current.join('\n'));
            current = [];
        }
    }
    if (current.length) blocks.push(current.join('\n'));
    if (!blocks.length) return '';
    return `<START>\n${blocks.join('\n<START>\n')}`;
}

/**
 * 把 AI 档案转成卡面 data 字段。
 * @param {object} profile AI 抽取结果
 * @param {{creator?: string, version?: string, tags?: string[]}} meta
 */
export function buildCardData(profile, meta = {}) {
    const name = normalizeName(profile?.name) || '未命名角色';
    const aliases = toTextList(profile?.aliases);

    const description = sections([
        ['身份', profile?.role],
        ['概述', profile?.summary],
        ['外貌', profile?.appearance],
        ['性格', profile?.personality],
        ['背景', profile?.background],
        ['能力', profile?.abilities],
        ['人际关系', profile?.relationships],
        ['其他', profile?.other],
    ]);

    const personality = sections([
        ['性格关键词', toTextList(profile?.personality_tags).join('、')],
        ['说话风格', profile?.speech_style],
        ['行为习惯', profile?.habits],
    ]) || toText(profile?.personality);

    const scenario = sections([
        ['故事背景', profile?.world_context],
        ['当前处境', profile?.scenario],
    ]);

    const creatorNotes = sections([
        ['由小说文本自动提取', ''],
        ['别名', aliases.join('、')],
        ['置信度', profile?.confidence],
        ['备注', profile?.notes],
    ]);

    const tags = Array.isArray(meta.tags) ? meta.tags.filter(Boolean) : [];

    return {
        name,
        description,
        personality,
        scenario,
        first_mes: toText(profile?.first_mes),
        mes_example: buildMesExample(profile),
        creator_notes: creatorNotes,
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: toTextList(profile?.alternate_greetings),
        character_book: null, // 由 world-builder 填充
        tags,
        creator: meta.creator || '小说转角色卡',
        character_version: meta.version || '1.0',
        extensions: {
            talkativeness: '0.5',
            fav: false,
            novel_to_card: {
                aliases,
                source: meta.source || '',
                confidence: profile?.confidence ?? null,
                created_at: new Date().toISOString(),
            },
        },
    };
}

/**
 * 生成 V2 卡对象。
 */
export function buildCardV2(profile, meta = {}) {
    const data = buildCardData(profile, meta);
    return {
        spec: SPEC_V2,
        spec_version: '2.0',
        data,
        // 部分老前端直接读顶层字段，这里冗余一份保证兼容
        name: data.name,
        description: data.description,
        personality: data.personality,
        scenario: data.scenario,
        first_mes: data.first_mes,
        mes_example: data.mes_example,
    };
}

/**
 * 生成 V3 卡对象（在 V2 基础上补 V3 专有字段与 assets）。
 */
export function buildCardV3(profile, meta = {}) {
    const v2 = buildCardV2(profile, meta);
    const data = { ...v2.data };

    data.creator_notes_multilingual = {};
    data.source = Array.isArray(meta.sources) ? meta.sources : [];
    data.group_only_greetings = [];
    data.creation_date = Math.floor(Date.now() / 1000);
    data.modification_date = data.creation_date;
    data.assets = [];

    return {
        spec: SPEC_V3,
        spec_version: '3.0',
        data,
        name: data.name,
        description: data.description,
        personality: data.personality,
        scenario: data.scenario,
        first_mes: data.first_mes,
        mes_example: data.mes_example,
    };
}

/** 预览用的统计信息 */
export function summarizeCard(cardV3) {
    const data = cardV3?.data || {};
    const length = (text) => toText(text).length;
    return {
        name: data.name,
        total: length(data.description) + length(data.personality) + length(data.scenario)
            + length(data.first_mes) + length(data.mes_example),
        description: length(data.description),
        personality: length(data.personality),
        scenario: length(data.scenario),
        first_mes: length(data.first_mes),
        mes_example: length(data.mes_example),
        greetings: (data.alternate_greetings || []).length,
        bookEntries: data.character_book?.entries?.length || 0,
    };
}
