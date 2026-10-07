/**
 * 剧情推进引擎：把原著拆出来的有序节点变成「演到哪、注入到哪」的运行时。
 *
 * 设计要点：
 * 1. 不把整本书的剧情一次灌给模型——那样等于剧透，模型还会乱跳阶段。
 *    每回合只注入「当前节点 + 玩家状态 + 变量」，历史节点只留一句"已发生什么"。
 * 2. 注入走酒馆的 CHAT_COMPLETION_PROMPT_READY 事件（或 setExtensionPrompt 兜底），
 *    不改动角色卡本体，退出扩展也不会污染卡。
 * 3. 变量以「可追踪表」的形式出现在提示词里，让模型在回复里用固定语法报告变更，
 *    我们解析后累加，形成持久状态。
 */

/** 变量类型白名单 */
const VAR_TYPES = new Set(['number', 'text', 'bool']);

/** 把模型给的单个变量归一化；无法识别的返回 null */
function normalizeVariable(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = String(raw.name ?? raw.key ?? '').trim();
    if (!name) return null;
    const type = VAR_TYPES.has(String(raw.type)) ? String(raw.type) : 'text';
    let initial = raw.initial ?? raw.value ?? '';
    if (type === 'number') {
        const value = Number(initial);
        initial = Number.isFinite(value) ? value : 0;
    } else if (type === 'bool') {
        initial = initial === true || initial === 'true' || initial === 1 || initial === '1';
    } else {
        initial = String(initial ?? '');
    }
    return { name, type, initial, desc: String(raw.desc ?? raw.description ?? '').trim() };
}

/** 把模型给的单个节点归一化 */
function normalizeStage(raw, index) {
    if (!raw || typeof raw !== 'object') return null;
    const title = String(raw.title ?? raw.name ?? '').trim() || `节点 ${index + 1}`;
    const situation = String(raw.situation ?? raw.scene ?? raw.content ?? '').trim();
    if (!situation) return null;
    return {
        index,
        title,
        location: String(raw.location ?? '').trim(),
        chapterRef: String(raw.chapterRef ?? raw.chapter ?? '').trim(),
        situation,
        objective: String(raw.objective ?? raw.goal ?? '').trim(),
        keyCharacters: Array.isArray(raw.keyCharacters)
            ? raw.keyCharacters.map(name => String(name ?? '').trim()).filter(Boolean)
            : [],
        stakes: String(raw.stakes ?? '').trim(),
        exitHint: String(raw.exitHint ?? '').trim(),
    };
}

/**
 * 把模型输出整理成可用的剧本。
 * @param {object} raw parseModelJson 的结果
 * @returns {{player: object, variables: object[], stages: object[], warnings: string[]}}
 */
export function normalizePlaybook(raw) {
    const warnings = [];
    const source = raw && typeof raw === 'object' ? raw : {};

    const playerRaw = source.player && typeof source.player === 'object' ? source.player : {};
    const player = {
        name: String(playerRaw.name ?? '').trim() || '主角',
        identity: String(playerRaw.identity ?? '').trim(),
        known: String(playerRaw.known ?? '').trim(),
        unknown: String(playerRaw.unknown ?? '').trim(),
        items: Array.isArray(playerRaw.items)
            ? playerRaw.items.map(item => String(item ?? '').trim()).filter(Boolean)
            : String(playerRaw.items ?? '').split(/[,，、]/).map(item => item.trim()).filter(Boolean),
        relationships: String(playerRaw.relationships ?? '').trim(),
        goal: String(playerRaw.goal ?? '').trim(),
    };

    const variables = (Array.isArray(source.variables) ? source.variables : [])
        .map(normalizeVariable)
        .filter(Boolean);

    const stages = (Array.isArray(source.stages) ? source.stages : [])
        .map((stage, index) => normalizeStage(stage, index))
        .filter(Boolean)
        .map((stage, index) => ({ ...stage, index }));

    if (!stages.length) warnings.push('模型没有给出任何剧情节点，无法生成可游玩剧本');
    if (stages.length === 1) warnings.push('只切出一个剧情节点，游玩体验会比较单薄');
    if (stages.length > 40) warnings.push(`切出 ${stages.length} 个节点，可能过碎，建议调小分卷或调少节点数`);
    if (!variables.length) warnings.push('没有提取到可追踪变量，剧情将只靠节点推进');

    return { player, variables, stages, warnings };
}

/**
 * 运行时状态：当前停在第几个节点 + 变量当前值。
 */
export function createRuntimeState(playbook) {
    const variables = {};
    for (const variable of playbook.variables || []) {
        variables[variable.name] = variable.initial;
    }
    return {
        stageIndex: 0,
        variables,
        history: [],
        startedAt: Date.now(),
    };
}

