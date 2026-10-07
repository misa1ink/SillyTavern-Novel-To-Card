/**
 * 提示词模板与 LLM 输出解析。
 *
 * 三段式提取：
 *   A. 分段扫描出场人物（只记名字/别名/角色定位，输出小，可并发）
 *   B. 合并同名角色 + 收集原文证据
 *   C. 逐角色出结构化档案（输出大，串行/低并发）
 */

export const EXTRACT_SYSTEM_PROMPT = [
    '你是一位严谨的中文小说文本分析员，专门为角色扮演（RP）角色卡整理素材。',
    '你的输出必须严格遵循用户要求的格式，不得添加任何解释性文字或 Markdown 代码块以外的内容。',
    '所有结论必须来自原文，禁止编造原文没有的设定。',
].join('\n');

function numberedChunks(chunks) {
    return chunks.map((text, index) => `【第 ${index + 1} 段】\n${text}`).join('\n\n');
}

// ---------------------------------------------------------------- A. 出场人物

export function buildDiscoveryPrompt({ chunks, novelTitle, knownNames = [] }) {
    const known = knownNames.length
        ? `\n已知角色（本段若出现同一人物，请沿用完全相同的名字）：${knownNames.join('、')}\n`
        : '';

    const user = `下面是一部小说《${novelTitle || '未命名'}》的若干连续段落。请找出其中**实际出场**或**被反复提及**的人物。
${known}
要求：
1. 只收录有名有姓或被稳定称呼的人物，不要收录"路人""侍卫甲"这类泛称。
2. "出场次数"按你的观察填 high / mid / low。
3. 别名包含：称呼、称号、昵称、代称、原名。没有就留空数组。
4. 只输出 JSON 数组，不要任何解释，不要 Markdown 代码块。

输出格式（数组，每个元素一个角色）：
[
  {"name": "姓名", "aliases": ["别名1", "别名2"], "role": "一句话定位，如：宗门首席弟子", "screen_time": "high"}
]

小说段落：
${numberedChunks(chunks)}`;

    return [
        { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
        { role: 'user', content: user },
    ];
}

// ---------------------------------------------------------------- C. 单人档案

/** 完整档案：主角用，字段全、要求细 */
const PROFILE_SCHEMA_FULL = `{
  "name": "__NAME__",
  "aliases": ["别名"],
  "role": "身份定位",
  "summary": "150字以内的人物概述",
  "appearance": "外貌、衣着、体态、标志性特征",
  "personality": "性格特征的完整描述，含优点缺点",
  "personality_tags": ["傲娇", "护短"],
  "speech_style": "说话风格、口癖、用词习惯、称呼他人的方式",
  "habits": "行为习惯、小动作、喜好忌讳",
  "background": "身世、经历、关键过往",
  "abilities": "能力、武功、特长、弱点",
  "relationships": "与其他角色的关系，逐条写",
  "world_context": "所处的世界观与时代背景",
  "scenario": "适合开场时的处境",
  "first_mes": "开场白正文",
  "alternate_greetings": ["另一个开场情境的正文"],
  "example_dialogue": ["角色名：台词", "我：台词"],
  "confidence": "high 或 mid 或 low，表示素材是否充足",
  "notes": "其他值得写进角色卡的细节"
}`;

/** 精简档案：次要配角用，只保留撑得起一张卡的最小信息量 */
const PROFILE_SCHEMA_BRIEF = `{
  "name": "__NAME__",
  "aliases": ["别名"],
  "role": "身份定位",
  "summary": "100字以内的概述",
  "personality": "性格与行事风格，一段话说清",
  "personality_tags": ["关键词"],
  "speech_style": "说话风格、口癖、称呼他人的方式",
  "relationships": "与主要角色的关系",
  "scenario": "适合开场时的处境",
  "first_mes": "80-150字的开场白",
  "example_dialogue": ["角色名：台词", "我：台词"],
  "confidence": "high 或 mid 或 low",
  "notes": "补充细节"
}`;

const PROFILE_RULES_FULL = `4. example_dialogue 必须从原文摘取或改写该角色的真实台词，每条以"角色名："或"我："开头，4-8 条。
5. first_mes 是一段 150-300 字的开场白，用该角色的第一人称或第三人称叙述，写出当下场景，让玩家可以直接接着演下去。`;

const PROFILE_RULES_BRIEF = `4. example_dialogue 摘取 2-4 条该角色的真实台词即可。
5. first_mes 是一段 80-150 字的简短开场白，能让人物立起来就行，不必铺陈场景。
6. 这是次要配角，篇幅要克制：不要写长篇外貌、能力、背景，把信息密度放在性格和说话方式上。`;

/**
 * @param {{name: string, aliases?: string[], evidence: string, novelTitle?: string, instruction?: string, tier?: '主角'|'主要配角'|'次要配角'|'brief'|'full'}} options
 */
export function buildProfilePrompt({ name, aliases, evidence, novelTitle, instruction, tier }) {
    const extra = instruction ? `\n额外要求：${instruction}\n` : '';
    const isBrief = tier === '次要配角' || tier === 'brief';
    const schema = (isBrief ? PROFILE_SCHEMA_BRIEF : PROFILE_SCHEMA_FULL).replace('__NAME__', name);
    const rules = isBrief ? PROFILE_RULES_BRIEF : PROFILE_RULES_FULL;
    const tierNote = isBrief
        ? '这是一个次要配角，档案保持精简，别写成长篇小传。'
        : '这是一个主要角色，档案要尽量完整。';
    const aliasNote = aliases?.length ? `\n已知该角色的其他称呼：${aliases.join('、')}` : '';

    const user = `下面是小说《${novelTitle || '未命名'}》中与角色「${name}」相关的全部原文片段（可能有重复或顺序错乱）。

请为「${name}」整理一张角色扮演角色卡所需的档案。${tierNote}${aliasNote}${extra}
硬性要求：
1. 只使用片段中出现的信息；片段没提到的字段填空字符串 ""，不要写"未知""原文未提及"。
2. 不要写分析过程、不要复述任务、不要输出 JSON 以外的任何字符。
3. 用中文书写，条目化，不要用 Markdown 标题符号。
${rules}

只输出如下 JSON 对象：
${schema}

相关原文片段：
${evidence}`;

    return [
        { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
        { role: 'user', content: user },
    ];
}

// ---------------------------------------------------------------- 世界书

export function buildWorldPrompt({ characters, evidence, novelTitle, categories, instruction }) {
    const extra = instruction ? `\n额外要求：${instruction}\n` : '';
    const categoryText = (categories || []).map(item => item.label).join('、');

    const user = `下面是小说《${novelTitle || '未命名'}》的世界观素材，以及已提取的主要角色名单。

请整理一份"世界书"（World Info / Lorebook）条目表，供角色扮演时按关键词自动触发注入。

分类参考：${categoryText || '地点、势力、事件、物品、概念、配角'}
硬性要求：
1. 每条只讲一件事，content 控制在 400 字以内，写成陈述句设定，不要写分析。
2. keys 是触发关键词，3-6 个，必须是从原著中能自然出现的词（人名、地名、招式名、专有名词），不要用"他""那个地方"这类通用词。
3. 不要把主角本人的完整人设写进条目（那属于角色卡），配角可以。
4. 重要且需要常驻的条目（世界观基石、核心设定）把 constant 设为 true。
5. 只输出 JSON 数组，不要解释，不要 Markdown 代码块。

输出格式：
[
  {"comment": "条目名，如：天机阁", "keys": ["天机阁", "阁主", "机关术"], "content": "设定正文", "category": "势力", "constant": false}
]

已提取的角色：${(characters || []).join('、') || '无'}

小说素材：
${evidence}`;

    return [
        { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
        { role: 'user', content: user },
    ];
}

// ---------------------------------------------------------------- 角色分级

export function buildClassifyPrompt({ names, evidence, novelTitle }) {
    const user = `下面是小说《${novelTitle || '未命名'}》的人物名单，以及若干原文节选。

请判断每个人物的**重要程度**，分为三档：

- "主角"：故事的核心视角或主要推动者，贯穿全书，有完整的成长线
- "主要配角"：戏份很多、对主线有实质影响，但并非核心视角
- "次要配角"：偶尔出场、功能性角色、只被提及的背景人物

判断依据：
1. 优先看该人物在节选中出现的频率与深度（是否推动情节、是否有对话与心理描写）
2. 名字出现在书名/简介/章节标题里的，通常重要度更高
3. 拿不准就判低一档——宁缺勿滥，角色卡太多反而不好用

只输出 JSON 数组，不要解释，不要 Markdown 代码块：
[
  {"name": "人物名", "tier": "主角", "reason": "一句话理由"}
]

人物名单：${(names || []).join('、')}

原文节选：
${evidence}`;

    return [
        { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
        { role: 'user', content: user },
    ];
}

// ---------------------------------------------------------------- 剧情拆解（可玩化）

/**
 * 把原著拆成有序剧情节点 + 玩家状态 + 可追踪变量。
 * 这是「可游玩」的核心：节点决定剧情推进，变量决定状态可追踪。
 */
export function buildStageExtractionPrompt({
    novelTitle,
    playerName,
    evidence,
    targetNodes,
    instruction,
}) {
    const extra = instruction ? `\n额外要求：${instruction}\n` : '';
    const playerLine = playerName
        ? `玩家将扮演：${playerName}`
        : '玩家将扮演故事的主要视角人物（请你从原文判断并写明是谁）';

    const user = `下面是小说的原文素材。请把它改编成一份**可交互游玩的剧情脚本**。

${playerLine}${extra}
你的任务分三部分：

【一】把剧情拆成 ${targetNodes} 个左右**有序**的节点（stage）。
- 每个节点是一个「玩家需要应对的局面」，不是章节摘要
- 节点按原著时间顺序排列，节点间要有因果推进
- 每个节点的 situation 要写清：此刻发生了什么、玩家身处何地、面临什么选择或压力
- 每个节点的 objective 写清：这个节点里玩家大致要达成/解决什么（可以是"活下去""查明真相"这种）
- 只写原文确实发生过的内容，不要编造后续剧情

【二】给出**玩家角色的开局状态**。
- 玩家扮演谁、此时的身份与处境、已知什么、不知道什么
- 手里有什么关键物品、与哪些人是什么关系、当前的目标

【三】提取**需要在游玩过程中追踪的状态变量**。
- 比如好感度、伤势、持有物、已获得的情报、时间压力
- 每个变量给出名称、类型、初始值。类型只用这三种：
  number（数值，可增减）、text（文本状态）、bool（是/否）

只输出 JSON 对象，不要解释，不要 Markdown 代码块：
{
  "player": {
    "name": "玩家扮演的角色名",
    "identity": "身份与处境，一段话",
    "known": "开局时已知的信息",
    "unknown": "开局时还不知道、需要探索的信息",
    "items": ["开局持有的关键物品"],
    "relationships": "与其他角色的初始关系",
    "goal": "当前的主要目标"
  },
  "variables": [
    {"name": "变量名", "type": "number", "initial": 0, "desc": "这个变量代表什么"},
    {"name": "变量名", "type": "text", "initial": "初始状态", "desc": "说明"}
  ],
  "stages": [
    {
      "title": "节点标题（6-14 字）",
      "location": "发生地点",
      "chapterRef": "对应原著的章节或大致位置",
      "situation": "这个节点开始时正在发生什么，玩家看到/听到什么。200-400字，写成可演的场面，不要写成摘要",
      "objective": "玩家在这个节点里要应对什么",
      "keyCharacters": ["本节点出场的原著角色"],
      "stakes": "失败的后果是什么",
      "exitHint": "出现什么情况就算这个节点过去了"
    }
  ]
}

小说原文素材：
${evidence}`;

    return [
        { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
        { role: 'user', content: user },
    ];
}

/** 剧情节点的开场白：把玩家直接放进第一个节点 */
export function buildOpeningPrompt({ novelTitle, player, stage, style }) {
    const styleLine = style ? `\n文风要求：${style}` : '';
    const user = `你在为一部小说改编的互动剧情写开场。

原著：《${novelTitle || '未命名'}》
玩家扮演：${player?.name || '主角'}（${player?.identity || ''}）
首个节点：${stage?.title || '开场'}
地点：${stage?.location || ''}
正在发生：${stage?.situation || ''}
玩家的目标：${stage?.objective || ''}

请写一段 300-500 字的开场白，要求：
1. 用第二人称"你"称呼玩家，现在时叙述，让玩家立刻进入场面
2. 从节点的 situation 写起，写出环境、正在发生的事、在场的人
3. 结尾留一个明确的行动缺口（等人说话、等玩家决定、或一个突然的变化），不要替玩家做决定
4. 不要写"你可以选择A/B/C"这类列表，不要写任何元信息、不要写标题
5. 只输出开场白正文${styleLine}`;

    return [
        { role: 'system', content: '你是一位擅长互动叙事的中文小说作者。只输出正文，不加任何解释或标记。' },
        { role: 'user', content: user },
    ];
}

// ---------------------------------------------------------------- 解析

/**
 * 从模型回复里抠出 JSON。兼容代码块、前后废话、被截断的数组。
 * @param {string} text
 * @returns {any}
 */
export function parseModelJson(text) {
    let raw = String(text ?? '').trim();
    if (!raw) throw new Error('模型返回为空');

    // 去掉 ```json ... ``` 围栏
    const fence = raw.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
    if (fence) raw = fence[1].trim();

    const direct = tryParse(raw);
    if (direct !== undefined) return direct;

    // 截取第一个 { 或 [ 到最后一个配对的 } 或 ]
    const candidates = [];
    const firstBrace = raw.indexOf('{');
    const firstBracket = raw.indexOf('[');
    const starts = [firstBrace, firstBracket].filter(index => index >= 0).sort((a, b) => a - b);

    for (const start of starts) {
        const openChar = raw[start];
        const closeChar = openChar === '{' ? '}' : ']';
        const end = raw.lastIndexOf(closeChar);
        if (end > start) candidates.push(raw.slice(start, end + 1));
    }
    // 被截断的情况：直接截到结尾，交给修复逻辑
    if (starts.length) candidates.push(raw.slice(starts[0]));

    for (const candidate of candidates) {
        const parsed = tryParse(candidate);
        if (parsed !== undefined) return parsed;
        const repaired = tryParse(repairJson(candidate));
        if (repaired !== undefined) return repaired;
    }

    throw new Error(`无法从模型返回中解析 JSON（前 200 字：${raw.slice(0, 200)}）`);
}

function tryParse(text) {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

/** 对常见的模型 JSON 毛病做最小修复：尾随逗号、单引号、中文引号、未闭合括号 */
function repairJson(text) {
    let out = String(text);
    out = out.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'");
    out = out.replace(/,\s*([}\]])/g, '$1');

    // 补齐未闭合的字符串与括号（截断场景）
    let inString = false;
    let escaped = false;
    const stack = [];
    for (let i = 0; i < out.length; i++) {
        const char = out[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') inString = true;
        else if (char === '{' || char === '[') stack.push(char);
        else if (char === '}' || char === ']') stack.pop();
    }
    if (inString) out += '"';
    out = out.replace(/,\s*$/, '');
    while (stack.length) {
        out += stack.pop() === '{' ? '}' : ']';
    }
    return out;
}

/** 把解析结果强制变成数组 */
export function asArray(value, key = null) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') {
        if (key && Array.isArray(value[key])) return value[key];
        for (const candidate of ['characters', 'data', 'items', 'results', 'list', 'entries', 'world', 'worldbook']) {
            if (Array.isArray(value[candidate])) return value[candidate];
        }
        return [value];
    }
    return [];
}
