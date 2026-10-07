/**
 * 本地自测：PNG 区块读写 + 卡结构 + 模型输出解析。
 * 运行：node tests/run.mjs   （在工作区根目录）
 *
 * 这些模块不依赖酒馆运行时，所以能直接在 Node 里跑。
 */

import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

import { makeSampleCard, makePlainCard } from './fixture.mjs';

// --- 浏览器 API 垫片（png-card.js 用到） ---
globalThis.btoa ??= (binary) => Buffer.from(binary, 'binary').toString('base64');
globalThis.atob ??= (base64) => Buffer.from(base64, 'base64').toString('binary');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const load = relative => import(pathToFileURL(path.join(root, relative)).href);

const png = await load('src/png-card.js');
const cards = await load('src/card-builder.js');
const world = await load('src/world-builder.js');
const prompts = await load('src/prompts.js');

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

async function testAsync(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ok   ${name}`);
    } catch (error) {
        failed++;
        console.log(`  FAIL ${name}\n       ${error.message}`);
    }
}

/** 自带一份最小 PNG 区块解析器，用来独立校验被测代码的输出（不共用被测实现） */
function walkPng(bytes) {
    const out = [];
    let offset = 8;
    while (offset + 8 <= bytes.length) {
        const length = (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
        const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
        let stored = 0;
        for (let i = 0; i < 4; i++) stored = (stored * 256) + bytes[offset + 8 + length + i];
        out.push({ type, start: offset, dataStart: offset + 8, dataLength: length, stored, totalLength: 12 + length });
        offset += 12 + length;
        if (type === 'IEND') break;
    }
    return out;
}

/**
 * 严查 PNG 结构：签名、IHDR 开头、IEND 结尾、区块长度自洽、CRC 正确、末尾无残留字节。
 */
function validatePngStructure(bytes, label) {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (let i = 0; i < 8; i++) {
        assert.equal(bytes[i], signature[i], `${label}: PNG 签名第 ${i} 字节不对`);
    }

    const chunks = walkPng(bytes);
    assert.ok(chunks.length >= 3, `${label}: 区块数量过少 (${chunks.length})`);
    assert.equal(chunks[0].type, 'IHDR', `${label}: 第一个区块必须是 IHDR`);
    assert.equal(chunks[chunks.length - 1].type, 'IEND', `${label}: 最后一个区块必须是 IEND`);

    let cursor = 8;
    for (const chunk of chunks) {
        assert.equal(chunk.start, cursor, `${label}: 区块 ${chunk.type} 起点不连续`);
        const typeAndData = bytes.subarray(chunk.start + 4, chunk.dataStart + chunk.dataLength);
        assert.equal(chunk.stored, png.crc32(typeAndData), `${label}: 区块 ${chunk.type} 的 CRC 不匹配`);
        cursor += chunk.totalLength;
    }
    assert.equal(cursor, bytes.length, `${label}: IEND 之后有多余字节或长度不符`);
    return chunks;
}

function chunkKeywords(bytes) {
    return walkPng(bytes)
        .filter(chunk => chunk.type === 'tEXt')
        .map(chunk => {
            const data = bytes.subarray(chunk.dataStart, chunk.dataStart + chunk.dataLength);
            const zero = data.indexOf(0);
            return String.fromCharCode.apply(null, data.subarray(0, zero));
        });
}

/** 手工拼一张不带任何卡数据的普通 PNG（1x1 灰度图） */
const plainPng = makePlainCard();

console.log('\n[1] PNG 角色卡写入 / 读取');

const basePng = makeSampleCard();
const baseChunks = validatePngStructure(basePng, '源图');
console.log(`       源图（合成夹具）：${basePng.length} 字节，区块 ${baseChunks.map(c => c.type).join(' → ')}`);
console.log(`       源图自带关键字：${chunkKeywords(basePng).join('、') || '无'}`);

test('源图本身就带 chara/ccv3 区块（读取能力得到外部数据验证）', () => {
    const parsed = png.readCardFromPng(basePng);
    assert.ok(parsed, '没能读出源图里已有的角色卡');
    assert.equal(parsed.spec, 'chara_card_v3');
    assert.equal(parsed.data.name, 'Fixture');
    assert.ok(parsed.data.description.length > 10);
});

const cardV2 = cards.buildCardV2(
    {
        name: '沈青梧',
        aliases: ['青梧', '沈师姐'],
        role: '青云宗首席弟子',
        summary: '剑道天才，表面冷淡实则护短。',
        appearance: '素白道袍，左腕缠着褪色的红绳。',
        personality: '外冷内热，嘴硬心软。',
        personality_tags: ['冷淡', '护短'],
        speech_style: '用词简省，习惯称对方"你"。',
        background: '幼年失怙，被掌门收养。',
        first_mes: '"剑不是用来杀人的。"她收剑入鞘。',
        example_dialogue: ['沈青梧：你挡路了。', '我：抱歉……', '沈青梧：站着别动。'],
    },
    { creator: '自测', version: '1.0', source: '自测小说', tags: ['小说提取', '主角'] },
);

const cardV3 = cards.buildCardV3(
    {
        name: '沈青梧',
        aliases: ['青梧'],
        role: '青云宗首席弟子',
        summary: '剑道天才。',
        first_mes: '"剑不是用来杀人的。"',
        example_dialogue: ['沈青梧：你挡路了。', '我：抱歉……'],
    },
    { creator: '自测', source: '自测小说' },
);

const payload = {
    chara: png.utf8ToBase64(JSON.stringify(cardV2)),
    ccv3: png.utf8ToBase64(JSON.stringify(cardV3)),
};

const embedded = png.embedCardIntoPng(basePng, payload);

test('嵌入后仍是结构合法的 PNG（长度/CRC/IEND 全部自洽）', () => {
    validatePngStructure(embedded, '嵌入后');
});

test('像素数据未被重新编码（IDAT 字节完全相同）', () => {
    const pick = bytes => png.readChunks(bytes)
        .filter(chunk => chunk.type === 'IDAT')
        .map(chunk => bytes.subarray(chunk.dataStart, chunk.dataStart + chunk.dataLength));
    const before = pick(basePng);
    const after = pick(embedded);
    assert.equal(after.length, before.length, 'IDAT 区块数量变了');
    before.forEach((data, index) => {
        assert.deepEqual(Array.from(after[index]), Array.from(data), `第 ${index} 个 IDAT 内容变了`);
    });
});

test('新增了 chara 与 ccv3 两个 tEXt 区块', () => {
    const keywords = chunkKeywords(embedded);
    assert.deepEqual(keywords.sort(), ['ccv3', 'chara']);
});

test('tEXt 区块紧跟在 IHDR 之后（规范要求）', () => {
    const types = walkPng(embedded).map(chunk => chunk.type);
    assert.equal(types[0], 'IHDR');
    assert.deepEqual(types.slice(1, 3), ['tEXt', 'tEXt'], '卡数据区块必须紧跟 IHDR');
    assert.deepEqual(chunkKeywords(embedded).sort(), ['ccv3', 'chara']);
});

test('读回的 V3 卡与写入的完全一致（含中文与引号）', () => {
    const read = png.readCardFromPng(embedded);
    assert.ok(read, '读不到卡数据');
    assert.equal(read.spec, 'chara_card_v3');
    assert.equal(read.data.name, '沈青梧');
    assert.equal(read.data.first_mes, '"剑不是用来杀人的。"');
    assert.equal(read.data.description, cardV3.data.description);
    assert.deepEqual(read.data.alternate_greetings, cardV3.data.alternate_greetings);
});

test('重复嵌入不会堆叠重复关键字', () => {
    const twice = png.embedCardIntoPng(embedded, payload);
    const keywords = chunkKeywords(twice);
    assert.equal(keywords.filter(k => k === 'chara').length, 1);
    assert.equal(keywords.filter(k => k === 'ccv3').length, 1);
    validatePngStructure(twice, '二次嵌入');
});

test('hasEmbeddedCard 能区分普通图和角色卡', () => {
    assert.equal(png.hasEmbeddedCard(basePng), true, '源图本身就是角色卡');
    assert.equal(png.hasEmbeddedCard(embedded), true);
    assert.equal(png.hasEmbeddedCard(plainPng), false, '普通 PNG 不应被当成角色卡');
    assert.equal(png.readCardFromPng(plainPng), null);
});

test('非 PNG 输入会明确报错而不是产出坏文件', () => {
    assert.throws(() => png.embedCardIntoPng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), payload), /不是合法的 PNG/);
});

test('base64 中文往返无损（含 emoji 与生僻字）', () => {
    const text = '沈青梧：「剑，不是用来杀人的。」𠮷 ㍿ 🗡️';
    assert.equal(png.base64ToUtf8(png.utf8ToBase64(text)), text);
});

test('base64 往返能处理远超单次 fromCharCode 长度的大文本', () => {
    const text = '剑'.repeat(200_000);
    const encoded = png.utf8ToBase64(text);
    assert.equal(png.base64ToUtf8(encoded), text);
});

console.log('\n[2] 角色卡字段组装');

test('V2 卡结构符合规范', () => {
    assert.equal(cardV2.spec, 'chara_card_v2');
    assert.equal(cardV2.spec_version, '2.0');
    assert.equal(cardV2.data.name, '沈青梧');
    assert.equal(typeof cardV2.data.character_version, 'string');
    assert.ok(Array.isArray(cardV2.data.tags));
    assert.ok(Array.isArray(cardV2.data.alternate_greetings));
});

test('V3 卡结构符合规范且是 V2 的超集', () => {
    assert.equal(cardV3.spec, 'chara_card_v3');
    assert.equal(cardV3.spec_version, '3.0');
    assert.ok(cardV3.data.creation_date > 0);
    assert.ok(Array.isArray(cardV3.data.assets));
    assert.ok(Array.isArray(cardV3.data.group_only_greetings));
    assert.equal(cardV3.data.name, cardV2.data.name);
});

test('描述里带小标题且顺序稳定', () => {
    const description = cardV2.data.description;
    assert.ok(description.includes('身份：青云宗首席弟子'));
    assert.ok(description.includes('外貌：'));
    assert.ok(description.indexOf('身份：') < description.indexOf('外貌：'));
    assert.ok(description.indexOf('外貌：') < description.indexOf('背景：'));
});

test('空字段不会留下空标题', () => {
    assert.equal(/其他：\s*$/m.test(cardV2.data.description), false);
    assert.equal(cardV2.data.description.includes('undefined'), false);
    assert.equal(cardV2.data.description.includes('null'), false);
});

test('mes_example 用 <START> 分隔且区分说话人', () => {
    const example = cardV2.data.mes_example;
    assert.ok(example.startsWith('<START>'));
    assert.equal(example.includes('{{char}}'), true);
    assert.equal(example.includes('{{user}}'), true);
});

test('数组/对象型字段被压成可读文本', () => {
    const data = cards.buildCardData({
        name: '测试',
        abilities: ['御剑', '读心'],
        relationships: { 师父: '掌门玄机', 师妹: '苏晚' },
    });
    assert.ok(data.description.includes('御剑'));
    assert.ok(data.description.includes('师父：掌门玄机'));
});

test('名字里的书名号保留，非法文件名字符被清理', () => {
    assert.equal(cards.safeFileName('《道渊》v5.4.2'), '《道渊》v5.4.2');
    assert.equal(cards.safeFileName('A/B:C*D?E"F<G>H|I'), 'ABCDEFGHI');
    assert.equal(cards.safeFileName('   '), 'character');
    assert.equal(cards.safeFileName('...隐藏'), '隐藏');
    assert.equal(cards.normalizeName('「沈青梧」'), '沈青梧');
});

test('summarizeCard 的统计与实际内容一致', () => {
    const summary = cards.summarizeCard(cardV3);
    assert.equal(summary.name, '沈青梧');
    assert.equal(summary.total, summary.description + summary.personality + summary.scenario + summary.first_mes + summary.mes_example);
});

console.log('\n[3] 世界书构建');

const rawEntries = [
    { comment: '青云宗', keys: ['青云宗', '宗门', '青云'], content: '东域第一剑宗。', category: '势力', constant: true },
    { comment: '寒潭', keys: ['寒潭'], content: '后山禁地。', category: '地点' },
    { comment: '重复条目', keys: ['青云宗'], content: '东域第一剑宗。', category: '势力' },
    { comment: '空内容', keys: ['空'], content: '   ' },
    { comment: '泛称关键词', keys: ['他', '那个地方', '寒潭禁地'], content: '后山禁地深处。', category: '地点' },
];

const entries = world.normalizeEntries(rawEntries);

test('去重：完全相同的内容只保留一条', () => {
    assert.equal(entries.filter(e => e.comment === '青云宗').length, 1);
});

test('丢弃空内容条目', () => {
    assert.equal(entries.some(e => e.comment === '空内容'), false);
});

test('过滤掉"他""那个地方"这类无法触发的泛称关键词', () => {
    const entry = entries.find(e => e.comment === '泛称关键词');
    assert.deepEqual(entry.keys, ['寒潭禁地']);
});

test('过滤不会误伤含通用词的专有名词', () => {
    const kept = world.normalizeEntries([
        { comment: '地点', keys: ['那个地方', '寒潭禁地', '对方阵营', '他自己的剑'], content: '内容' },
    ]);
    assert.deepEqual(kept[0].keys, ['寒潭禁地', '对方阵营', '他自己的剑']);
});

test('嵌套数组形式的关键词被正确摊平', () => {
    const entry = world.normalizeEntries([{ comment: '嵌套', keys: [['寒潭', '寒潭禁地'], ['沈青梧']], content: '内容' }]);
    assert.deepEqual(entry[0].keys, ['寒潭', '寒潭禁地', '沈青梧']);
});

test('字符串形式的关键词按中英文标点切分', () => {
    const entry = world.normalizeEntries([{ comment: '字符串', keys: '青云宗，剑冢、玄铁剑;御剑术|掌门', content: '内容' }]);
    assert.deepEqual(entry[0].keys, ['青云宗', '剑冢', '玄铁剑', '御剑术', '掌门']);
});

test('没有关键词的条目回落到用条目名触发', () => {
    const fallback = world.normalizeEntries([{ comment: '只有名字', content: '内容' }]);
    assert.deepEqual(fallback[0].keys, ['只有名字']);
});

const worldData = world.buildWorldInfoData(entries, { name: '自测世界书' });

test('世界书 entry 结构完整，关键字段类型正确', () => {
    const list = Object.values(worldData.entries);
    assert.equal(list.length, entries.length);
    for (const entry of list) {
        assert.ok(Number.isInteger(entry.uid));
        assert.ok(Array.isArray(entry.key));
        assert.equal(typeof entry.content, 'string');
        assert.equal(typeof entry.constant, 'boolean');
        assert.equal(typeof entry.order, 'number');
        assert.equal(typeof entry.position, 'number');
        assert.equal(entry.disable, false);
    }
});

test('constant 条目被放到角色定义之前（position 0）', () => {
    const constant = Object.values(worldData.entries).find(entry => entry.constant);
    assert.equal(constant.position, 0);
});

test('uid 不重复', () => {
    const uids = Object.values(worldData.entries).map(entry => entry.uid);
    assert.equal(new Set(uids).size, uids.length);
});

test('character_book 条目是数组且带 keys/content', () => {
    const book = world.buildCharacterBook(entries);
    assert.ok(Array.isArray(book.entries));
    assert.ok(book.entries.length > 0);
    for (const entry of book.entries) {
        assert.ok(Array.isArray(entry.keys));
        assert.ok(entry.keys.length > 0);
        assert.equal(typeof entry.content, 'string');
        assert.equal(entry.enabled, true);
        assert.equal(typeof entry.insertion_order, 'number');
    }
});

test('summarizeEntries 统计分类正确', () => {
    const summary = world.summarizeEntries(entries);
    assert.equal(summary.total, entries.length);
    assert.ok(summary.constant >= 1);
    assert.ok(summary.categories.length >= 1);
});

console.log('\n[4] 模型输出解析容错');

test('纯 JSON 对象', () => {
    assert.deepEqual(prompts.parseModelJson('{"name":"甲"}'), { name: '甲' });
});

test('带 ```json 围栏', () => {
    assert.deepEqual(prompts.parseModelJson('```json\n{"name":"甲"}\n```'), { name: '甲' });
});