/** 节点推进：返回新的运行时状态（不改原对象） */
export function advanceStage(runtime, playbook, { toIndex, note } = {}) {
    const maxIndex = Math.max(0, (playbook.stages || []).length - 1);
    const current = runtime?.stageIndex ?? 0;
    const target = Number.isFinite(toIndex)
        ? Math.max(0, Math.min(Math.floor(toIndex), maxIndex))
        : Math.min(current + 1, maxIndex);

    const history = Array.isArray(runtime?.history) ? [...runtime.history] : [];
    const from = (playbook.stages || [])[current];
    if (from && target !== current) {
        history.push({ title: from.title, note: String(note ?? '').trim(), at: Date.now() });
    }

    return {
        ...runtime,
        stageIndex: target,
        history,
    };
}

export function currentStage(playbook, runtime) {
    const stages = playbook?.stages || [];
    const index = Math.max(0, Math.min(runtime?.stageIndex ?? 0, stages.length - 1));
    return stages[index] || null;
}

export function totalStages(playbook) {
    return (playbook?.stages || []).length;
}

/** 把变量现值渲染成一行，便于插入提示词与界面显示 */
export function formatVariables(playbook, runtime) {
    const lines = [];
    for (const variable of playbook?.variables || []) {
        const value = runtime?.variables?.[variable.name];
        if (value === undefined) continue;
        const shown = typeof value === 'boolean' ? (value ? '是' : '否') : String(value);
        const desc = variable.desc ? `（${variable.desc}）` : '';
        lines.push(`- ${variable.name}：${shown}${desc}`);
    }
    return lines;
}

/**
 * 组装本回合要注入的剧情提示词。
 *
 * 只含当前节点与状态；已发生的节点只保留标题，避免把后续剧情剧透给模型。
 *
 * @param {{playbook: object, runtime: object, includeFuture?: boolean}} options
 * @returns {string}
 */
export function buildStoryPrompt({ playbook, runtime, autoReport = true, includeFuture = false }) {
    if (!playbook?.stages?.length) return '';

    const stage = currentStage(playbook, runtime);
    if (!stage) return '';

    const total = playbook.stages.length;
    const player = playbook.player || {};
    const parts = [];

    parts.push('【互动剧情运行中】');
    parts.push(`你是这个世界的叙事者。玩家扮演的是「${player.name}」，不是旁观者。`);
    if (player.identity) parts.push(`玩家身份：${player.identity}`);
    if (player.goal) parts.push(`玩家当下的目标：${player.goal}`);
    if (player.known) parts.push(`玩家已知：${player.known}`);
    if (player.unknown) parts.push(`玩家尚不知道（不要直接说破，让他自己发现）：${player.unknown}`);
    if (player.items?.length) parts.push(`玩家持有：${player.items.join('、')}`);
    if (player.relationships) parts.push(`人物关系：${player.relationships}`);

    parts.push('');
    parts.push(`【当前剧情节点：第 ${stage.index + 1} / ${total} 段 · ${stage.title}】`);
    if (stage.location) parts.push(`地点：${stage.location}`);
    if (stage.chapterRef) parts.push(`对应原著：${stage.chapterRef}`);
    parts.push(`正在发生：${stage.situation}`);
    if (stage.objective) parts.push(`本段要应对：${stage.objective}`);
    if (stage.keyCharacters?.length) parts.push(`本段出场：${stage.keyCharacters.join('、')}`);
    if (stage.stakes) parts.push(`失败的后果：${stage.stakes}`);

    const variableLines = formatVariables(playbook, runtime);
    if (variableLines.length) {
        parts.push('');
        parts.push('【当前状态】');
        parts.push(...variableLines);
    }

    const past = (playbook.stages || []).slice(0, stage.index);
    if (past.length) {
        parts.push('');
        parts.push(`【已经演过的段落（不要重复、不要倒回）】${past.map(item => item.title).join(' → ')}`);
    }

    if (includeFuture && stage.index + 1 < total) {
        parts.push('');
        parts.push(`【后续会走向（仅供你把握节奏，不要提前演出）】${playbook.stages[stage.index + 1].title}`);
    }

    parts.push('');
    parts.push('【叙事要求】');
    parts.push('1. 让剧情按当前节点推进，不要把后面的剧情提前演出来。');
    parts.push(`2. 到「${stage.exitHint || '这个节点的事情有了结果'}」时，自然收束本段，并在回复最后另起一行输出：[推进]`);
    parts.push('3. 只描写玩家之外的人物与环境，把决定权留给玩家，不要替玩家说话或行动。');
    parts.push('4. 保持在原著的设定与人物性格内，不要引入原著没有的设定。');
    if (autoReport && variableLines.length) {
        parts.push('5. 如果有状态发生变化，在回复最后另起一行输出：[状态] 变量名=新值（多个用分号隔开，只写变化的那些）。没有变化就不输出这一行。');
    }

    return parts.join('\n');
}

/**
 * 解析模型回复尾部的控制行：[推进] 与 [状态] 行。
 * 解析后应从展示内容里剔除，避免这些标记出现在聊天里。
 *
 * @returns {{advance: boolean, changes: object[], cleaned: string}}
 */
