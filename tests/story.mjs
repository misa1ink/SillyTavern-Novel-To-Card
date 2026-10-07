/**
 * 剧情推进器的逻辑自测。
 *
 * story-engine.js 是纯逻辑模块（不依赖酒馆运行时），所以单独跑。
 * 需要沙箱环境的"注入与控制行回流"集成测试在 tests/harness.mjs 里。
 *
 * 运行：node tests/story.mjs
 */

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const story = await import(pathToFileURL(path.join(here, '..', 'src/story-engine.js')).href);

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ok   ${name}`);
    } catch (error) {
        failed++;
        console.log(`  FAIL ${name}\n       ${error.message}`);
    }
}

const playbook = {
    player: {
        name: '沈青梧',
        identity: '青云宗首席弟子',
        goal: '查明师父下落',
        items: ['半块玄铁令'],
        known: '宗门被血洗',
        unknown: '幕后主使是谁',
        relationships: '与苏晚是师姐弟',
    },
    variables: [
        { name: '好感度', type: 'number', initial: 0, desc: '与苏晚的关系' },
        { name: '伤势', type: 'text', initial: '轻伤', desc: '身体状况' },
        { name: '已获情报', type: 'bool', initial: false, desc: '是否知道真相' },
    ],
    stages: [
        { index: 0, title: '宗门残夜', location: '青云宗', situation: '火光里你醒来。', keyCharacters: ['苏晚'], objective: '找到苏晚', exitHint: '确认苏晚安危', stakes: '苏晚撑不过今夜' },
        { index: 1, title: '后山密道', location: '后山', situation: '你摸到石壁的裂缝。', keyCharacters: [], objective: '进密道', exitHint: '进入密道' },
        { index: 2, title: '天机阁来人', location: '天机阁', situation: '有人叩门。', keyCharacters: ['阁主'], objective: '接头', exitHint: '接头完成' },
    ],
    warnings: [],
};

console.log('\n[剧情] 节点推进与提示词组装');

test('初始状态停在第 0 段，变量取初始值', () => {
    const runtime = story.createRuntimeState(playbook);
    assert.equal(runtime.stageIndex, 0);
    assert.deepEqual(runtime.variables, { '好感度': 0, '伤势': '轻伤', '已获情报': false });
    assert.deepEqual(runtime.history, []);
});

test('提示词只含当前段，不剧透后续', () => {
    const runtime = story.createRuntimeState(playbook);
    const prompt = story.buildStoryPrompt({ playbook, runtime });
    assert.ok(prompt.includes('宗门残夜'), '缺少当前段标题');
    assert.ok(prompt.includes('火光里你醒来'), '缺少当前段情境');
    assert.ok(!prompt.includes('后山密道'), '把下一段剧透给模型了');
    assert.ok(!prompt.includes('天机阁来人'), '把更后面的段剧透给模型了');
    assert.ok(prompt.includes('沈青梧'), '缺少玩家身份');
    assert.ok(prompt.includes('好感度'), '缺少状态变量');
    assert.ok(prompt.includes('第 1 / 3 段'), '缺少进度标注');
});

test('推进到中段后，已演段落以摘要出现且不剧透未来', () => {
    let runtime = story.createRuntimeState(playbook);
    runtime = story.advanceStage(runtime, playbook, { toIndex: 1 });
    const prompt = story.buildStoryPrompt({ playbook, runtime });
    assert.ok(prompt.includes('后山密道'), '缺少当前段');
    assert.ok(prompt.includes('宗门残夜'), '缺少已演段落回执');
    assert.ok(!prompt.includes('天机阁来人'), '剧透了后续段');
    assert.ok(prompt.includes('不要重复、不要倒回'), '缺少防倒回约束');
});

test('推进与回退都被夹在有效范围内', () => {
    let runtime = story.createRuntimeState(playbook);
    runtime = story.advanceStage(runtime, playbook, { toIndex: 99 });
    assert.equal(runtime.stageIndex, 2, '越界推进没有被夹住');
    runtime = story.advanceStage(runtime, playbook, { toIndex: -5 });
    assert.equal(runtime.stageIndex, 0, '越界回退没有被夹住');
});

test('不带 toIndex 时自动前进一段', () => {
    let runtime = story.createRuntimeState(playbook);
    runtime = story.advanceStage(runtime, playbook);
    assert.equal(runtime.stageIndex, 1);
});

test('推进时把离开的段落记进历史', () => {
    let runtime = story.createRuntimeState(playbook);
    runtime = story.advanceStage(runtime, playbook, { toIndex: 2, note: '演完了' });
    assert.equal(runtime.history.length, 1);
    assert.equal(runtime.history[0].title, '宗门残夜');
    assert.equal(runtime.history[0].note, '演完了');
});

test('空剧本不会让提示词组装抛错', () => {
    assert.equal(story.buildStoryPrompt({ playbook: null, runtime: null }), '');
    assert.equal(story.buildStoryPrompt({ playbook: { stages: [] }, runtime: null }), '');
});

console.log('\n[剧情] 控制行解析');

test('识别 [推进] 与 [状态]，并从正文里剔除', () => {
    const text = '你睁开眼。\n\n苏晚站在门口。\n[状态] 好感度=+10；伤势=重伤\n[推进]';
    const parsed = story.parseControlLines(text);
    assert.equal(parsed.advance, true);
    assert.equal(parsed.changes.length, 2);
    assert.deepEqual(parsed.changes[0], { name: '好感度', value: '+10' });
    assert.ok(!parsed.cleaned.includes('[状态]'));
    assert.ok(!parsed.cleaned.includes('[推进]'));
    assert.ok(parsed.cleaned.includes('苏晚站在门口'), '正文被误删');
});

test('兼容英文标记与全角冒号', () => {
    const parsed = story.parseControlLines('正文\n[state] 好感度：5\n[advance]');
    assert.equal(parsed.advance, true);
    assert.deepEqual(parsed.changes[0], { name: '好感度', value: '5' });
});

test('没有控制行时正文原样返回', () => {
    const parsed = story.parseControlLines('普通回复，没有任何标记。');
    assert.equal(parsed.advance, false);
    assert.equal(parsed.changes.length, 0);
    assert.equal(parsed.cleaned, '普通回复，没有任何标记。');
});

test('控制行在正文中间也只在行首才生效', () => {
    const parsed = story.parseControlLines('他说了一句[推进]的话。');
    assert.equal(parsed.advance, false, '行内的 [推进] 不该被当成控制行');
    assert.ok(parsed.cleaned.includes('[推进]'));
});

test('空输入不抛错', () => {
    assert.deepEqual(story.parseControlLines(''), { advance: false, changes: [], cleaned: '' });
    assert.deepEqual(story.parseControlLines(null), { advance: false, changes: [], cleaned: '' });
});

console.log('\n[剧情] 变量变更');

test('数值变量支持增量与绝对值两种写法', () => {
    const runtime = story.createRuntimeState(playbook);
    const plus = story.applyVariableChanges(runtime, playbook, [{ name: '好感度', value: '+15' }]);
    assert.equal(plus.runtime.variables['好感度'], 15);
    const minus = story.applyVariableChanges(plus.runtime, playbook, [{ name: '好感度', value: '-5' }]);
    assert.equal(minus.runtime.variables['好感度'], 10);
    const absolute = story.applyVariableChanges(minus.runtime, playbook, [{ name: '好感度', value: '=88' }]);
    assert.equal(absolute.runtime.variables['好感度'], 88);
    const bare = story.applyVariableChanges(absolute.runtime, playbook, [{ name: '好感度', value: '7' }]);
    assert.equal(bare.runtime.variables['好感度'], 7);
});

test('文本与布尔变量按各自类型落值', () => {
    const runtime = story.createRuntimeState(playbook);
    const result = story.applyVariableChanges(runtime, playbook, [
        { name: '伤势', value: '重伤' },
        { name: '已获情报', value: '是' },
    ]);
    assert.equal(result.runtime.variables['伤势'], '重伤');
    assert.equal(result.runtime.variables['已获情报'], true);
});

test('剧本里没定义的变量被忽略并报告', () => {
    const runtime = story.createRuntimeState(playbook);
    const result = story.applyVariableChanges(runtime, playbook, [
        { name: '不存在的变量', value: 'x' },
        { name: '好感度', value: '+1' },
    ]);
    assert.deepEqual(result.skipped, ['不存在的变量']);
    assert.equal(result.applied.length, 1);
    assert.ok(!('不存在的变量' in result.runtime.variables), '非法变量被写进状态了');
});

test('数值变量给了非数值时跳过而不是写坏数据', () => {
    const runtime = story.createRuntimeState(playbook);
    const result = story.applyVariableChanges(runtime, playbook, [{ name: '好感度', value: '很多' }]);
    assert.equal(result.runtime.variables['好感度'], 0, '应该保持原值');
    assert.deepEqual(result.skipped, ['好感度']);
});

test('变量变更返回新对象，不改原运行时', () => {
    const runtime = story.createRuntimeState(playbook);
    story.applyVariableChanges(runtime, playbook, [{ name: '好感度', value: '=99' }]);
    assert.equal(runtime.variables['好感度'], 0, '原对象被改动了');
});

test('formatVariables 把变化渲染成可读行', () => {
    let runtime = story.createRuntimeState(playbook);
    runtime = story.applyVariableChanges(runtime, playbook, [{ name: '好感度', value: '=42' }]).runtime;
    const lines = story.formatVariables(playbook, runtime);
    assert.equal(lines.length, 3);
    assert.ok(lines.some(line => line.includes('好感度：42')));
    assert.ok(lines.some(line => line.includes('已获情报：否')));
});

console.log('\n[剧情] 模型输出整理');

test('收拾残缺的模型输出', () => {
    const normalized = story.normalizePlaybook({
        player: { name: '甲', items: '剑, 令牌' },
        variables: [
            { name: 'a', type: 'number', initial: 'x' },
            { nope: 1 },
            { name: 'b', type: '未知类型', initial: 1 },
        ],
        stages: [
            { title: '一', situation: '内容' },
            { title: '二' },
            { situation: '只有内容没有标题' },
        ],
    });
    assert.equal(normalized.player.items.length, 2, 'items 字符串没有被切开');
    assert.equal(normalized.variables.length, 2, '无效变量没有被剔除');
    assert.equal(normalized.variables[0].initial, 0, '数值型非法初值没有被归零');
    assert.equal(normalized.variables[1].type, 'text', '未知类型没有被降级为 text');
    assert.equal(normalized.stages.length, 2, '缺 situation 的节点没有被剔除');
    assert.deepEqual(normalized.stages.map(stage => stage.index), [0, 1], '节点下标没有重排');
});

test('完全没有节点时给出明确提示', () => {
    const normalized = story.normalizePlaybook({ player: {}, variables: [], stages: [] });
    assert.equal(normalized.stages.length, 0);
    assert.ok(normalized.warnings.some(warning => warning.includes('没有给出任何剧情节点')));
});

test('只有一个节点时提示体验单薄', () => {
    const normalized = story.normalizePlaybook({ stages: [{ title: '一', situation: '内容' }] });
    assert.ok(normalized.warnings.some(warning => warning.includes('单薄')));
});

test('输入不是对象时也不崩', () => {
    for (const input of [null, undefined, 'x', 42, []]) {
        const normalized = story.normalizePlaybook(input);
        assert.equal(normalized.stages.length, 0);
        assert.ok(Array.isArray(normalized.warnings));
        assert.equal(normalized.player.name, '主角', '应给出兜底玩家名');
    }
});

console.log('\n[剧情] 世界书导出与进度摘要');

test('每段一条条目 + 一条常驻玩家设定', () => {
    const book = story.buildStoryWorldInfo({
        playbook,
        novelTitle: '试炼',
        buildWorldInfoData: (entries, meta) => ({ entries, meta }),
    });
    assert.equal(book.entries.length, playbook.stages.length + 1);
    const constantEntries = book.entries.filter(entry => entry.constant);
    assert.equal(constantEntries.length, 1, '常驻条目应只有玩家设定');
    assert.ok(constantEntries[0].keys.includes('沈青梧'), '玩家设定缺少触发词');
    const storyEntries = book.entries.filter(entry => entry.category === '剧情节点');
    assert.equal(storyEntries.length, playbook.stages.length);
    assert.ok(storyEntries[0].keys.includes('青云宗'), '节点没有用地点做触发词');
    assert.ok(storyEntries[0].keys.includes('苏晚'), '节点没有用出场角色做触发词');
});

test('进度摘要计算正确', () => {
    let runtime = story.createRuntimeState(playbook);
    let summary = story.summarizeProgress(playbook, runtime);
    assert.deepEqual(
        { current: summary.current, total: summary.total, percent: summary.percent },
        { current: 1, total: 3, percent: 33 },
    );
    runtime = story.advanceStage(runtime, playbook, { toIndex: 2 });
    summary = story.summarizeProgress(playbook, runtime);
    assert.equal(summary.current, 3);
    assert.equal(summary.title, '天机阁来人');
    assert.equal(summary.percent, 100);
});

test('currentStage 在越界时返回边界节点而不是 undefined', () => {
    assert.equal(story.currentStage(playbook, { stageIndex: 99 }).title, '天机阁来人');
    assert.equal(story.currentStage(playbook, { stageIndex: -3 }).title, '宗门残夜');
    assert.equal(story.currentStage({ stages: [] }, { stageIndex: 0 }), null);
});

console.log('\n[剧情] 卡内嵌剧本的存取');

test('剧本打包成 payload 再读回来，内容不丢', () => {
    const payload = story.buildScriptPayload(playbook, { novelTitle: '试炼之书', opening: '火光里你醒来。' });
    const card = { spec: 'chara_card_v3', spec_version: '3.0', data: { name: '沈青梧', extensions: { [story.CARD_SCRIPT_KEY]: payload } } };

    const read = story.readScriptPayload(card);
    assert.ok(read, '读不回 payload');
    assert.equal(read.novelTitle, '试炼之书');
    assert.equal(read.opening, '火光里你醒来。');
    assert.equal(read.playbook.stages.length, playbook.stages.length);
    assert.equal(read.playbook.stages[0].title, '宗门残夜');
    assert.deepEqual(read.playbook.variables, playbook.variables, '变量定义丢失');
    assert.equal(read.playbook.player.name, '沈青梧', '玩家身份丢失');
});

test('兼容 extensions 放在顶层的卡', () => {
    const payload = story.buildScriptPayload(playbook, { novelTitle: 'x' });
    const read = story.readScriptPayload({ name: '甲', extensions: { [story.CARD_SCRIPT_KEY]: payload } });
    assert.ok(read, '顶层 extensions 没被识别');
    assert.equal(read.playbook.stages.length, playbook.stages.length);
});

test('普通角色卡（没有内嵌剧本）返回 null 而不是抛错', () => {
    assert.equal(story.readScriptPayload({ spec: 'chara_card_v2', data: { name: '甲', extensions: {} } }), null);
    assert.equal(story.readScriptPayload({ data: { name: '甲' } }), null);
    assert.equal(story.readScriptPayload(null), null);
    assert.equal(story.readScriptPayload('x'), null);
});

test('内嵌数据残缺时也返回 null（不会拿半份剧本去跑）', () => {
    const bad = { data: { extensions: { [story.CARD_SCRIPT_KEY]: { version: 1, playbook: { stages: [] } } } } };
    assert.equal(story.readScriptPayload(bad), null, '空 stages 应被拒绝');
    const noPlaybook = { data: { extensions: { [story.CARD_SCRIPT_KEY]: { version: 1 } } } };
    assert.equal(story.readScriptPayload(noPlaybook), null);
});

test('payload 经过 JSON 往返（模拟写入 PNG）后仍可读回', () => {
    const payload = story.buildScriptPayload(playbook, { novelTitle: '试炼', opening: '开场' });
    const card = { data: { extensions: { [story.CARD_SCRIPT_KEY]: payload } } };
    const roundTrip = JSON.parse(JSON.stringify(card));
    const read = story.readScriptPayload(roundTrip);
    assert.ok(read);
    assert.equal(read.playbook.stages[1].situation, playbook.stages[1].situation);
});

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