test('前后有寒暄废话', () => {
    const text = '好的，我来分析一下：\n{"name":"甲","role":"剑客"}\n希望有帮助！';
    assert.equal(prompts.parseModelJson(text).role, '剑客');
});

test('纯数组输出', () => {
    const list = prompts.parseModelJson('[{"name":"甲"},{"name":"乙"}]');
    assert.equal(list.length, 2);
});

test('尾随逗号', () => {
    assert.deepEqual(prompts.parseModelJson('{"name":"甲",}'), { name: '甲' });
});

test('中文引号被纠正', () => {
    assert.equal(prompts.parseModelJson('{“name”:“甲”}').name, '甲');
});

test('被截断的数组能修复出可用元素', () => {
    const truncated = '[{"name":"甲","aliases":[]},{"name":"乙","aliases":["小乙"],"role":"剑客"';
    const list = prompts.parseModelJson(truncated);
    assert.ok(Array.isArray(list));
    assert.ok(list.length >= 1);
    assert.equal(list[0].name, '甲');
});

test('被截断的字符串不会抛错', () => {
    const parsed = prompts.parseModelJson('{"name":"甲","summary":"他站在');
    assert.equal(parsed.name, '甲');
});

test('asArray 能从被包了一层的对象里取出数组', () => {
    assert.equal(prompts.asArray({ characters: [{ name: '甲' }] }).length, 1);
    assert.equal(prompts.asArray([{ name: '甲' }]).length, 1);
    assert.equal(prompts.asArray({ name: '甲' }).length, 1);
    assert.equal(prompts.asArray(null).length, 0);
});