export function parseControlLines(text) {
    const raw = String(text ?? '');
    if (!raw) return { advance: false, changes: [], cleaned: raw };

    let advance = false;
    const changes = [];
    const keptLines = [];

    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();

        const advanceMatch = /^\[(?:推进|advance)\]\s*$/i.exec(trimmed);
        if (advanceMatch) {
            advance = true;
            continue;
        }

        const stateMatch = /^\[(?:状态|state)\]\s*(.+)$/i.exec(trimmed);
        if (stateMatch) {
            for (const pair of stateMatch[1].split(/[;；]/)) {
                const item = pair.trim();
                if (!item) continue;
                const assignment = /^(.+?)\s*[=:：]\s*(.*)$/.exec(item);
                if (!assignment) continue;
                changes.push({ name: assignment[1].trim(), value: assignment[2].trim() });
            }
            continue;
        }

        keptLines.push(line);
    }

    return { advance, changes, cleaned: keptLines.join('\n').trim() };
}

/**
 * 把解析出的变更应用到运行时变量上。
 * 数值型做加减（支持 +10 / -5 / =10 三种写法），文本与布尔直接覆盖。
 *
 * @returns {{runtime: object, applied: object[], skipped: string[]}}
 */
export function applyVariableChanges(runtime, playbook, changes) {
    const next = { ...runtime, variables: { ...(runtime?.variables || {}) } };
    const applied = [];
    const skipped = [];
    const known = new Set((playbook?.variables || []).map(variable => variable.name));

    for (const change of changes || []) {
        const name = String(change?.name ?? '').trim();
        if (!name || !known.has(name)) {
            if (name) skipped.push(name);
            continue;
        }
        const definition = (playbook.variables || []).find(variable => variable.name === name);
        const rawValue = String(change.value ?? '').trim();
        const before = next.variables[name];

        if (definition.type === 'number') {
            const delta = /^[+-]\d+(?:\.\d+)?$/.exec(rawValue);
            const absolute = /^=?\s*(-?\d+(?:\.\d+)?)$/.exec(rawValue);
            if (delta) {
                next.variables[name] = Number(before || 0) + Number(rawValue);
            } else if (absolute) {
                next.variables[name] = Number(absolute[1]);
            } else {
                skipped.push(name);
                continue;
            }
        } else if (definition.type === 'bool') {
            next.variables[name] = /^(是|true|1|yes|有)$/i.test(rawValue);
        } else {
            next.variables[name] = rawValue;
        }

        applied.push({ name, before, after: next.variables[name] });
    }

    return { runtime: next, applied, skipped };
}

/**
 * 把剧本落成可导入酒馆的世界书数据。
 * 每个节点一条（按章节/地点关键词触发），另加一条常驻的"玩家设定"。
 *
 * @param {{playbook: object, novelTitle?: string, buildWorldInfoData: Function}} options
 */
export function buildStoryWorldInfo({ playbook, novelTitle, buildWorldInfoData }) {
    const stages = playbook?.stages || [];
    const entries = [];

    for (const stage of stages) {
        const keys = [
            stage.location,
            ...(stage.keyCharacters || []),
            stage.title,
        ].map(text => String(text ?? '').trim()).filter(text => text.length >= 2);

        entries.push({
            comment: `第 ${stage.index + 1} 段 · ${stage.title}`,
            keys: [...new Set(keys)].slice(0, 8),
            content: [
                stage.location ? `地点：${stage.location}` : '',
                stage.situation,
                stage.objective ? `本段要应对：${stage.objective}` : '',
                stage.stakes ? `失败的后果：${stage.stakes}` : '',
            ].filter(Boolean).join('\n'),
            category: '剧情节点',
            constant: false,
        });
    }

    const player = playbook?.player || {};
    entries.push({
        comment: `玩家角色 · ${player.name || '主角'}`,
        keys: [player.name || '主角'].filter(Boolean),
        content: [
            `玩家扮演：${player.name || '主角'}`,
            player.identity ? `身份：${player.identity}` : '',
            player.goal ? `目标：${player.goal}` : '',
            player.relationships ? `关系：${player.relationships}` : '',
            player.items?.length ? `持有：${player.items.join('、')}` : '',
        ].filter(Boolean).join('\n'),
        category: '玩家设定',
        constant: true,
    });

    return buildWorldInfoData(entries, {
        name: `${novelTitle || '小说'}·剧情脚本`,
        description: `由《${novelTitle || '未命名'}》拆出的互动剧情，共 ${stages.length} 段`,
    });
}

/** 给界面用的进度摘要 */
export function summarizeProgress(playbook, runtime) {
    const total = totalStages(playbook);
    const stage = currentStage(playbook, runtime);
    return {
        current: (runtime?.stageIndex ?? 0) + 1,
        total,
        title: stage?.title || '',
        location: stage?.location || '',
        percent: total ? Math.round((((runtime?.stageIndex ?? 0) + 1) / total) * 100) : 0,
    };
}
