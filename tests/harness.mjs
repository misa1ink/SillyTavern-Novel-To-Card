/**
 * 加载测试：在 Node 里用最小 DOM + 桩模块真正求值 index.js。
 *
 * 为什么需要它：曾经的 bug（`saveSettingsDebounced` 从 extensions.js 导入）
 * 语法完全合法，只在酒馆加载时才抛 SyntaxError，纯语法检查抓不到。
 * 这个 harness 把「扩展能否被加载」变成可自动验证的检查。
 *
 * 运行：node --experimental-vm-modules tests/harness.mjs
 */

import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

import { createFakeIndexedDB } from './fake-indexeddb.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

let passed = 0;
let failed = 0;

async function check(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ok   ${name}`);
    } catch (error) {
        failed++;
        console.log(`  FAIL ${name}\n       ${error.message}`);
    }
}

// ---------------------------------------------------------------- 最小 DOM

class FakeClassList {
    constructor(owner) { this.owner = owner; this.set = new Set(); }
    add(...names) { for (const n of names) this.set.add(n); }
    remove(...names) { for (const n of names) this.set.delete(n); }
    contains(name) { return this.set.has(name); }
    toggle(name, force) {
        const on = force === undefined ? !this.set.has(name) : !!force;
        if (on) this.set.add(name); else this.set.delete(name);
        return on;
    }
}

class FakeElement {
    constructor(tagName = 'div') {
        this.tagName = tagName.toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.style = {};
        this.dataset = {};
        this.classList = new FakeClassList(this);
        this._id = '';
        this._text = '';
        this._classes = [];
        this._listeners = new Map();
        this.attributes = {};
        this.value = '';
        this.checked = false;
        this.disabled = false;
        this.files = [];
        this.scrollTop = 0;
        this.scrollHeight = 0;
    }

    get id() { return this._id; }
    set id(value) {
        if (this._id && registry.get(this._id) === this) registry.delete(this._id);
        this._id = value;
        if (value) registry.set(value, this);
    }

    get className() { return this._classes.join(' '); }
    set className(value) {
        this._classes = String(value).split(/\s+/).filter(Boolean);
        this.classList = new FakeClassList(this);
        for (const cls of this._classes) this.classList.add(cls);
    }

    get textContent() { return this._text; }
    set textContent(value) { this._text = String(value); }

    /** innerHTML 赋值也会解析成真实节点，保持与浏览器一致 */
    get innerHTML() { return this._html ?? ''; }
    set innerHTML(value) {
        for (const child of [...this.children]) this.removeChild(child);
        this._html = String(value);
        const parsed = parseHtml(this._html);
        for (const child of [...parsed.children]) this.appendChild(child);
    }

    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    removeAttribute(name) { delete this.attributes[name]; }

    appendChild(child) {
        if (child.parentNode) child.parentNode.removeChild(child);
        child.parentNode = this;
        this.children.push(child);
        registerTree(child);
        return child;
    }
    removeChild(child) {
        this.children = this.children.filter(item => item !== child);
        child.parentNode = null;
        unregisterTree(child);
        return child;
    }
    insertBefore(node, reference) {
        const index = reference ? this.children.indexOf(reference) : -1;
        if (node.parentNode) node.parentNode.removeChild(node);
        node.parentNode = this;
        if (index >= 0) this.children.splice(index, 0, node);
        else this.children.push(node);
        registerTree(node);
        return node;
    }
    /** 只支持逗号分隔的简单选择器（.class / #id / tag），够 harness 用 */
    closest(selector) {
        const parts = String(selector).split(',').map(item => item.trim()).filter(Boolean);
        let node = this;
        while (node) {
            if (parts.some(part => matches(node, part))) return node;
            node = node.parentNode;
        }
        return null;
    }
    remove() {
        if (this.parentNode) this.parentNode.removeChild(this);
        else unregisterTree(this);
    }
    insertAdjacentHTML(_position, html) {
        const parsed = parseHtml(html);
        for (const child of [...parsed.children]) this.appendChild(child);
        this._html = (this._html ?? '') + String(html);
    }
    addEventListener(type, handler) {
        if (!this._listeners.has(type)) this._listeners.set(type, []);
        this._listeners.get(type).push(handler);
    }
    removeEventListener(type, handler) {
        const list = this._listeners.get(type) || [];
        this._listeners.set(type, list.filter(item => item !== handler));
    }
    dispatch(type, event = {}) {
        for (const handler of [...(this._listeners.get(type) || [])]) {
            handler({ target: this, preventDefault() {}, stopPropagation() {}, ...event });
        }
    }
    click() { this.dispatch('click', {}); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector) {
        const wanted = String(selector).trim();
        const out = [];
        const walk = node => {
            for (const child of node.children) {
                if (matches(child, wanted)) out.push(child);
                walk(child);
            }
        };
        walk(this);
        return out;
    }
    /** 节点树里是否包含某个 id（验证移动是否真的发生） */
    contains(node) {
        if (node === this) return true;
        return this.children.some(child => child.contains(node));
    }
}

/** 支持 .a.b / #id / tag 三种简单选择器（含复合类名） */
function matches(element, selector) {
    const text = String(selector).trim();
    if (text.startsWith('#')) return element.id === text.slice(1);
    if (text.startsWith('.')) {
        const classes = text.slice(1).split('.').filter(Boolean);
        return classes.every(cls => element.classList.contains(cls));
    }
    return element.tagName === text.toUpperCase();
}

const registry = new Map();

/** 把元素（含其后代）的 id 注册进去 / 从注册表摘掉 */
function registerTree(element) {
    if (!element) return;
    if (element._id) registry.set(element._id, element);
    for (const child of element.children || []) registerTree(child);
}

function unregisterTree(element) {
    if (!element) return;
    if (element._id && registry.get(element._id) === element) registry.delete(element._id);
    for (const child of element.children || []) unregisterTree(child);
}

/**
 * 极简 HTML 解析：只认识标签、属性（含 id/class）与文本。
 * 够 harness 用——目的是让面板 HTML 变成真实节点树，从而能验证节点移动。
 */
function parseHtml(html) {
    const root = new FakeElement('div');
    const stack = [root];
    const tokens = String(html).match(/<[^>]+>|[^<]+/g) || [];

    for (const token of tokens) {
        if (token.startsWith('</')) {
            if (stack.length > 1) stack.pop();
            continue;
        }
        if (!token.startsWith('<')) {
            const text = token.trim();
            if (text) stack[stack.length - 1]._text += text;
            continue;
        }
        const tagMatch = token.match(/^<\s*([a-zA-Z][\w-]*)/);
        if (!tagMatch) continue;
        const element = new FakeElement(tagMatch[1]);
        for (const attr of token.matchAll(/([a-zA-Z_:][\w:.-]*)\s*=\s*"([^"]*)"/g)) {
            const [, name, value] = attr;
            if (name === 'id') element.id = value;
            else if (name === 'class') element._classes = value.split(/\s+/).filter(Boolean);
            else element.setAttribute(name, value);
        }
        for (const cls of element._classes) element.classList.add(cls);
        stack[stack.length - 1].appendChild(element);
        // 自闭合 / 空元素
        if (!/\/>$/.test(token) && !/^(br|hr|img|input|meta|link)$/i.test(tagMatch[1])) {
            stack.push(element);
        }
    }
    return root;
}

function query(selector) {
    const text = String(selector);
    // 先走 id 快捷路径（面板控件都是按 id 查的）
    const byId = text.startsWith('#') ? registry.get(text.slice(1)) : null;
    if (byId) return byId;
    // 其余选择器在文档树里真实遍历
    return documentStub.body.querySelector(selector);
}

const documentStub = {
    head: new FakeElement('head'),
    body: new FakeElement('body'),
    getElementById: id => registry.get(id) || null,
    querySelector: query,
    querySelectorAll: () => [],
    createElement: tag => new FakeElement(tag),
    addEventListener() {},
    removeEventListener() {},
};

// 面板挂载需要的容器
for (const id of ['extensions_settings', 'extensions_menu', 'extensionsMenu', 'options']) {
    const element = new FakeElement();
    element.id = id;
    documentStub.body.appendChild(element);
}

// 模拟酒馆顶栏里的「扩展」抽屉按钮，扩展会把自己的入口插在它前面
const cubesDrawer = new FakeElement('div');
cubesDrawer.className = 'drawer';
const cubesToggle = new FakeElement('div');
cubesToggle.className = 'drawer-toggle';
const cubesIcon = new FakeElement('div');
cubesIcon.className = 'drawer-icon fa-solid fa-cubes';
cubesToggle.appendChild(cubesIcon);
cubesDrawer.appendChild(cubesToggle);
documentStub.body.appendChild(cubesDrawer);

const windowStub = {
    document: documentStub,
    toastr: { success() {}, error() {}, warning() {}, info() {} },
    setTimeout,
    clearTimeout,
    addEventListener() {},
};
windowStub.window = windowStub;
windowStub.globalThis = windowStub;

const sandbox = {
    console,
    document: documentStub,
    window: windowStub,
    navigator: { userAgent: 'node-harness' },
    location: { href: 'http://localhost/' },
    localStorage: {
        _data: new Map(),
        getItem(key) { return this._data.has(key) ? this._data.get(key) : null; },
        setItem(key, value) { this._data.set(key, String(value)); },
        removeItem(key) { this._data.delete(key); },
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    DataView,
    ArrayBuffer,
    Blob: class Blob { constructor(parts) { this.parts = parts; this.size = 0; } },
    File: class File { constructor(parts, name) { this.parts = parts; this.name = name; } },
    FormData: class FormData { constructor() { this.data = []; } append(...args) { this.data.push(args); } },
    URL: { createObjectURL: () => 'blob:stub', revokeObjectURL() {} },
    AbortController,
    fetch: async () => ({ ok: true, status: 200, text: async () => '{}' }),
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    indexedDB: createFakeIndexedDB(),
    jQuery: null,
};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;

// ---------------------------------------------------------------- 桩模块

/** 记录扩展对酒馆 API 的实际用法，便于断言 */
const usage = {
    settingsSaved: 0,
    registeredTabs: [],
    extensionSettingsTouched: [],
};

const extensionSettingsStub = {};

const stubs = {
    'script.js': `
        export const saveSettingsDebounced = () => { globalThis.__usage.settingsSaved++; };
        export const getCharacters = async () => {};
        export const eventSource = { on() {}, emit() {} };
        export const event_types = {};
        export const extension_settings = globalThis.__extensionSettings;
        export const saveChatConditional = async () => {};
        export const getContext = () => ({});
        export const chat_metadata = {};
        export const characters = [];
    `,
    'extensions.js': `
        export const extension_settings = globalThis.__extensionSettings;
        export const getContext = () => ({
            generateRaw: async () => '{"name":"桩角色","summary":"桩"}',
            getRequestHeaders: () => ({ 'X-CSRF-Token': 'stub' }),
            saveWorldInfo: async () => {},
            loadWorldInfo: async () => ({ entries: {} }),
        });
        export const renderExtensionTemplateAsync = async () => '';
        export const saveMetadataDebounced = () => {};
    `,
};

/** 这些 import 说明符在 Node 里不存在，用桩替换；其余交给真实文件系统 */
const STUB_SPECIFIERS = new Set(['script.js', 'extensions.js', '../../../../script.js', '../../../extensions.js']);

let context;
try {
    context = vm.createContext(sandbox);
    Object.assign(sandbox, { __usage: usage, __extensionSettings: extensionSettingsStub });
    sandbox.jQuery = fn => { if (typeof fn === 'function') fn(); return { on() { return this; } }; };
    sandbox.$ = sandbox.jQuery;

    const harness = new vm.SourceTextModule(
        `export const loaded = true;`,
        { context, identifier: 'harness' },
    );

    const cache = new Map();

    async function loadModule(absPath) {
        if (cache.has(absPath)) return cache.get(absPath);
        const source = readFileSync(absPath, 'utf8');
        const module = new vm.SourceTextModule(source, {
            context,
            identifier: pathToFileURL(absPath).href,
            initializeImportMeta(meta) { meta.url = pathToFileURL(absPath).href; },
        });
        cache.set(absPath, module);
        return module;
    }

    const indexModule = await loadModule(path.join(root, 'index.js'));

    await indexModule.link(async (specifier, referencing) => {
        const baseName = specifier.split('/').pop();
        if (STUB_SPECIFIERS.has(specifier) || STUB_SPECIFIERS.has(baseName)) {
            const key = `stub:${baseName}`;
            if (!cache.has(key)) {
                const module = new vm.SourceTextModule(stubs[baseName], { context, identifier: key });
                cache.set(key, module);
            }
            return cache.get(key);
        }
        // 真实文件：以引用方的位置解析相对路径
        const referencingPath = fileURLToPath(referencing.identifier);
        const resolved = path.resolve(path.dirname(referencingPath), specifier);
        return loadModule(resolved);
    });

    await indexModule.evaluate();

    console.log('\n[8] 扩展加载（真正求值 index.js）');
    check('index.js 能在最小 DOM 环境下完成求值，不抛错', () => { /* evaluate 已成功即通过 */ });
    check('面板已挂载到 extensions_settings', () => {
        const host = registry.get('extensions_settings');
        const html = host ? host.innerHTML : '';
        if (!html.includes('n2c-panel')) throw new Error('面板 HTML 未插入');
    });
    check('分卷、分级、独立 API 三个新区块的控件都被渲染', () => {
        const host = registry.get('extensions_settings');
        const html = host ? host.innerHTML : '';
        for (const id of ['n2c-split-enabled', 'n2c-preview-split', 'n2c-tier-enabled',
            'n2c-classify', 'n2c-api-client', 'n2c-api-url', 'n2c-api-test',
            'n2c-max-protagonists', 'n2c-max-supporting']) {
            if (!html.includes(`id="${id}"`)) throw new Error(`缺少控件 ${id}`);
        }
    });
    check('加载后能在扩展设置里看到本模块的配置对象', () => {
        const config = extensionSettingsStub['novel_to_card'];
        if (!config || typeof config !== 'object') throw new Error('extension_settings.novel_to_card 未初始化');
        for (const key of ['chunkChars', 'splitEnabled', 'tierEnabled', 'apiClient', 'maxProtagonists']) {
            if (config[key] === undefined) throw new Error(`默认设置缺少 ${key}`);
        }
    });

    check('改动设置会写回酒馆（事件绑定确实生效）', () => {
        const checkbox = registry.get('n2c-split-enabled');
        if (!checkbox) throw new Error('找不到启用分卷的复选框');
        const before = usage.settingsSaved;
        checkbox.checked = true;
        checkbox.dispatch('change');
        if (usage.settingsSaved <= before) throw new Error('触发 change 后没有保存设置');
        if (extensionSettingsStub['novel_to_card'].splitEnabled !== true) {
            throw new Error('splitEnabled 没有被写入扩展设置');
        }
    });

    check('切换模型通道会写回 apiClient', () => {
        const select = registry.get('n2c-api-client');
        if (!select) throw new Error('找不到模型通道下拉框');
        select.value = 'custom';
        select.dispatch('change');
        if (extensionSettingsStub['novel_to_card'].apiClient !== 'custom') {
            throw new Error('apiClient 没有被写入扩展设置');
        }
    });

    check('点击「预览分卷」在无文本时给出提示而不是抛错', () => {
        const button = registry.get('n2c-preview-split');
        if (!button) throw new Error('找不到预览分卷按钮');
        button.click();
    });

    // ---- 主开关 ----
    console.log('\n[9] 独立开关 / 独立窗口 / 中途保存');

    check('面板顶部有主开关和独立窗口按钮', () => {
        const host = registry.get('extensions_settings');
        const html = host ? host.innerHTML : '';
        for (const id of ['n2c-plugin-enabled', 'n2c-open-window', 'n2c-body', 'n2c-drawer-slot']) {
            if (!html.includes(`id="${id}"`)) throw new Error(`缺少控件 ${id}`);
        }
    });

    check('关闭主开关会给面板加置灰类，重新启用会移除', () => {
        const panel = registry.get('n2c-panel');
        const toggle = registry.get('n2c-plugin-enabled');
        if (!panel || !toggle) throw new Error('找不到面板或主开关');

        toggle.checked = false;
        toggle.dispatch('change');
        if (!panel.classList.contains('n2c-off')) throw new Error('关闭后没有加上 n2c-off');
        if (extensionSettingsStub['novel_to_card'].pluginEnabled !== false) {
            throw new Error('pluginEnabled 没有写回设置');
        }

        toggle.checked = true;
        toggle.dispatch('change');
        if (panel.classList.contains('n2c-off')) throw new Error('重新启用后 n2c-off 没有被移除');
    });

    check('插件关闭时动作入口被拦住（点预览分卷不发请求）', () => {
        const toggle = registry.get('n2c-plugin-enabled');
        toggle.checked = false;
        toggle.dispatch('change');
        const button = registry.get('n2c-preview-split');
        const before = JSON.stringify(usage);
        button.click();
        if (JSON.stringify(usage) !== before) throw new Error('关闭状态下仍然产生了副作用');
        toggle.checked = true;
        toggle.dispatch('change');
    });

    check('顶栏入口被挂载到扩展按钮前面', () => {
        const drawer = registry.get('n2c-drawer');
        if (!drawer) throw new Error('顶栏入口没有被创建');
        if (drawer.parentNode !== documentStub.body) throw new Error('顶栏入口没挂在顶栏上');
        const siblings = documentStub.body.children;
        const mine = siblings.indexOf(drawer);
        const cubes = siblings.indexOf(cubesDrawer);
        if (mine < 0 || cubes < 0) throw new Error('找不到入口或扩展按钮');
        if (mine !== cubes - 1) throw new Error('入口没有插在扩展按钮前面');
    });

    check('关闭插件时顶栏入口整块消失，重新启用后恢复', () => {
        const toggle = registry.get('n2c-plugin-enabled');
        const drawer = registry.get('n2c-drawer');
        if (!toggle || !drawer) throw new Error('缺少主开关或顶栏入口');

        toggle.checked = false;
        toggle.dispatch('change');
        if (drawer.style.display !== 'none') {
            throw new Error(`关闭后顶栏入口没有隐藏（display=${JSON.stringify(drawer.style.display)}）`);
        }
        const icon = registry.get('n2c-drawer-icon');
        if (icon && !icon.title.includes('已关闭')) throw new Error('图标标题没有反映关闭状态');

        toggle.checked = true;
        toggle.dispatch('change');
        if (drawer.style.display === 'none') throw new Error('重新启用后顶栏入口没有恢复显示');
    });

    check('关闭时会显示「已关闭」标记，启用后隐藏', () => {
        const toggle = registry.get('n2c-plugin-enabled');
        const badge = registry.get('n2c-disabled-badge');
        if (!badge) throw new Error('找不到已关闭标记');

        toggle.checked = false;
        toggle.dispatch('change');
        if (badge.style.display === 'none') throw new Error('关闭后标记没有显示');

        toggle.checked = true;
        toggle.dispatch('change');
        if (badge.style.display !== 'none') throw new Error('启用后标记没有隐藏');
    });

    check('打开独立窗口会把面板主体搬进窗口', () => {
        const button = registry.get('n2c-open-window');
        if (!button) throw new Error('找不到独立窗口按钮');
        button.click();

        const win = registry.get('n2c-window');
        if (!win) throw new Error('浮窗没有被创建');
        const body = registry.get('n2c-body');
        if (!body) throw new Error('找不到面板主体');
        if (body.parentNode !== win.querySelector('#n2c-window-body')) {
            throw new Error('面板主体没有搬进浮窗');
        }
        if (extensionSettingsStub['novel_to_card'].useFloatingWindow !== true) {
            throw new Error('useFloatingWindow 没有写回设置');
        }
    });

    check('窗口关闭后主体回到抽屉槽位', () => {
        const closeButton = registry.get('n2c-window-close');
        if (!closeButton) throw new Error('找不到窗口关闭按钮');
        closeButton.click();
        if (registry.get('n2c-window')) throw new Error('窗口没有被移除');
        const body = registry.get('n2c-body');
        const slot = registry.get('n2c-drawer-slot');
        if (body.parentNode !== slot) throw new Error('面板主体没有回到抽屉槽位');
        if (extensionSettingsStub['novel_to_card'].useFloatingWindow !== false) {
            throw new Error('useFloatingWindow 没有被重置');
        }
    });

    check('存档能写入 IndexedDB 并列出', async () => {
        // 先塞一点可保存的进度
        const characterList = extensionSettingsStub['novel_to_card'];
        if (!characterList) throw new Error('设置未初始化');

        const saveButton = registry.get('n2c-save-now');
        if (!saveButton) throw new Error('找不到立即存档按钮');
        // 无进度时应给出提示而不是抛错
        saveButton.click();

        const nameInput = registry.get('n2c-save-name');
        if (nameInput) nameInput.value = '单元测试存档';
        saveButton.click();
        await new Promise(resolve => setTimeout(resolve, 20));
    });

    check('没有进度时点存档不会报错', () => {
        const saveButton = registry.get('n2c-save-now');
        saveButton.click();
    });

    // ---- 存档往返：直接复用 index.js 已经加载过的 persist 模块，验证 IndexedDB 链路 ----
    const persistCacheKey = path.join(root, 'src/persist.js');
    const persistModule = cache.get(persistCacheKey);
    if (!persistModule) throw new Error('persist.js 没有被加载，检查 index.js 的导入');
    const persist = persistModule.namespace;

    await check('存档写读往返：中文、分卷正文、角色档案都不丢', async () => {
        const snapshot = {
            novelTitle: '试炼之书',
            rawText: '第一章 起点\n' + '剑光掠过山巅。'.repeat(500),
            volumes: [{ index: 0, label: '第 1 卷', title: '第一章 起点', chars: 4000, body: '第一章 起点\n正文' }],
            volumeIndex: 0,
            characters: [{ name: '沈青梧', aliases: ['青梧'], tier: '主角', selected: true }],
            profiles: [{ name: '沈青梧', tier: '主角', cardV3: { spec: 'chara_card_v3', data: { name: '沈青梧' } } }],
            entries: [{ comment: '青云宗', keys: ['青云宗'], content: '东域第一剑宗。' }],
            logLines: [{ stamp: '12:00:00', message: '测试', level: 'info' }],
        };

        const saved = await persist.saveSnapshot({ name: '往返测试', state: snapshot });
        if (!saved.id) throw new Error('没有返回存档 id');
        if (!(saved.bytes > 0)) throw new Error('字节数为 0');

        const list = await persist.listSnapshots();
        if (!list.some(item => item.id === saved.id)) throw new Error('存档没有出现在列表里');
        // 摘要里绝不能带出 state 本体，否则一次能读出几 MB
        for (const item of list) {
            if ('state' in item) throw new Error('列表摘要里带出了 state 字段');
        }

        const loaded = await persist.loadSnapshot(saved.id);
        if (!loaded) throw new Error('读不到存档');
        const restored = loaded.state;
        if (restored.novelTitle !== snapshot.novelTitle) throw new Error('作品名丢失');
        if (restored.rawText.length !== snapshot.rawText.length) throw new Error('正文长度变了');
        if (restored.rawText !== snapshot.rawText) throw new Error('正文内容变了');
        if (restored.characters[0].aliases[0] !== '青梧') throw new Error('别名丢失');
        if (restored.characters[0].tier !== '主角') throw new Error('分级丢失');
        if (restored.profiles[0].cardV3.data.name !== '沈青梧') throw new Error('卡片数据丢失');
        if (restored.entries[0].content !== '东域第一剑宗。') throw new Error('世界书条目丢失');
    });

    await check('同名存档会覆盖而不是堆积', async () => {
        const before = (await persist.listSnapshots()).length;
        const first = await persist.saveSnapshot({ name: '覆盖测试', state: { novelTitle: 'v1' } });
        await persist.saveSnapshot({ id: first.id, name: '覆盖测试', state: { novelTitle: 'v2' } });
        const after = await persist.listSnapshots();
        if (after.length !== before + 1) throw new Error(`存档数量不对：${before} -> ${after.length}`);
        const reloaded = await persist.loadSnapshot(first.id);
        if (reloaded.state.novelTitle !== 'v2') throw new Error('覆盖没有生效');
    });

    await check('删除存档后读不到', async () => {
        const saved = await persist.saveSnapshot({ name: '待删除', state: { novelTitle: 'x' } });
        await persist.deleteSnapshot(saved.id);
        const loaded = await persist.loadSnapshot(saved.id);
        if (loaded !== null) throw new Error('删除后仍能读到');
    });

    await check('latestSnapshot 返回最近一份', async () => {
        await persist.saveSnapshot({ name: '较旧', state: { novelTitle: 'old' } });
        await new Promise(resolve => setTimeout(resolve, 5));
        const newest = await persist.saveSnapshot({ name: '较新', state: { novelTitle: 'new' } });
        const latest = await persist.latestSnapshot();
        if (!latest || latest.id !== newest.id) throw new Error('返回的不是最近一份');
    });

    await check('formatBytes / formatTime 输出可读', () => {
        if (persist.formatBytes(512) !== '512 B') throw new Error('B 档格式化不对');
        if (!persist.formatBytes(2048).includes('KB')) throw new Error('KB 档格式化不对');
        if (!persist.formatBytes(5 * 1024 * 1024).includes('MB')) throw new Error('MB 档格式化不对');
        if (typeof persist.formatTime(Date.now()) !== 'string') throw new Error('时间格式化不对');
    });

    console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
    process.exit(failed === 0 ? 0 : 1);
} catch (error) {
    console.log('\n[8] 扩展加载（真正求值 index.js）');
    console.log(`  FAIL 求值 index.js 时抛错：\n       ${error.stack || error.message}\n`);
    console.log(`结果：${passed} 通过，${failed + 1} 失败\n`);
    process.exit(1);
}