test('无法解析时抛出可读错误', () => {
    assert.throws(() => prompts.parseModelJson('完全没有 JSON'), /无法从模型返回中解析 JSON/);
});

console.log('\n[5] 分段与合并');

const ai = await load('src/ai.js');

test('短文不分段', () => {
    assert.equal(ai.splitNovel('很短的一段文字。').length, 1);
});

test('长文按段落边界切分且不丢内容', () => {
    const paragraphs = Array.from({ length: 60 }, (_, i) => `第${i}段：${'字'.repeat(180)}`);
    const text = paragraphs.join('\n');
    const chunks = ai.splitNovel(text, { chunkChars: 2000, overlapChars: 100 });
    assert.ok(chunks.length > 1);
    for (const paragraph of paragraphs) {
        const found = chunks.some(chunk => chunk.includes(paragraph));
        assert.ok(found, `段落丢失：${paragraph.slice(0, 12)}`);
    }
});

test('超长单段会被硬切且不丢字', () => {
    const text = '剑'.repeat(9000);
    const chunks = ai.splitNovel(text, { chunkChars: 2000, overlapChars: 0 });
    assert.equal(chunks.join('').length, 9000);
});

test('同一个人物的不同称呼被合并', () => {
    const merged = ai.mergeCharacters([
        { name: '沈青梧', aliases: ['青梧'], role: '首席弟子', screen_time: 'high', chunkIndex: 0 },
        { name: '青梧', aliases: [], role: '首席弟子', screen_time: 'mid', chunkIndex: 3 },
        { name: '路人甲', aliases: [], role: '路人', screen_time: 'low', chunkIndex: 1 },
    ]);
    assert.equal(merged.length, 2);
    assert.equal(merged[0].name, '沈青梧', '应保留更完整的名字');
    assert.equal(merged[0].chunkIndexes.length, 2, '出场段落应合并');
    assert.equal(merged[0].screen_time, 'high');
});

