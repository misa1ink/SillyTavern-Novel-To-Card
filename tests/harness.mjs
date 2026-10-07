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

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

let passed = 0;
let failed = 0;

function check(name, fn) {
    try {
        fn();
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
        this._html = '';
        this.textContent = '';
        this.value = '';
        this.checked = false;
        this.disabled = false;
        this.attributes = {};
        this._listeners = new Map();
        this.files = [];
    }

    get id() { return this._id; }
    set id(value) { this._id = value; registry.set(value, this); }

    get innerHTML() { return this._html; }
    set innerHTML(value) { this._html = String(value); }

    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    removeAttribute(name) { delete this.attributes[name]; }

    appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        return child;
    }
    removeChild(child) {
        this.children = this.children.filter(item => item !== child);
        return child;
    }
    remove() {
        if (this.parentNode) this.parentNode.removeChild(this);
        if (this._id) registry.delete(this._id);
    }
    insertAdjacentHTML(_position, html) {
        // 面板 HTML 会被塞进来；把里面的 id 注册出来，模拟真实 DOM 的 id 查询
        this._html += String(html);
        for (const match of String(html).matchAll(/id="([^"]+)"/g)) {
            if (!registry.has(match[1])) registry.set(match[1], new FakeElement());
        }
    }
    addEventListener(type, handler) {
        if (!this._listeners.has(type)) this._listeners.set(type, []);
        this._listeners.get(type).push(handler);
    }
    removeEventListener(type, handler) {
        const list = this._listeners.get(type) || [];
        this._listeners.set(type, list.filter(item => item !== handler));
    }
    /** 测试里手动触发事件用 */
    dispatch(type, event = {}) {
        for (const handler of this._listeners.get(type) || []) {
            handler({ target: this, preventDefault() {}, stopPropagation() {}, ...event });
        }
    }
    querySelector(selector) { return query(selector); }
    querySelectorAll() { return []; }
    click() { this.dispatch('click', {}); }
}

const registry = new Map();

function query(selector) {
    const text = String(selector);
    if (text.startsWith('#')) return registry.get(text.slice(1)) || null;
    return null;
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

    console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
    process.exit(failed === 0 ? 0 : 1);
} catch (error) {
    console.log('\n[8] 扩展加载（真正求值 index.js）');
    console.log(`  FAIL 求值 index.js 时抛错：\n       ${error.stack || error.message}\n`);
    console.log(`结果：${passed} 通过，${failed + 1} 失败\n`);
    process.exit(1);
}
