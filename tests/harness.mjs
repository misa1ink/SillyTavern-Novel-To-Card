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

function toKebab(text) {
    return text.replace(/[A-Z]/g, ch => `-${ch.toLowerCase()}`);
}

function toCamel(text) {
    return text.replace(/-([a-z])/g, (_match, ch) => ch.toUpperCase());
}

class FakeClassList {    constructor(owner) { this.owner = owner; this.set = new Set(); }
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
        // dataset 与 data-* 属性互通，跟浏览器行为一致（面板用 dataset.tab 区分标签页）
        this.dataset = new Proxy({}, {
            get: (_target, key) => this.attributes[`data-${toKebab(String(key))}`],
            set: (_target, key, value) => {
                this.attributes[`data-${toKebab(String(key))}`] = String(value);
                return true;
            },
            has: (_target, key) => `data-${toKebab(String(key))}` in this.attributes,
            ownKeys: () => Object.keys(this.attributes)
                .filter(name => name.startsWith('data-'))
                .map(name => toCamel(name.slice(5))),
            getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
        });
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
    /**
     * 触发事件并向上冒泡（与浏览器一致）。
     * 面板的标签页切换用的是事件委托，不冒泡的话这类代码在测试里永远不会执行。
     */
    dispatch(type, event = {}) {
        let node = this;
        const payload = { target: this, preventDefault() {}, stopPropagation() {}, ...event };
        while (node) {
            for (const handler of [...(node._listeners.get(type) || [])]) {
                handler(payload);
            }
            node = node.parentNode;
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
    metadataSaved: 0,
    extensionPromptCalls: [],
    /** 扩展注册过的事件名 */
    registeredEvents: [],
};

const extensionSettingsStub = {};

/** 每个聊天共享的元数据，剧情进度存在这里 */
const chatMetadataStub = {};

/** 极简事件总线：剧情注入依赖 CHAT_COMPLETION_PROMPT_READY 等事件 */
const eventHandlers = new Map();
const eventSourceStub = {
    on(event, handler) {
        if (!eventHandlers.has(event)) eventHandlers.set(event, []);
        eventHandlers.get(event).push(handler);
        usage.registeredEvents.push(event);
    },
    off() {},
    removeListener() {},
    emit() {},
};

const eventTypesStub = {
    CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready',
    MESSAGE_RECEIVED: 'message_received',
    CHAT_CHANGED: 'chat_changed',
    CHARACTER_EDITED: 'character_edited',
};

/** 测试里触发某个酒馆事件 */
function emitEvent(type, ...args) {
    for (const handler of eventHandlers.get(type) || []) handler(...args);
}

const stubs = {
    'script.js': `
        export const saveSettingsDebounced = () => { globalThis.__usage.settingsSaved++; };
        export const saveMetadataDebounced = () => { globalThis.__usage.metadataSaved++; };
        export const getCharacters = async () => {};
        export const chat_metadata = globalThis.__chatMetadata;
        export const eventSource = globalThis.__eventSource;
        export const event_types = globalThis.__eventTypes;
        export const extension_settings = globalThis.__extensionSettings;
        export const saveChatConditional = async () => {};
        export const getContext = () => globalThis.__context;
        export const characters = [];
        export const setExtensionPrompt = (...args) => { globalThis.__usage.extensionPromptCalls.push(args); };
    `,
    'extensions.js': `
        export const extension_settings = globalThis.__extensionSettings;
        export const getContext = () => globalThis.__context;
        export const renderExtensionTemplateAsync = async () => '';
        export const saveMetadataDebounced = () => { globalThis.__usage.metadataSaved++; };
    `,
};

/** 这些 import 说明符在 Node 里不存在，用桩替换；其余交给真实文件系统 */
const STUB_SPECIFIERS = new Set(['script.js', 'extensions.js', '../../../../script.js', '../../../extensions.js']);

let context;
try {
    context = vm.createContext(sandbox);
    // 假酒馆上下文：扩展通过 getContext() 拿事件系统、聊天记录与世界书接口
    const hubContext = {
        eventSource: eventSourceStub,
        eventTypes: eventTypesStub,
        chat: [],
        generateRaw: async () => '{"name":"桩角色","summary":"桩"}',
        getRequestHeaders: () => ({ 'X-CSRF-Token': 'stub' }),
        saveWorldInfo: async () => {},
        loadWorldInfo: async () => ({ entries: {} }),
        updateMessageBlock() {},
    };
    Object.assign(sandbox, {
        __usage: usage,
        __extensionSettings: extensionSettingsStub,
        __chatMetadata: chatMetadataStub,
        __eventSource: eventSourceStub,
        __eventTypes: eventTypesStub,
        __context: hubContext,
    });
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

    check('面板分成五个标签页，每页都有对应面板', () => {
        const panel = registry.get('n2c-panel');
        const tabs = panel.querySelectorAll('.n2c-tab').map(tab => tab.dataset.tab);
        const panes = panel.querySelectorAll('.n2c-pane').map(pane => pane.dataset.pane);
        for (const expected of ['work', 'story', 'chars', 'settings', 'data']) {
            if (!tabs.includes(expected)) throw new Error(`缺少标签页 ${expected}`);
            if (!panes.includes(expected)) throw new Error(`缺少面板 ${expected}`);
        }
    });

    check('初始只显示「转换」页', () => {
        const panel = registry.get('n2c-panel');
        const active = panel.querySelectorAll('.n2c-pane')
            .filter(pane => pane.classList.contains('n2c-pane-active'))
            .map(pane => pane.dataset.pane);
        if (active.length !== 1 || active[0] !== 'work') {
            throw new Error(`初始激活的面板不对：${JSON.stringify(active)}`);
        }
    });

    check('点标签能切页，且同时只有一个面板可见', () => {
        const panel = registry.get('n2c-panel');
        const settingsTab = panel.querySelectorAll('.n2c-tab').find(tab => tab.dataset.tab === 'settings');
        if (!settingsTab) throw new Error('找不到设置标签');
        settingsTab.dispatch('click', { target: settingsTab });

        const active = panel.querySelectorAll('.n2c-pane')
            .filter(pane => pane.classList.contains('n2c-pane-active'))
            .map(pane => pane.dataset.pane);
        if (active.length !== 1 || active[0] !== 'settings') {
            throw new Error(`切换后面板不对：${JSON.stringify(active)}`);
        }
        const activeTabs = panel.querySelectorAll('.n2c-tab')
            .filter(tab => tab.classList.contains('n2c-tab-active'))
            .map(tab => tab.dataset.tab);
        if (activeTabs.length !== 1 || activeTabs[0] !== 'settings') {
            throw new Error(`高亮的标签不对：${JSON.stringify(activeTabs)}`);
        }

        // 切回去
        const workTab = panel.querySelectorAll('.n2c-tab').find(tab => tab.dataset.tab === 'work');
        workTab.dispatch('click', { target: workTab });
    });

    check('独立 API 配置在设置页，且不再埋在高级设置抽屉里', () => {
        const panel = registry.get('n2c-panel');
        const settingsPane = panel.querySelectorAll('.n2c-pane').find(pane => pane.dataset.pane === 'settings');
        if (!settingsPane) throw new Error('找不到设置页');

        const apiConfig = registry.get('n2c-api-config');
        if (!apiConfig) throw new Error('找不到独立 API 配置块');
        if (!settingsPane.contains(apiConfig)) throw new Error('独立 API 不在设置页里');

        // 控件嵌套层数：卡片 → 配置块 → 字段，不应再深
        let depth = 0;
        let node = apiConfig;
        while (node && node !== settingsPane) {
            node = node.parentNode;
            depth++;
            if (depth > 6) break;
        }
        if (depth > 6) throw new Error(`独立 API 嵌套过深（${depth} 层）`);
    });

    check('所有可交互控件都在 DOM 里且带 id（没有孤立的 id 引用）', () => {
        const panel = registry.get('n2c-panel');
        const needed = ['n2c-analyze', 'n2c-generate', 'n2c-classify', 'n2c-save-now',
            'n2c-preview-split', 'n2c-api-test', 'n2c-autosave', 'n2c-clear-log'];
        for (const id of needed) {
            const element = registry.get(id);
            if (!element) throw new Error(`控件 ${id} 不存在`);
            if (!panel.contains(element)) throw new Error(`控件 ${id} 不在面板 DOM 树里`);
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

    // ---- 剧情注入集成：验证扩展真的把剧情塞进请求，并且能读回控制行 ----
    // 纯逻辑（节点推进、控制行解析、变量变更）在 tests/story.mjs，跑得更快也更细
    console.log('\n[10] 剧情注入集成');

    const storyEngineCacheKey = path.join(root, 'src/story-engine.js');
    const storyEngineModule = cache.get(storyEngineCacheKey);
    if (!storyEngineModule) throw new Error('story-engine.js 没有被加载，检查 index.js 的导入');

    const samplePlaybook = {
        player: { name: '沈青梧', identity: '青云宗首席弟子', goal: '查明师父下落', items: ['半块玄铁令'] },
        variables: [
            { name: '好感度', type: 'number', initial: 0, desc: '与苏晚的关系' },
            { name: '伤势', type: 'text', initial: '轻伤', desc: '身体状况' },
        ],
        stages: [
            { index: 0, title: '宗门残夜', location: '青云宗', situation: '火光里你醒来。', keyCharacters: ['苏晚'], objective: '找到苏晚', exitHint: '确认苏晚安危' },
            { index: 1, title: '后山密道', location: '后山', situation: '你摸到石壁的裂缝。', keyCharacters: [], objective: '进密道', exitHint: '进入密道' },
        ],
        warnings: [],
    };

    check('剧情页的控件都渲染出来了', () => {
        const panel = registry.get('n2c-panel');
        for (const id of ['n2c-story-file', 'n2c-story-title', 'n2c-story-player', 'n2c-make-card',
            'n2c-story-active', 'n2c-story-progress', 'n2c-story-opening',
            'n2c-story-nodes', 'n2c-story-depth', 'n2c-story-redownload', 'n2c-import-card']) {
            const element = registry.get(id);
            if (!element) throw new Error(`缺少控件 ${id}`);
            if (!panel.contains(element)) throw new Error(`控件 ${id} 不在面板 DOM 树里`);
        }
    });

    check('去掉了一键自动导入：默认开关是关的', () => {
        const config = extensionSettingsStub['novel_to_card'];
        if (config.importToTavern !== false) {
            throw new Error(`默认不应自动导入，实际 importToTavern=${config.importToTavern}`);
        }
    });

    check('扩展注册了剧情所需的三个酒馆事件', () => {
        for (const type of [eventTypesStub.CHAT_COMPLETION_PROMPT_READY,
            eventTypesStub.MESSAGE_RECEIVED, eventTypesStub.CHAT_CHANGED]) {
            if (!usage.registeredEvents.includes(type)) throw new Error(`没有注册事件 ${type}`);
        }
    });

    check('剧情未开启时不注入任何内容', () => {
        hubContext.chat.length = 0;
        emitEvent(eventTypesStub.CHAT_COMPLETION_PROMPT_READY, { chat: hubContext.chat });
        if (hubContext.chat.length !== 0) throw new Error('未开启剧情却注入了内容');
    });

    await check('开启后把当前剧情段注入 eventData.chat', async () => {
        // 模拟真实路径：用户在界面上打开「注入剧情」开关，
        // 处理器会把 storyActive 与 _storyActive 一起写进设置
        const config = extensionSettingsStub['novel_to_card'];
        config._storyPlaybook = samplePlaybook;
        config._storyOpening = '开场白测试';

        const toggle = registry.get('n2c-story-active');
        if (!toggle) throw new Error('找不到注入开关');
        toggle.checked = true;
        toggle.dispatch('change');
        await new Promise(resolve => setTimeout(resolve, 20));

        if (config._storyActive !== true) throw new Error('开关状态没有落盘，刷新后会失效');

        // 触发 CHAT_CHANGED 让扩展重新加载剧本与进度
        emitEvent(eventTypesStub.CHAT_CHANGED);
        await new Promise(resolve => setTimeout(resolve, 20));

        hubContext.chat.length = 0;
        emitEvent(eventTypesStub.CHAT_COMPLETION_PROMPT_READY, { chat: hubContext.chat });

        if (hubContext.chat.length !== 1) throw new Error(`注入条数不对：${hubContext.chat.length}`);
        const injected = hubContext.chat[0].content;
        if (!injected.includes('宗门残夜')) throw new Error('注入内容缺少当前段');
        if (!injected.includes('沈青梧')) throw new Error('注入内容缺少玩家身份');
        if (hubContext.chat[0].is_system !== true) throw new Error('注入消息没有标记为 system');
    });

    await check('模型回复带控制行时：剔标记、改变量、自动推进', async () => {
        hubContext.chat.length = 0;
        hubContext.chat.push({ is_user: false, mes: '火光里你醒来。\n[状态] 好感度=+7；伤势=重伤\n[推进]' });

        emitEvent(eventTypesStub.MESSAGE_RECEIVED, 0);
        await new Promise(resolve => setTimeout(resolve, 30));

        const message = hubContext.chat[0];
        if (message.mes.includes('[推进]') || message.mes.includes('[状态]')) {
            throw new Error(`控制行没有被剔除：${JSON.stringify(message.mes)}`);
        }
        if (!message.mes.includes('火光里你醒来')) throw new Error('正文被误删');

        const saved = chatMetadataStub['novel_to_card_story'];
        if (!saved) throw new Error('进度没有写进聊天元数据');
        if (saved.variables['好感度'] !== 7) throw new Error(`数值变量没有累加：${saved.variables['好感度']}`);
        if (saved.variables['伤势'] !== '重伤') throw new Error('文本变量没有更新');
        if (saved.stageIndex !== 1) throw new Error(`没有自动推进：${saved.stageIndex}`);
    });

    await check('关闭注入后不再往请求里塞剧情', async () => {
        const toggle = registry.get('n2c-story-active');
        toggle.checked = false;
        toggle.dispatch('change');
        await new Promise(resolve => setTimeout(resolve, 20));

        if (extensionSettingsStub['novel_to_card']._storyActive !== false) {
            throw new Error('关闭状态没有落盘');
        }

        hubContext.chat.length = 0;
        emitEvent(eventTypesStub.CHAT_COMPLETION_PROMPT_READY, { chat: hubContext.chat });
        if (hubContext.chat.length !== 0) throw new Error('关闭后仍在注入');
    });

    console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
    process.exit(failed === 0 ? 0 : 1);
} catch (error) {
    console.log('\n[8] 扩展加载（真正求值 index.js）');
    console.log(`  FAIL 求值 index.js 时抛错：\n       ${error.stack || error.message}\n`);
    console.log(`结果：${passed} 通过，${failed + 1} 失败\n`);
    process.exit(1);
}