test('完全无关的角色不会被误合并', () => {
    const merged = ai.mergeCharacters([
        { name: '沈青梧', aliases: ['青梧'], chunkIndex: 0 },
        { name: '苏晚', aliases: ['晚晚'], chunkIndex: 0 },
    ]);
    assert.equal(merged.length, 2);
});

test('证据收集按命中密度排序，再按原文顺序输出', () => {
    // 甲段只提 1 次，乙段提 3 次，丙段提 2 次；windowSize 足够小，不会跨段合并
    const filler = '字'.repeat(50);
    const chunks = [
        `甲段${filler}沈青梧${filler}`,
        `乙段${filler}沈青梧${filler}沈青梧${filler}沈青梧${filler}`,
        `丙段${filler}沈青梧${filler}沈青梧${filler}`,
        `丁段${filler}没有提到任何人${filler}`,
    ];
    const evidence = ai.collectEvidence(chunks, { name: '沈青梧', aliases: [] }, { maxChunks: 3, windowSize: 200 });

    assert.ok(evidence.includes('乙段'), '命中最多的段必须被选进来');
    assert.ok(evidence.includes('丙段'));
    assert.ok(evidence.includes('甲段'));
    assert.equal(evidence.includes('丁段'), false, '没有命中的段不应出现');

    // 输出顺序应回到原文顺序：甲 → 乙 → 丙
    const order = ['甲段', '乙段', '丙段'].map(mark => evidence.indexOf(mark));
    assert.deepEqual([...order].sort((a, b) => a - b), order, `输出顺序不是原文顺序：${order}`);
});

test('maxChunks 生效：命中少的段被裁掉', () => {
    const filler = '字'.repeat(50);
    const chunks = [
        `甲段${filler}沈青梧${filler}`,
        `乙段${filler}沈青梧${filler}沈青梧${filler}沈青梧${filler}`,
    ];
    const evidence = ai.collectEvidence(chunks, { name: '沈青梧', aliases: [] }, { maxChunks: 1, windowSize: 200 });
    assert.ok(evidence.includes('乙段'));
    assert.equal(evidence.includes('甲段'), false);
});

test('没有任何命中的角色返回空证据', () => {
    assert.equal(ai.collectEvidence(['这里没有那个人'], { name: '沈青梧', aliases: [] }), '');
});

test('单字别名不会被当成命中依据（避免噪音）', () => {
    const chunks = ['梧字出现了很多次梧梧梧梧梧梧'];
    assert.equal(ai.collectEvidence(chunks, { name: '梧', aliases: [] }), '');
});

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
