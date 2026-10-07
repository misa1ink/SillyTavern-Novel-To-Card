/**
 * 小说转角色卡 —— SillyTavern 扩展
 *
 * 功能：
 *   1. 导入小说文本（txt / md / jsonl / 直接粘贴）
 *   2. 调当前连接的模型分段提取出场人物，合并同名角色
 *   3. 逐角色生成结构化档案，构建 V2 / V3 角色卡
 *   4. 导出内嵌 chara / ccv3 区块的 PNG 角色卡（可直接拖回酒馆导入）
 *   5. 顺带提取世界观，导出世界书 JSON，并可内嵌进角色卡
 *
 * 文本生成走 getContext().generateRaw()：只借用酒馆当前的主通道，
 * 不写入聊天记录，也不走角色卡/预设的提示词注入。
 */

import { getContext, extension_settings } from '../../../extensions.js';
// 这些都由 script.js 导出（extensions.js 不导出它们，导入错会在激活期直接抛 SyntaxError）
import {
    saveSettingsDebounced,
    getCharacters,
    chat_metadata,
    saveMetadataDebounced,
} from '../../../../script.js';

import {
    splitNovel,
    createConfiguredModelClient,
    testCustomApi,
    fetchModelList,
    discoverCharacters,
    mergeCharacters,
    collectEvidence,
    extractProfile,
    extractWorldEntries,
    classifyCharacters,
    isBriefTier,
    canonicalName,
    extractStoryStages,
    generateOpening,
} from './src/ai.js';

import {
    buildCardV2,
    buildCardV3,
    safeFileName,
    summarizeCard,
    normalizeName,
} from './src/card-builder.js';

import {
    normalizeEntries,
    buildWorldInfoData,
    buildCharacterBook,
    summarizeEntries,
} from './src/world-builder.js';

import {
    embedCardIntoPng,
    readCardFromPng,
    readFileAsBytes,
    readFileAsText,
    imageToPngBytes,
    generatePlaceholderPng,
    downloadBytes,
    downloadBlob,
    utf8ToBase64,
    isPngBytes,
} from './src/png-card.js';

import {
    splitIntoVolumes,
    estimateVolumeCost,
} from './src/splits.js';

import {
    saveSnapshot,
    listSnapshots,
    loadSnapshot,
    deleteSnapshot,
    latestSnapshot,
    formatBytes,
    formatTime,
} from './src/persist.js';

import {
    normalizePlaybook,
    createRuntimeState,
    advanceStage,
    currentStage,
    formatVariables,
    buildStoryPrompt,
    parseControlLines,
    applyVariableChanges,
    buildStoryWorldInfo,
    summarizeProgress,
} from './src/story-engine.js';

const MODULE_NAME = 'novel_to_card';

const DEFAULT_SETTINGS = Object.freeze({
    chunkChars: 6000,
    concurrency: 3,
    simplifyMerged: true,
    maxCharacters: 8,
    evidenceChunks: 8,
    cardVersion: '3',
    withWorldBook: true,
    worldEntryCount: 12,
    embedWorldBook: true,
    saveWorldBookFile: true,
    importToTavern: true,
    avatarMaxSize: 512,
    resizeAvatar: false,
    placeholderAvatar: true,
    extraInstruction: '',
    creatorName: '小说转角色卡',
    cardVersionTag: '1.0',
    autoTag: true,
    // 分卷
    splitEnabled: false,
    splitMode: 'auto',
    volumeCount: 6,
    charsPerVolume: 500_000,
    splitByChapter: true,
    // 独立 API
    apiClient: 'tavern',          // tavern | custom
    apiUrl: '',
    apiKey: '',
    apiModel: '',
    apiStream: false,
    apiTemperature: '',
    apiTopP: '',
    apiManualModel: false,
    // 角色分级
    tierEnabled: true,
    maxProtagonists: 3,
    maxSupporting: 6,
    briefSupporting: true,
    // 独立开关与窗口
    pluginEnabled: true,
    useFloatingWindow: false,
    winX: null,
    winY: null,
    winW: 420,
    winH: 620,
    // 中途保存
    autoSave: true,
    // 剧情推进器
    storyPlayerName: '',
    storyNodeCount: 12,
    storyStyle: '',
    storyActive: false,
    storyAutoAdvance: true,
    storyAutoReport: true,
    storyInjectDepth: 4,
});

const state = {
    rawText: '',
    novelTitle: '',
    chunks: [],
    characters: [],   // 合并后的候选角色
    profiles: [],     // 已生成的档案
    entries: [],      // 世界书条目
    darkImage: null,  // 用户指定的底图字节
    darkImageName: '',
    running: false,
    abort: null,
    logLines: [],
    // 分卷
    volumes: [],
    volumeIndex: 0,
    volumeWarnings: [],
    // 独立窗口
    panelBody: null,
    winEl: null,
    dragging: null,
    // 中途保存
    lastSaveId: null,
    lastSaveAt: 0,
    snapshotList: [],
    // 界面
    activeTab: 'work',
    // 独立 API 拉取到的模型列表（只存内存，避免把长列表塞进设置）
    modelList: [],
    // 剧情推进器
    playbook: null,
    runtime: null,
    storyActive: false,
    storyOpening: '',
};

// ================================================================
// 设置
// ================================================================

function getSettings() {
    extension_settings[MODULE_NAME] = extension_settings[MODULE_NAME] || {};
    const saved = extension_settings[MODULE_NAME];
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (saved[key] === undefined) saved[key] = DEFAULT_SETTINGS[key];
    }
    return saved;
}

function putSettings() {
    saveSettingsDebounced();
}

// ================================================================
// DOM 工具
// ================================================================

const $id = id => document.getElementById(id);
const $q = selector => document.querySelector(selector);

function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function toast(type, message, title = '小说转角色卡') {
    const toastr = window.toastr;
    if (toastr && typeof toastr[type] === 'function') {
        toastr[type](message, title, { timeOut: type === 'error' ? 8000 : 4000 });
        return;
    }
    if (type === 'error') console.error(`[${title}] ${message}`);
    else console.info(`[${title}] ${message}`);
}

function log(message, level = 'info') {
    const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    state.logLines.push({ stamp, message: String(message), level });
    if (state.logLines.length > 400) state.logLines.shift();

    const box = $id('n2c-log');
    if (box) {
        const line = document.createElement('div');
        line.className = `n2c-log-line n2c-log-${level}`;
        line.innerHTML = `<span class="n2c-log-time">${stamp}</span><span class="n2c-log-text">${escapeHtml(message)}</span>`;
        box.appendChild(line);
        box.scrollTop = box.scrollHeight;
    }
    if (level === 'error') console.error(`[小说转角色卡] ${message}`);
    else console.log(`[小说转角色卡] ${message}`);
}

function setProgress(percent, text) {
    const bar = $id('n2c-progress-bar');
    const label = $id('n2c-progress-text');
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    if (label) label.textContent = text || '';
}

function setRunning(running) {
    state.running = running;
    for (const id of ['n2c-analyze', 'n2c-generate', 'n2c-make-world']) {
        const button = $id(id);
        if (button) button.disabled = running;
    }
    const cancel = $id('n2c-cancel');
    if (cancel) cancel.style.display = running ? '' : 'none';
}

// ================================================================
// 面板
// ================================================================

/** 标签页定义：常用流程放第一页，参数收进设置页，避免一屏堆二十多个控件 */
const PANEL_TABS = [
    { id: 'work', label: '转换', icon: 'fa-wand-magic-sparkles', title: '从小说正文到角色卡的主流程' },
    { id: 'story', label: '剧情', icon: 'fa-dice-d20', title: '把剧情拆成可游玩的分段脚本并推进' },
    { id: 'chars', label: '角色', icon: 'fa-users', title: '识别出的候选角色与分级结果' },
    { id: 'settings', label: '设置', icon: 'fa-sliders', title: '模型、分卷、卡片与提示词参数' },
    { id: 'data', label: '存档与日志', icon: 'fa-box-archive', title: '进度存档与运行日志' },
];

function renderTabsHtml(active) {
    const buttons = PANEL_TABS.map(tab => `
      <div class="n2c-tab${tab.id === active ? ' n2c-tab-active' : ''}"
           data-tab="${tab.id}" title="${tab.title}" role="tab">
        <i class="fa-solid ${tab.icon}"></i><span>${tab.label}</span>
      </div>`).join('');
    return `<div class="n2c-tabs" role="tablist">${buttons}</div>`;
}

function renderPanelHtml() {
    const s = getSettings();
    const activeTab = state.activeTab || 'work';

    return `
<div id="n2c-panel" class="inline-drawer${s.pluginEnabled ? '' : ' n2c-off'}">
  <div class="inline-drawer-toggle inline-drawer-header n2c-head">
    <b>小说转角色卡</b>
    <div class="n2c-head-actions">
      <span class="n2c-disabled-badge" id="n2c-disabled-badge" style="${s.pluginEnabled ? 'display:none' : ''}">已关闭</span>
      <label class="checkbox_label n2c-master" title="关闭后扩展不响应任何操作，顶栏入口一并隐藏">
        <input type="checkbox" id="n2c-plugin-enabled" ${s.pluginEnabled ? 'checked' : ''}>
        <span>启用</span>
      </label>
      <div class="menu_button n2c-small" id="n2c-open-window" title="在独立浮动窗口中打开">
        <i class="fa-solid fa-up-right-and-down-left-from-center"></i>
      </div>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
  </div>
  <div class="inline-drawer-content">
    <div id="n2c-body" class="n2c-body">
      ${renderTabsHtml(activeTab)}

      <div class="n2c-tabpanes">
${renderTabWork(s)}
${renderTabStory(s)}
${renderTabChars(s)}
${renderTabSettings(s)}
${renderTabData(s)}
      </div>
    </div>
    <div id="n2c-drawer-slot" class="n2c-drawer-slot">
      <div class="n2c-hint">
        面板已在独立窗口中打开。
        <span class="menu_button n2c-small" id="n2c-slot-return">收回此处</span>
      </div>
    </div>
  </div>
</div>`;
}

/** 转换页：载入 → 分卷 → 执行 → 结果，一屏走完主流程 */
function renderTabWork(s) {
    return `
<div class="n2c-pane" data-pane="work">
  <div class="n2c-card">
    <div class="n2c-card-head"><i class="fa-solid fa-book"></i> 小说文本</div>
    <div class="n2c-row">
      <input type="text" id="n2c-title" class="text_pole n2c-grow" placeholder="作品名（可选，用于提示词）">
      <label class="n2c-file-btn menu_button" title="支持 .txt / .md / .jsonl">
        <i class="fa-solid fa-file-import"></i> 选择文件
        <input type="file" id="n2c-file" accept=".txt,.md,.jsonl,.text,text/plain" hidden>
      </label>
      <div class="menu_button n2c-icon-btn" id="n2c-clear-text" title="清空已载入的文本"><i class="fa-solid fa-trash-can"></i></div>
    </div>
    <textarea id="n2c-text" class="text_pole n2c-textarea" rows="5" placeholder="在此粘贴小说正文，或点上方选择文件"></textarea>
    <div class="n2c-hint" id="n2c-text-info">未载入文本</div>
  </div>

  <div class="n2c-card">
    <div class="n2c-card-head">
      <i class="fa-solid fa-scissors"></i> 分卷
      <label class="checkbox_label n2c-head-check" title="长篇强烈建议开启">
        <input type="checkbox" id="n2c-split-enabled" ${s.splitEnabled ? 'checked' : ''}><span>启用</span>
      </label>
    </div>
    <div class="n2c-row">
      <div class="menu_button n2c-primary n2c-small" id="n2c-preview-split"><i class="fa-solid fa-scissors"></i> 预览分卷</div>
      <div class="menu_button n2c-small" id="n2c-clear-split" style="display:none"><i class="fa-solid fa-xmark"></i> 取消分卷</div>
      <span class="n2c-hint-inline" id="n2c-split-summary"></span>
    </div>
    <div class="n2c-hint" id="n2c-split-info">尚未分卷。分卷后分析与生成只处理当前卷。</div>
    <div id="n2c-volume-list" class="n2c-volume-list"></div>
  </div>

  <div class="n2c-card n2c-card-actions">
    <div class="n2c-row n2c-row-actions">
      <div class="menu_button n2c-primary" id="n2c-analyze"><i class="fa-solid fa-user-magnifying-glass"></i> 分析人物</div>
      <div class="menu_button" id="n2c-generate"><i class="fa-solid fa-id-card"></i> 生成角色卡</div>
      <div class="menu_button n2c-small" id="n2c-make-world"><i class="fa-solid fa-book-atlas"></i> 只生成世界书</div>
      <div class="menu_button n2c-danger n2c-small" id="n2c-cancel" style="display:none"><i class="fa-solid fa-ban"></i> 中止</div>
    </div>
    <div class="n2c-progress"><div class="n2c-progress-bar" id="n2c-progress-bar"></div></div>
    <div class="n2c-hint" id="n2c-progress-text"></div>
  </div>

  <div class="n2c-card">
    <div class="n2c-card-head"><i class="fa-solid fa-id-card"></i> 生成结果 <span class="n2c-count" id="n2c-result-count"></span></div>
    <div id="n2c-results" class="n2c-results"><div class="n2c-hint">尚未生成任何角色卡。</div></div>
  </div>
</div>`;
}

/** 剧情页：把剧情拆成可游玩的分段脚本，并在这里推进 */
function renderTabStory(s) {
    return `
<div class="n2c-pane" data-pane="story">

  <div class="n2c-card">
    <div class="n2c-card-head"><i class="fa-solid fa-dice-d20"></i> 生成剧情脚本</div>
    <div class="n2c-grid">
      <label class="n2c-field"><span>玩家扮演谁（留空由模型判断）</span>
        <input type="text" id="n2c-story-player" class="text_pole" placeholder="如：沈青梧" value="${escapeHtml(s.storyPlayerName)}"></label>
      <label class="n2c-field"><span>切成几段</span>
        <input type="number" id="n2c-story-nodes" class="text_pole" min="3" max="40" step="1" value="${s.storyNodeCount}"></label>
    </div>
    <div class="n2c-field n2c-field-wide"><span>文风要求（可选，写给开场白）</span>
      <input type="text" id="n2c-story-style" class="text_pole" placeholder="如：冷硬写实，短句，少形容词" value="${escapeHtml(s.storyStyle)}"></div>
    <div class="n2c-row">
      <div class="menu_button n2c-primary" id="n2c-story-build"><i class="fa-solid fa-book-open-reader"></i> 生成剧情脚本</div>
      <div class="menu_button n2c-small" id="n2c-story-worldbook"><i class="fa-solid fa-book-atlas"></i> 导出为世界书</div>
      <div class="menu_button n2c-small" id="n2c-story-card"><i class="fa-solid fa-id-card"></i> 生成玩家角色卡</div>
    </div>
    <div class="n2c-hint">脚本按当前页/卷的文本生成。源文本在「转换」页载入；分卷后生成的就是当前卷的剧情。</div>
  </div>

  <div class="n2c-card">
    <div class="n2c-card-head">
      <i class="fa-solid fa-gamepad"></i> 游玩控制
      <label class="checkbox_label n2c-head-check" title="开启后每回合自动把当前剧情段注入对话">
        <input type="checkbox" id="n2c-story-active" ${s.storyActive ? 'checked' : ''}><span>注入剧情</span>
      </label>
    </div>
    <div class="n2c-row">
      <div class="menu_button n2c-primary n2c-small" id="n2c-story-start"><i class="fa-solid fa-play"></i> 开始游玩</div>
      <div class="menu_button n2c-small" id="n2c-story-stop" style="display:none"><i class="fa-solid fa-stop"></i> 停止注入</div>
    </div>
    <div id="n2c-story-progress" class="n2c-story-progress"></div>
    <div class="n2c-checks">
      <label class="checkbox_label"><input type="checkbox" id="n2c-story-auto-advance" ${s.storyAutoAdvance ? 'checked' : ''}><span>模型说演完就自动推进</span></label>
      <label class="checkbox_label"><input type="checkbox" id="n2c-story-auto-report" ${s.storyAutoReport !== false ? 'checked' : ''}><span>自动读回状态变化</span></label>
    </div>
    <div class="n2c-grid">
      <label class="n2c-field"><span>注入深度（越小越靠后）</span>
        <input type="number" id="n2c-story-depth" class="text_pole" min="0" max="30" step="1" value="${s.storyInjectDepth}"></label>
    </div>
    <div class="n2c-hint">注入只在本地生效：不改角色卡、不写聊天记录，关掉开关就恢复原样。进度按聊天分别保存。</div>
  </div>

  <div class="n2c-card">
    <div class="n2c-card-head"><i class="fa-solid fa-scroll"></i> 开场白</div>
    <div id="n2c-story-opening" class="n2c-story-opening"></div>
  </div>
</div>`;
}

/** 角色页：候选列表 + 分级 */
function renderTabChars(s) {
    return `
<div class="n2c-pane" data-pane="chars">
  <div class="n2c-card">
    <div class="n2c-card-head">
      <i class="fa-solid fa-users"></i> 候选角色
      <div class="n2c-card-actions">
        <div class="menu_button n2c-small" id="n2c-classify" title="让模型判定谁是主角、谁是配角">
          <i class="fa-solid fa-ranking-star"></i> 判定主角/配角
        </div>
      </div>
    </div>
    <div class="n2c-hint" id="n2c-tier-summary">还没有识别结果，请先到「转换」页点「分析人物」。</div>
    <div id="n2c-chars" class="n2c-chars"></div>
  </div>
</div>`;
}

/** 设置页：每类参数一张卡片，独立 API 单独成块 */
function renderTabSettings(s) {
    return `
<div class="n2c-pane" data-pane="settings">

  <div class="n2c-card">
    <div class="n2c-card-head"><i class="fa-solid fa-plug"></i> 模型来源</div>
    <div class="n2c-row">
      <label class="n2c-field n2c-grow"><span>用哪个通道分析</span>
        <select id="n2c-api-client" class="text_pole">
          <option value="tavern" ${s.apiClient === 'tavern' ? 'selected' : ''}>酒馆当前连接</option>
          <option value="custom" ${s.apiClient === 'custom' ? 'selected' : ''}>独立 API（自己填地址和模型）</option>
        </select></label>
    </div>

    <div id="n2c-api-config" class="n2c-api-config">
      <div class="n2c-api-grid">
        <label class="n2c-field n2c-field-wide2"><span>接口地址</span>
          <input type="text" id="n2c-api-url" class="text_pole" placeholder="https://api.deepseek.com/v1" value="${escapeHtml(s.apiUrl)}"></label>
        <label class="n2c-field"><span>模型名</span>
          <div class="n2c-row n2c-row-tight">
            <select id="n2c-api-model-select" class="text_pole n2c-grow">${renderModelOptions()}</select>
            <div class="menu_button n2c-small n2c-icon-btn" id="n2c-api-models" title="从接口拉取可用模型列表">
              <i class="fa-solid fa-list"></i>
            </div>
          </div>
        </label>
        <label class="n2c-field n2c-field-wide2"><span>API Key</span>
          <input type="password" id="n2c-api-key" class="text_pole" placeholder="sk-..." value="${escapeHtml(s.apiKey)}"></label>
        <label class="n2c-field"><span>temperature</span>
          <input type="number" id="n2c-api-temperature" class="text_pole" min="0" max="2" step="0.1" placeholder="默认" value="${escapeHtml(s.apiTemperature)}"></label>
        <label class="n2c-field"><span>top_p</span>
          <input type="number" id="n2c-api-top-p" class="text_pole" min="0" max="1" step="0.05" placeholder="默认" value="${escapeHtml(s.apiTopP)}"></label>
      </div>
      <div class="n2c-row">
        <label class="checkbox_label"><input type="checkbox" id="n2c-api-stream" ${s.apiStream ? 'checked' : ''}><span>流式请求</span></label>
        <label class="checkbox_label"><input type="checkbox" id="n2c-api-manual-model" ${s.apiManualModel ? 'checked' : ''}><span>手动输入模型名</span></label>
        <div class="menu_button n2c-small" id="n2c-api-test"><i class="fa-solid fa-plug-circle-check"></i> 测试连接</div>
      </div>
      <label class="n2c-field n2c-field-wide" id="n2c-api-manual-wrap" style="${s.apiManualModel ? '' : 'display:none'}">
        <span>手动模型名（接口不支持列模型时用）</span>
        <input type="text" id="n2c-api-model" class="text_pole" placeholder="deepseek-chat" value="${escapeHtml(s.apiModel)}">
      </label>
      <div class="n2c-hint" id="n2c-api-test-result"></div>
      <div class="n2c-hint">点右侧列表按钮可从接口拉取可用模型，免去手打。地址填到版本段即可（如 <code>https://api.deepseek.com/v1</code>），服务端会自己拼 <code>/chat/completions</code>。请求经酒馆后端转发，与普通生成同源；Key 只存在本地设置里。</div>
    </div>
  </div>

  <div class="n2c-card">
    <div class="n2c-card-head"><i class="fa-solid fa-sliders"></i> 分析参数</div>
    <div class="n2c-grid">
      <label class="n2c-field"><span>分段字数</span>
        <input type="number" id="n2c-chunk-chars" class="text_pole" min="1500" max="20000" step="500" value="${s.chunkChars}"></label>
      <label class="n2c-field"><span>请求并发</span>
        <input type="number" id="n2c-concurrency" class="text_pole" min="1" max="8" step="1" value="${s.concurrency}"></label>
      <label class="n2c-field"><span>最多角色数</span>
        <input type="number" id="n2c-max-chars" class="text_pole" min="1" max="40" step="1" value="${s.maxCharacters}"></label>
      <label class="n2c-field"><span>每角色证据段数</span>
        <input type="number" id="n2c-evidence" class="text_pole" min="1" max="20" step="1" value="${s.evidenceChunks}"></label>
    </div>
  </div>

  <div class="n2c-card">
    <div class="n2c-card-head"><i class="fa-solid fa-scissors"></i> 分卷参数</div>
    <div class="n2c-grid">
      <label class="n2c-field"><span>分卷方式</span>
        <select id="n2c-split-mode" class="text_pole">
          <option value="auto" ${s.splitMode === 'auto' ? 'selected' : ''}>按每卷字数</option>
          <option value="count" ${s.splitMode === 'count' ? 'selected' : ''}>按固定卷数</option>
        </select></label>
      <label class="n2c-field" id="n2c-split-count-field"><span>卷数</span>
        <input type="number" id="n2c-volume-count" class="text_pole" min="1" max="200" step="1" value="${s.volumeCount}"></label>
      <label class="n2c-field" id="n2c-split-size-field"><span>每卷字数</span>
        <input type="number" id="n2c-chars-per-volume" class="text_pole" min="1000" max="3000000" step="10000" value="${s.charsPerVolume}"></label>
    </div>
    <label class="checkbox_label"><input type="checkbox" id="n2c-split-by-chapter" ${s.splitByChapter ? 'checked' : ''}><span>优先按章节边界切（不切在句子中间）</span></label>
  </div>

  <div class="n2c-card">
    <div class="n2c-card-head"><i class="fa-solid fa-ranking-star"></i> 角色分级</div>
    <div class="n2c-row">
      <label class="checkbox_label"><input type="checkbox" id="n2c-tier-enabled" ${s.tierEnabled ? 'checked' : ''}><span>区分主角与配角</span></label>
      <label class="checkbox_label"><input type="checkbox" id="n2c-brief-supporting" ${s.briefSupporting ? 'checked' : ''}><span>配角用精简档案</span></label>
    </div>
    <div class="n2c-grid">
      <label class="n2c-field"><span>主角最多几个</span>
        <input type="number" id="n2c-max-protagonists" class="text_pole" min="1" max="20" step="1" value="${s.maxProtagonists}"></label>
      <label class="n2c-field"><span>配角最多几个</span>
        <input type="number" id="n2c-max-supporting" class="text_pole" min="0" max="40" step="1" value="${s.maxSupporting}"></label>
    </div>
    <div class="n2c-hint">按「主角 → 主要配角 → 次要配角」排序，各自按上限取用。配角用精简档案能省一半输出 token。</div>
  </div>

  <div class="n2c-card">
    <div class="n2c-card-head"><i class="fa-solid fa-id-card"></i> 卡片输出</div>
    <div class="n2c-grid">
      <label class="n2c-field"><span>角色卡版本</span>
        <select id="n2c-card-version" class="text_pole">
          <option value="3" ${s.cardVersion === '3' ? 'selected' : ''}>V3（推荐）</option>
          <option value="2" ${s.cardVersion === '2' ? 'selected' : ''}>V2</option>
          <option value="both" ${s.cardVersion === 'both' ? 'selected' : ''}>两者都要</option>
        </select></label>
      <label class="n2c-field"><span>头像最长边(px)</span>
        <input type="number" id="n2c-avatar-size" class="text_pole" min="128" max="1024" step="64" value="${s.avatarMaxSize}"></label>
      <label class="n2c-field"><span>世界书条目上限</span>
        <input type="number" id="n2c-world-count" class="text_pole" min="0" max="60" step="1" value="${s.worldEntryCount}"></label>
    </div>
    <div class="n2c-checks">
      <label class="checkbox_label"><input type="checkbox" id="n2c-with-world" ${s.withWorldBook ? 'checked' : ''}><span>提取世界书</span></label>
      <label class="checkbox_label"><input type="checkbox" id="n2c-embed-world" ${s.embedWorldBook ? 'checked' : ''}><span>世界书内嵌进卡</span></label>
      <label class="checkbox_label"><input type="checkbox" id="n2c-save-world-file" ${s.saveWorldBookFile ? 'checked' : ''}><span>导出世界书 JSON</span></label>
      <label class="checkbox_label"><input type="checkbox" id="n2c-import" ${s.importToTavern ? 'checked' : ''}><span>自动导入角色列表</span></label>
      <label class="checkbox_label"><input type="checkbox" id="n2c-placeholder" ${s.placeholderAvatar ? 'checked' : ''}><span>生成占位头像</span></label>
      <label class="checkbox_label"><input type="checkbox" id="n2c-resize-avatar" ${s.resizeAvatar ? 'checked' : ''}><span>缩放并重建底图</span></label>
      <label class="checkbox_label"><input type="checkbox" id="n2c-auto-tag" ${s.autoTag ? 'checked' : ''}><span>自动写入标签</span></label>
    </div>
    <div class="n2c-field n2c-field-wide"><span>底图（可选，作为所有角色卡的初始头像）</span>
      <div class="n2c-row">
        <label class="n2c-file-btn menu_button n2c-small"><i class="fa-solid fa-image"></i> 选择图片
          <input type="file" id="n2c-avatar-file" accept="image/*" hidden></label>
        <div class="menu_button n2c-small" id="n2c-avatar-clear"><i class="fa-solid fa-xmark"></i> 清除</div>
        <span class="n2c-hint" id="n2c-avatar-info">未选择</span>
      </div>
    </div>
    <div class="n2c-field n2c-field-wide"><span>作者署名 / 版本号</span>
      <div class="n2c-row">
        <input type="text" id="n2c-creator" class="text_pole n2c-grow" value="${escapeHtml(s.creatorName)}">
        <input type="text" id="n2c-version-tag" class="text_pole" style="max-width:110px" value="${escapeHtml(s.cardVersionTag)}">
      </div>
    </div>
    <div class="n2c-row">
      <div class="menu_button n2c-small" id="n2c-read-card"><i class="fa-solid fa-file-shield"></i> 读取已有角色卡 PNG 作为底图</div>
      <input type="file" id="n2c-card-file" accept=".png,image/png" hidden>
    </div>
  </div>

  <div class="n2c-card">
    <div class="n2c-card-head"><i class="fa-solid fa-comment-dots"></i> 额外提示词</div>
    <textarea id="n2c-instruction" class="text_pole n2c-textarea" rows="3" placeholder="例如：保留原著的口癖；主角的性别按原文推断，不要默认男性">${escapeHtml(s.extraInstruction)}</textarea>
    <div class="n2c-hint">会追加到每个角色的提取要求里。</div>
  </div>
</div>`;
}

/** 存档与日志页 */
function renderTabData(s) {
    return `
<div class="n2c-pane" data-pane="data">
  <div class="n2c-card">
    <div class="n2c-card-head">
      <i class="fa-solid fa-floppy-disk"></i> 存档与进度
      <div class="n2c-card-actions">
        <label class="checkbox_label n2c-head-check"><input type="checkbox" id="n2c-autosave" ${s.autoSave ? 'checked' : ''}><span>自动存档</span></label>
        <div class="menu_button n2c-small" id="n2c-save-now"><i class="fa-solid fa-floppy-disk"></i> 立即存档</div>
        <div class="menu_button n2c-small n2c-icon-btn" id="n2c-refresh-saves" title="刷新列表"><i class="fa-solid fa-rotate"></i></div>
      </div>
    </div>
    <div class="n2c-row">
      <input type="text" id="n2c-save-name" class="text_pole n2c-grow" placeholder="存档名（留空自动取名）">
    </div>
    <div class="n2c-hint" id="n2c-save-info">进度存在浏览器 IndexedDB 里，重开酒馆后可从这里恢复。</div>
    <div id="n2c-save-list" class="n2c-save-list"></div>
  </div>

  <div class="n2c-card">
    <div class="n2c-card-head">
      <i class="fa-solid fa-terminal"></i> 运行日志
      <div class="n2c-card-actions">
        <div class="menu_button n2c-small" id="n2c-clear-log">清空</div>
      </div>
    </div>
    <div id="n2c-log" class="n2c-log"></div>
  </div>
</div>`;
}

/** 切换标签页 */
function switchTab(tabId) {
    state.activeTab = tabId;
    const panel = $id('n2c-panel');
    if (!panel) return;
    for (const tab of panel.querySelectorAll('.n2c-tab')) {
        tab.classList.toggle('n2c-tab-active', tab.dataset.tab === tabId);
    }
    for (const pane of panel.querySelectorAll('.n2c-pane')) {
        pane.classList.toggle('n2c-pane-active', pane.dataset.pane === tabId);
    }
}

/** 按初始状态摆好标签页（HTML 里所有面板都在，靠类控制显隐） */
function initTabs() {
    switchTab(state.activeTab || 'work');
}

function mountPanel() {
    const host = $id('extensions_settings') || $id('extensions_settings2');
    if (!host) {
        console.warn('[小说转角色卡] 找不到扩展设置容器，面板未挂载');
        return false;
    }
    if ($id('n2c-panel')) return true;

    host.insertAdjacentHTML('beforeend', renderPanelHtml());
    state.panelBody = $id('n2c-body');
    bindPanelEvents();
    bindPanelHeaderEvents();
    initTabs();
    mountTopbarDrawer();
    applyEnabledState();
    bindStoryRuntime();
    renderCharacterList();
    updateTextInfo();
    renderStoryProgress();
    renderStoryOpening();
    renderSaveList().catch(() => {});
    maybeOfferRestore();

    // 独立窗口是常驻的：上次开了窗口就照原位置恢复
    const settings = getSettings();
    if (settings.useFloatingWindow) {
        openFloatingWindow();
    } else {
        setupDrawerSlot();
    }
    return true;
}

/** 抽屉内留一个槽位：主体被搬到独立窗口后，这里显示一句说明和回来的按钮 */
function setupDrawerSlot() {
    const slot = $id('n2c-drawer-slot');
    if (!slot) return;
    if ($id('n2c-slot-return')) {
        // 已经绑过就不再重复绑定
        if (!slot._n2cBound) {
            slot._n2cBound = true;
            $id('n2c-slot-return')?.addEventListener('click', () => {
                if (state.winEl) closeFloatingWindow();
                else setupDrawerSlot();
            });
        }
    }
    syncDrawerSlotVisibility();
}

/** 主体在抽屉里时隐藏提示，搬走了才显示 */
function syncDrawerSlotVisibility() {
    const slot = $id('n2c-drawer-slot');
    if (!slot) return;
    const body = state.panelBody || $id('n2c-body');
    const bodyInDrawer = !!(body && slot.parentNode && body.parentNode === slot.parentNode);
    slot.classList.toggle('n2c-slot-hidden', bodyInDrawer);
}

/** 把面板主体在「扩展设置里」和「独立窗口」之间搬移 */
function movePanelBody(target) {
    const body = state.panelBody || $id('n2c-body');
    if (!body || !target) return;
    state.panelBody = body;
    if (body.parentNode === target) return;
    target.appendChild(body);
}

function exitFloatingWindow() {
    const s = getSettings();
    s.useFloatingWindow = false;
    putSettings();
    if (state.winEl) {
        state.winEl.remove();
        state.winEl = null;
    }
    const slot = $id('n2c-drawer-slot');
    if (slot) movePanelBody(slot);
    syncDrawerSlotVisibility();
    log('已退回扩展设置面板');
}

function openFloatingWindow() {
    const s = getSettings();
    s.useFloatingWindow = true;
    putSettings();
    closeFloatingWindow({ keepState: true });

    const win = document.createElement('div');
    win.id = 'n2c-window';
    win.className = 'n2c-window';
    win.insertAdjacentHTML('beforeend', `
      <div class="n2c-window-head" id="n2c-window-head">
        <span class="n2c-window-title"><i class="fa-solid fa-id-card"></i> 小说转角色卡</span>
        <div class="n2c-window-actions">
          <div class="n2c-win-btn" id="n2c-window-dock" title="收回扩展设置面板"><i class="fa-solid fa-down-left-and-up-right-to-center"></i></div>
          <div class="n2c-win-btn" id="n2c-window-close" title="关闭窗口"><i class="fa-solid fa-xmark"></i></div>
        </div>
      </div>
      <div class="n2c-window-body" id="n2c-window-body"></div>`);

    document.body.appendChild(win);
    state.winEl = win;

    const viewportWidth = window.innerWidth || 1280;
    const viewportHeight = window.innerHeight || 800;
    const width = Math.max(320, Math.min(Number(s.winW) || 420, viewportWidth - 40));
    const height = Math.max(320, Math.min(Number(s.winH) || 620, viewportHeight - 40));
    const left = Number.isFinite(s.winX) && s.winX !== null
        ? Math.max(0, Math.min(s.winX, viewportWidth - width))
        : Math.max(0, viewportWidth - width - 24);
    const top = Number.isFinite(s.winY) && s.winY !== null
        ? Math.max(0, Math.min(s.winY, viewportHeight - height))
        : 64;

    // 移动端/桌面端都用原生 style，避免依赖 jQuery 的 css() 语义
    win.style.left = `${left}px`;
    win.style.top = `${top}px`;
    win.style.width = `${width}px`;
    win.style.height = `${height}px`;

    movePanelBody($id('n2c-window-body'));
    syncDrawerSlotVisibility();
    win.querySelector('#n2c-window-dock')?.addEventListener('click', () => exitFloatingWindow());
    win.querySelector('#n2c-window-close')?.addEventListener('click', () => closeFloatingWindow());
    bindWindowDrag(win);
}

function closeFloatingWindow({ keepState = false } = {}) {
    if (state.winEl) {
        state.winEl.remove();
        state.winEl = null;
    }
    if (!keepState) {
        const s = getSettings();
        s.useFloatingWindow = false;
        putSettings();
        const slot = $id('n2c-drawer-slot');
        if (slot) movePanelBody(slot);
        syncDrawerSlotVisibility();
        log('已关闭独立窗口');
    }
}

function bindWindowDrag(win) {
    const head = win.querySelector('#n2c-window-head');
    if (!head) return;

    const onDown = event => {
        if (event.target.closest('.n2c-win-btn')) return;
        const rect = win.getBoundingClientRect
            ? win.getBoundingClientRect()
            : { left: parseFloat(win.style.left) || 0, top: parseFloat(win.style.top) || 0 };
        state.dragging = {
            offsetX: (event.clientX || 0) - rect.left,
            offsetY: (event.clientY || 0) - rect.top,
        };
        document.addEventListener?.('mousemove', onMove);
        document.addEventListener?.('mouseup', onUp);
        event.preventDefault?.();
    };

    const onMove = event => {
        if (!state.dragging) return;
        const width = parseFloat(win.style.width) || 420;
        const height = parseFloat(win.style.height) || 620;
        const maxX = Math.max(0, (window.innerWidth || 1280) - width);
        const maxY = Math.max(0, (window.innerHeight || 800) - height);
        const left = Math.max(0, Math.min((event.clientX || 0) - state.dragging.offsetX, maxX));
        const top = Math.max(0, Math.min((event.clientY || 0) - state.dragging.offsetY, maxY));
        win.style.left = `${left}px`;
        win.style.top = `${top}px`;
    };

    const onUp = () => {
        if (!state.dragging) return;
        state.dragging = null;
        document.removeEventListener?.('mousemove', onMove);
        document.removeEventListener?.('mouseup', onUp);
        const s = getSettings();
        s.winX = parseFloat(win.style.left) || 0;
        s.winY = parseFloat(win.style.top) || 0;
        putSettings();
    };

    head.addEventListener('mousedown', onDown);
}

/** 在顶栏加一个入口，方便用独立窗口而不是钻进扩展设置里找 */
function mountTopbarDrawer() {
    if ($id('n2c-drawer-icon')) return;
    const anchor = document.querySelector('.drawer-icon.fa-solid.fa-cubes');
    const drawer = anchor?.closest?.('.drawer');
    if (!drawer || !drawer.parentNode) return;

    const wrapper = document.createElement('div');
    wrapper.id = 'n2c-drawer';
    wrapper.className = 'drawer';
    wrapper.innerHTML = `
      <div class="drawer-toggle">
        <div id="n2c-drawer-icon" class="drawer-icon fa-solid fa-id-card fa-fw closedIcon interactable"
             title="小说转角色卡：把小说正文提取成角色卡" tabindex="0"></div>
      </div>`;

    drawer.parentNode.insertBefore(wrapper, drawer);
    wrapper.querySelector('#n2c-drawer-icon')?.addEventListener('click', () => {
        if (!getSettings().pluginEnabled) {
            toast('warn', '插件已关闭，请先在扩展设置里启用');
            return;
        }
        if (state.winEl) closeFloatingWindow();
        else openFloatingWindow();
    });
}

/**
 * 主开关：关掉后面板置灰、按钮不响应，顶栏入口整块消失。
 *
 * 顶栏隐藏的是整个 drawer 容器而不是里面的图标——酒馆的 drawer 结构里
 * 图标外面还包着 .drawer-toggle，只藏图标会在顶栏留一块空白占位。
 * 不做 remove()：重新启用时直接去掉 display 就能恢复，且不用重绑事件。
 */
function applyEnabledState() {
    const s = getSettings();
    const enabled = s.pluginEnabled !== false;

    const panel = $id('n2c-panel');
    if (panel) panel.classList.toggle('n2c-off', !enabled);

    const drawer = $id('n2c-drawer');
    if (drawer) drawer.style.display = enabled ? '' : 'none';

    const drawerIcon = $id('n2c-drawer-icon');
    if (drawerIcon) {
        drawerIcon.classList.toggle('n2c-icon-off', !enabled);
        drawerIcon.title = enabled
            ? '小说转角色卡：把小说正文提取成角色卡'
            : '小说转角色卡（已关闭）';
    }

    const badge = $id('n2c-disabled-badge');
    if (badge) badge.style.display = enabled ? 'none' : '';

    // 关闭时顺手把浮窗收掉，避免留一个不能操作的窗口
    if (!enabled && state.winEl) closeFloatingWindow();
}

function isPluginEnabled() {
    return getSettings().pluginEnabled !== false;
}

/** 所有动作入口统一挡一道，避免关掉插件后仍被旧按钮触发 */
function requireEnabled() {
    if (!isPluginEnabled()) {
        toast('warn', '插件已关闭，请先在面板顶部勾选「启用」');
        return false;
    }
    return true;
}

function bindPanelHeaderEvents() {
    $id('n2c-plugin-enabled')?.addEventListener('change', event => {
        const s = getSettings();
        s.pluginEnabled = event.target.checked;
        putSettings();
        applyEnabledState();
        log(s.pluginEnabled ? '插件已启用' : '插件已关闭');
        if (s.pluginEnabled) renderSaveList().catch(() => {});
    });

    $id('n2c-open-window')?.addEventListener('click', () => {
        if (!requireEnabled()) return;
        openFloatingWindow();
    });

    // 标签页：事件委托到面板容器，切页后无需重绑
    const panel = $id('n2c-panel');
    panel?.addEventListener('click', event => {
        const tab = event.target?.closest?.('.n2c-tab');
        if (!tab || !panel.contains(tab)) return;
        switchTab(tab.dataset.tab);
    });

    initApiControls();
}

// ================================================================
// 事件绑定
// ================================================================

/** 分卷结果依赖这些参数；改动后旧结果失效，必须重新预览，否则会拿错卷跑 */
function invalidateSplit(reason) {
    if (!state.volumes.length) return;
    state.volumes = [];
    state.volumeIndex = 0;
    state.volumeWarnings = [];
    state.chunks = [];
    state._chunkSource = '';
    renderVolumeList();
    updateTextInfo();
    log(`「${reason}」已改动，之前的分卷结果已失效，请重新点「预览分卷」`, 'warn');
}

function bindNumber(id, key, { min, max, invalidates } = {}) {
    $id(id)?.addEventListener('input', event => {
        let value = Number(event.target.value);
        if (!Number.isFinite(value)) return;
        if (min !== undefined) value = Math.max(min, value);
        if (max !== undefined) value = Math.min(max, value);
        getSettings()[key] = value;
        putSettings();
        if (invalidates) invalidateSplit(invalidates);
    });
}

function bindPanelEvents() {
    const s = getSettings();

    $id('n2c-file')?.addEventListener('change', async event => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        try {
            const text = await readFileAsText(file);
            state.rawText = text;
            if (!state.novelTitle) {
                state.novelTitle = file.name.replace(/\.[^.]+$/, '');
                const titleInput = $id('n2c-title');
                if (titleInput) titleInput.value = state.novelTitle;
            }
            const textarea = $id('n2c-text');
            if (textarea) textarea.value = text.length > 200_000 ? text.slice(0, 200_000) : text;
            updateTextInfo();
            log(`已载入《${file.name}》，${text.length.toLocaleString()} 字`);
            if (text.length > 200_000) {
                log('文本超过 20 万字，输入框只显示前 20 万字，但分析仍使用完整文本', 'warn');
            }
        } catch (error) {
            toast('error', `读取文件失败：${error.message}`);
        }
    });

    $id('n2c-text')?.addEventListener('input', event => {
        const value = event.target.value;
        // 输入框内容变化时以输入框为准（用户在框里编辑过）
        state.rawText = value;
        updateTextInfo();
    });

    $id('n2c-title')?.addEventListener('input', event => {
        state.novelTitle = event.target.value.trim();
    });

    $id('n2c-clear-text')?.addEventListener('click', () => {
        state.rawText = '';
        state.chunks = [];
        const textarea = $id('n2c-text');
        if (textarea) textarea.value = '';
        updateTextInfo();
        log('已清空文本');
    });

    $id('n2c-avatar-file')?.addEventListener('change', async event => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        try {
            state.darkImage = await readFileAsBytes(file);
            state.darkImageName = file.name;
            const info = $id('n2c-avatar-info');
            if (info) info.textContent = `${file.name}（${(file.size / 1024).toFixed(0)} KB）`;
            const card = readCardFromPng(state.darkImage);
            if (card) {
                log(`注意：所选底图本身是一张角色卡（${card?.data?.name || card?.name || '未知'}），导出时会用新卡数据覆盖`, 'warn');
            }
        } catch (error) {
            toast('error', `读取图片失败：${error.message}`);
        }
    });

    $id('n2c-avatar-clear')?.addEventListener('click', () => {
        state.darkImage = null;
        state.darkImageName = '';
        const info = $id('n2c-avatar-info');
        if (info) info.textContent = '未选择';
    });

    $id('n2c-analyze')?.addEventListener('click', () => runAnalyze());
    $id('n2c-generate')?.addEventListener('click', () => runGenerate());
    $id('n2c-make-world')?.addEventListener('click', () => runWorldOnly());
    $id('n2c-cancel')?.addEventListener('click', () => {
        state.abort?.abort();
        log('已请求中止', 'warn');
    });

    $id('n2c-clear-log')?.addEventListener('click', () => {
        state.logLines = [];
        const box = $id('n2c-log');
        if (box) box.innerHTML = '';
    });

    $id('n2c-read-card')?.addEventListener('click', () => $id('n2c-card-file')?.click());
    $id('n2c-card-file')?.addEventListener('change', async event => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        try {
            const bytes = await readFileAsBytes(file);
            const card = readCardFromPng(bytes);
            if (!card) {
                toast('warn', '这张 PNG 里没有 chara / ccv3 区块，不是角色卡');
                return;
            }
            const data = card.data || card;
            log(`读取到角色卡：${data.name || '未命名'}（规范 ${card.spec || '未知'}）`);
            toast('success', `读到「${data.name || '未命名'}」，已把底图设为导出头像`);
            state.darkImage = bytes;
            state.darkImageName = file.name;
            const info = $id('n2c-avatar-info');
            if (info) info.textContent = `${file.name}（来自已有卡）`;
        } catch (error) {
            toast('error', `读取失败：${error.message}`);
        }
    });

    bindNumber('n2c-chunk-chars', 'chunkChars', { min: 1500, max: 20000, invalidates: '分段字数' });
    bindNumber('n2c-concurrency', 'concurrency', { min: 1, max: 8 });
    bindNumber('n2c-max-chars', 'maxCharacters', { min: 1, max: 40 });
    bindNumber('n2c-evidence', 'evidenceChunks', { min: 1, max: 20 });
    bindNumber('n2c-avatar-size', 'avatarMaxSize', { min: 128, max: 1024 });
    bindNumber('n2c-world-count', 'worldEntryCount', { min: 0, max: 60 });

    $id('n2c-card-version')?.addEventListener('change', event => {
        s.cardVersion = event.target.value;
        putSettings();
    });

    for (const [id, key] of [
        ['n2c-with-world', 'withWorldBook'],
        ['n2c-embed-world', 'embedWorldBook'],
        ['n2c-save-world-file', 'saveWorldBookFile'],
        ['n2c-import', 'importToTavern'],
        ['n2c-placeholder', 'placeholderAvatar'],
        ['n2c-resize-avatar', 'resizeAvatar'],
        ['n2c-auto-tag', 'autoTag'],
    ]) {
        $id(id)?.addEventListener('change', event => {
            s[key] = event.target.checked;
            putSettings();
        });
    }

    $id('n2c-instruction')?.addEventListener('input', event => {
        s.extraInstruction = event.target.value;
        if (state._instructionTimer) clearTimeout(state._instructionTimer);
        state._instructionTimer = setTimeout(putSettings, 500);
    });

    $id('n2c-creator')?.addEventListener('input', event => {
        s.creatorName = event.target.value;
        if (state._creatorTimer) clearTimeout(state._creatorTimer);
        state._creatorTimer = setTimeout(putSettings, 500);
    });

    $id('n2c-version-tag')?.addEventListener('input', event => {
        s.cardVersionTag = event.target.value;
        if (state._versionTimer) clearTimeout(state._versionTimer);
        state._versionTimer = setTimeout(putSettings, 500);
    });

    bindNumber('n2c-volume-count', 'volumeCount', { min: 1, max: 200, invalidates: '卷数' });
    bindNumber('n2c-chars-per-volume', 'charsPerVolume', { min: 1000, max: 3_000_000, invalidates: '每卷字数' });
    bindNumber('n2c-max-protagonists', 'maxProtagonists', { min: 1, max: 20 });
    bindNumber('n2c-max-supporting', 'maxSupporting', { min: 0, max: 40 });

    // ---- 独立 API
    $id('n2c-api-client')?.addEventListener('change', event => {
        s.apiClient = event.target.value;
        putSettings();
        syncApiConfigVisibility();
    });

    const bindApiText = (id, key) => {
        $id(id)?.addEventListener('input', event => {
            s[key] = event.target.value;
            if (state._apiTimer) clearTimeout(state._apiTimer);
            state._apiTimer = setTimeout(putSettings, 500);
        });
    };
    bindApiText('n2c-api-url', 'apiUrl');
    bindApiText('n2c-api-key', 'apiKey');
    bindApiText('n2c-api-temperature', 'apiTemperature');
    bindApiText('n2c-api-top-p', 'apiTopP');

    // 手动模型名：写回设置并同步下拉框，避免两处显示不一致
    $id('n2c-api-model')?.addEventListener('input', event => {
        s.apiModel = event.target.value;
        if (state._apiTimer) clearTimeout(state._apiTimer);
        state._apiTimer = setTimeout(putSettings, 500);
        refreshModelSelect(event.target.value);
    });

    $id('n2c-api-stream')?.addEventListener('change', event => {
        s.apiStream = event.target.checked;
        putSettings();
    });

    // 模型下拉框：选中的值写入 apiModel
    $id('n2c-api-model-select')?.addEventListener('change', event => {
        s.apiModel = event.target.value;
        putSettings();
        if (state._apiTimer) clearTimeout(state._apiTimer);
    });

    // 拉取模型列表
    $id('n2c-api-models')?.addEventListener('click', () => fetchModels());

    // 手动输入模型名
    $id('n2c-api-manual-model')?.addEventListener('change', event => {
        s.apiManualModel = event.target.checked;
        putSettings();
        syncApiManualVisibility();
    });

    $id('n2c-api-test')?.addEventListener('click', () => testApiConnection());

    // ---- 角色分级
    for (const [id, key] of [
        ['n2c-tier-enabled', 'tierEnabled'],
        ['n2c-brief-supporting', 'briefSupporting'],
    ]) {
        $id(id)?.addEventListener('change', event => {
            s[key] = event.target.checked;
            putSettings();
            renderCharacterList();
        });
    }

    $id('n2c-classify')?.addEventListener('click', () => runClassify());

    // ---- 存档
    $id('n2c-save-now')?.addEventListener('click', () => saveProgress());
    $id('n2c-refresh-saves')?.addEventListener('click', () => renderSaveList());
    $id('n2c-autosave')?.addEventListener('change', event => {
        s.autoSave = event.target.checked;
        putSettings();
    });

    // ---- 剧情推进器
    bindNumber('n2c-story-nodes', 'storyNodeCount', { min: 3, max: 40 });
    bindNumber('n2c-story-depth', 'storyInjectDepth', { min: 0, max: 30 });

    const bindStoryText = (id, key) => {
        $id(id)?.addEventListener('input', event => {
            getSettings()[key] = event.target.value;
            if (state._storyTimer) clearTimeout(state._storyTimer);
            state._storyTimer = setTimeout(putSettings, 500);
        });
    };
    bindStoryText('n2c-story-player', 'storyPlayerName');
    bindStoryText('n2c-story-style', 'storyStyle');

    $id('n2c-story-build')?.addEventListener('click', () => runStoryBuild());
    $id('n2c-story-worldbook')?.addEventListener('click', () => downloadStoryWorldBook());
    $id('n2c-story-card')?.addEventListener('click', () => createPlayerCard());
    $id('n2c-story-start')?.addEventListener('click', () => startStory());
    $id('n2c-story-stop')?.addEventListener('click', () => stopStory());

    // 「注入剧情」开关直接对应运行时开关
    $id('n2c-story-active')?.addEventListener('change', event => {
        getSettings().storyActive = event.target.checked;
        putSettings();
        if (event.target.checked) startStory();
        else stopStory();
    });

    for (const [id, key] of [
        ['n2c-story-auto-advance', 'storyAutoAdvance'],
        ['n2c-story-auto-report', 'storyAutoReport'],
    ]) {
        $id(id)?.addEventListener('change', event => {
            getSettings()[key] = event.target.checked;
            putSettings();
        });
    }

    syncApiConfigVisibility();

    // ---- 分卷相关
    $id('n2c-split-enabled')?.addEventListener('change', event => {
        s.splitEnabled = event.target.checked;
        putSettings();
        if (!s.splitEnabled) {
            state.volumes = [];
            state.volumeIndex = 0;
            state.volumeWarnings = [];
            renderVolumeList();
            updateTextInfo();
        } else {
            log('已启用分卷，记得点「预览分卷」确认切分结果');
        }
    });

    $id('n2c-split-by-chapter')?.addEventListener('change', event => {
        s.splitByChapter = event.target.checked;
        putSettings();
        invalidateSplit('按章节切分');
    });

    $id('n2c-split-mode')?.addEventListener('change', event => {
        s.splitMode = event.target.value;
        putSettings();
        syncSplitModeFields();
        invalidateSplit('分卷方式');
    });

    $id('n2c-preview-split')?.addEventListener('click', () => previewSplit());

    $id('n2c-clear-split')?.addEventListener('click', () => {
        state.volumes = [];
        state.volumeIndex = 0;
        state.volumeWarnings = [];
        renderVolumeList();
        updateTextInfo();
        log('已取消分卷，后续将处理全文');
    });

    syncSplitModeFields();
}

function updateTextInfo() {
    const info = $id('n2c-text-info');
    if (!info) return;
    const length = state.rawText?.length || 0;
    if (!length) {
        info.textContent = '未载入文本';
        return;
    }
    const chunks = estimateChunkCount(length);
    const splitNote = state.volumes.length
        ? ` · 已分 ${state.volumes.length} 卷，当前第 ${state.volumeIndex + 1} 卷（${state.volumes[state.volumeIndex]?.chars.toLocaleString() || 0} 字）`
        : '';
    info.textContent = `${length.toLocaleString()} 字 · 约 ${chunks} 段 · 人物扫描约 ${chunks} 次请求${splitNote}`;
}

// ================================================================
// 分卷
// ================================================================

/** 按分卷方式显示/隐藏对应的输入框 */
function syncSplitModeFields() {
    const s = getSettings();
    const countField = $id('n2c-split-count-field');
    const sizeField = $id('n2c-split-size-field');
    if (!countField || !sizeField) return;
    const isCount = s.splitMode === 'count';
    countField.style.display = isCount ? '' : 'none';
    sizeField.style.display = isCount ? 'none' : '';
}

/** 当前要处理的文本：分卷启用时只取当前卷 */
function activeText() {
    if (state.volumes.length) {
        const volume = state.volumes[state.volumeIndex];
        if (volume) return volume.body;
    }
    return String(state.rawText || '');
}

/** 分卷启用时给日志/卡片打上卷标记 */
function activeVolumeLabel() {
    if (!state.volumes.length) return '';
    const volume = state.volumes[state.volumeIndex];
    if (!volume) return '';
    return `${volume.label}${volume.title ? `「${volume.title}」` : ''}`;
}

function previewSplit() {
    if (!requireEnabled()) return;
    const s = getSettings();
    const text = String(state.rawText || '');
    if (!text.trim()) {
        toast('warn', '请先载入或粘贴小说文本');
        return;
    }

    if (!s.splitEnabled) {
        // 直接点预览就顺手把开关打开，省一次操作
        s.splitEnabled = true;
        putSettings();
        const checkbox = $id('n2c-split-enabled');
        if (checkbox) checkbox.checked = true;
    }

    const result = splitIntoVolumes(text, {
        mode: s.splitMode,
        volumeCount: Number(s.volumeCount),
        charsPerVolume: Number(s.charsPerVolume),
        byChapter: s.splitByChapter,
    });

    state.volumes = result.volumes;
    state.volumeIndex = 0;
    state.volumeWarnings = result.warnings;
    // 分卷内容变了，之前切好的段作废
    state.chunks = [];
    state._chunkSource = '';

    for (const warning of result.warnings) log(warning, 'warn');
    if (!result.volumes.length) {
        log('分卷失败：没有切出任何卷', 'error');
        renderVolumeList();
        return;
    }

    const chunkChars = Math.max(1500, Number(s.chunkChars) || 6000);
    const scanTotal = result.volumes.reduce(
        (sum, volume) => sum + estimateVolumeCost(volume.chars, chunkChars).scanRequests, 0);
    const largest = Math.max(...result.volumes.map(volume => volume.chars));
    const smallest = Math.min(...result.volumes.map(volume => volume.chars));

    log(`分卷完成：共 ${result.volumes.length} 卷，识别到 ${result.chapters} 个章标题`);
    log(`每卷 ${smallest.toLocaleString()}–${largest.toLocaleString()} 字；按 ${chunkChars} 字/段，全书扫描约 ${scanTotal} 次请求`);

    renderVolumeList();
    updateTextInfo();
    toast('success', `已分成 ${result.volumes.length} 卷`);
    autoSaveCheckpoint('分卷完成').catch(() => {});
}

function renderVolumeList() {
    const host = $id('n2c-volume-list');
    const info = $id('n2c-split-info');
    const summary = $id('n2c-split-summary');
    const clearButton = $id('n2c-clear-split');
    if (!host) return;

    if (!state.volumes.length) {
        host.innerHTML = '';
        if (summary) summary.textContent = '';
        if (info) {
            info.textContent = getSettings().splitEnabled
                ? '已启用分卷但还没预览。点「预览分卷」查看切分结果。'
                : '尚未分卷。分卷后分析与生成只处理当前卷。';
        }
        if (clearButton) clearButton.style.display = 'none';
        return;
    }

    const settings = getSettings();
    const chunkChars = Math.max(1500, Number(settings.chunkChars) || 6000);
    const totalChars = state.volumes.reduce((sum, volume) => sum + volume.chars, 0);
    const current = state.volumes[state.volumeIndex];

    if (summary) {
        summary.textContent = `共 ${state.volumes.length} 卷 / ${totalChars.toLocaleString()} 字`;
    }
    if (info) {
        info.textContent = current
            ? `当前：${current.label}${current.title ? `「${current.title}」` : ''}（${current.chars.toLocaleString()} 字）。点列表切换，分析生成只作用于当前卷。`
            : '点下面的列表切换当前卷。';
    }
    if (clearButton) clearButton.style.display = '';

    const rows = state.volumes.map((volume, index) => {
        const cost = estimateVolumeCost(volume.chars, chunkChars);
        const active = index === state.volumeIndex ? ' n2c-volume-active' : '';
        const done = volume._done ? '<span class="n2c-volume-done">已出卡</span>' : '';
        const cardCount = volume._cardCount ? `<span class="n2c-badge">${volume._cardCount} 张</span>` : '';
        return `
<div class="n2c-volume-row${active}" data-index="${index}">
  <span class="n2c-volume-no">${index + 1}</span>
  <span class="n2c-volume-title" title="${escapeHtml(volume.title)}">${escapeHtml(volume.title)}</span>
  <span class="n2c-volume-meta">${volume.chars.toLocaleString()} 字 · 约 ${cost.scanRequests} 次扫描</span>
  ${cardCount}${done}
</div>`;
    }).join('');

    host.innerHTML = rows;

    host.querySelectorAll('.n2c-volume-row').forEach(row => {
        row.addEventListener('click', () => {
            const index = Number(row.dataset.index);
            if (index === state.volumeIndex) return;
            switchVolume(index);
        });
    });
}

/** 切换当前卷：把已有结果清掉，避免上一卷的角色混进来 */
function switchVolume(index) {
    if (!state.volumes[index]) return;
    if (state.running) {
        toast('warn', '正在运行中，先等当前任务结束或点中止');
        return;
    }
    state.volumeIndex = index;
    state.chunks = [];
    state._chunkSource = '';
    state.characters = [];
    state.entries = [];
    renderCharacterList();
    renderVolumeList();
    updateTextInfo();
    const volume = state.volumes[index];
    log(`已切换到 ${volume.label}「${volume.title}」（${volume.chars.toLocaleString()} 字）`);
}

function estimateChunkCount(length) {
    const s = getSettings();
    const chunkChars = Math.max(1500, Number(s.chunkChars) || 6000);
    return Math.max(1, Math.ceil(length / chunkChars));
}

// ================================================================
// 角色列表渲染
// ================================================================

function renderCharacterList() {
    const host = $id('n2c-chars');
    if (!host) return;

    if (!state.characters.length) {
        host.innerHTML = '<div class="n2c-hint">还没有识别结果，先点「分析人物」。</div>';
        updateTierSummary();
        return;
    }

    const showTier = getSettings().tierEnabled;

    const rows = state.characters.map((character, index) => {
        const checked = character.selected !== false ? 'checked' : '';
        const confidence = character.profile?.confidence
            ? `<span class="n2c-badge n2c-badge-${escapeHtml(String(character.profile.confidence).toLowerCase())}">${escapeHtml(character.profile.confidence)}</span>`
            : '';
        const tierBadge = showTier && character.tier
            ? `<span class="n2c-tier n2c-tier-${tierClass(character.tier)}" title="${escapeHtml(character.tierReason || '')}">${escapeHtml(character.tier)}</span>`
            : '';
        return `
<div class="n2c-char-row" data-index="${index}">
  <label class="checkbox_label n2c-char-check"><input type="checkbox" class="n2c-char-toggle" ${checked}></label>
  <input type="text" class="text_pole n2c-char-name" value="${escapeHtml(character.name)}">
  <input type="text" class="text_pole n2c-char-role" value="${escapeHtml(character.role || '')}" placeholder="身份定位">
  <span class="n2c-char-meta">${character.chunkIndexes?.length || 0} 段出场 ${confidence}</span>
  ${tierBadge}
</div>`;
    }).join('');

    host.innerHTML = rows;

    host.querySelectorAll('.n2c-char-row').forEach(row => {
        const index = Number(row.dataset.index);
        row.querySelector('.n2c-char-toggle')?.addEventListener('change', event => {
            state.characters[index].selected = event.target.checked;
            updateTierSummary();
        });
        row.querySelector('.n2c-char-name')?.addEventListener('input', event => {
            state.characters[index].name = event.target.value;
        });
        row.querySelector('.n2c-char-role')?.addEventListener('input', event => {
            state.characters[index].role = event.target.value;
        });
    });

    updateTierSummary();
}

function tierClass(tier) {
    if (tier === '主角') return 'lead';
    if (tier === '次要配角') return 'minor';
    return 'support';
}

function selectedCharacters() {
    return state.characters.filter(character => character.selected !== false && String(character.name || '').trim());
}

// ================================================================
// 结果渲染
// ================================================================

function renderResults() {
    const host = $id('n2c-results');
    if (!host) return;

    const counter = $id('n2c-result-count');
    if (counter) counter.textContent = state.profiles.length ? `${state.profiles.length} 张` : '';

    if (!state.profiles.length) {
        host.innerHTML = '<div class="n2c-hint">尚未生成任何角色卡。</div>';
        return;
    }

    host.innerHTML = state.profiles.map((profile, index) => {
        const summary = profile._summary || summarizeCard(profile.cardV3 || profile.cardV2);
        const png = profile._pngBytes;
        const preview = png ? URL.createObjectURL(new Blob([png], { type: 'image/png' })) : '';
        const tierBadge = profile.tier
            ? `<span class="n2c-tier n2c-tier-${tierClass(profile.tier)}">${escapeHtml(profile.tier)}</span>`
            : '';
        return `
<div class="n2c-result" data-index="${index}">
  ${preview ? `<img class="n2c-result-avatar" src="${preview}" alt="${escapeHtml(summary.name)}">` : ''}
  <div class="n2c-result-body">
    <div class="n2c-result-name">${escapeHtml(summary.name)} ${tierBadge}</div>
    <div class="n2c-result-stats">
      正文 ${summary.total} 字 · 描述 ${summary.description} · 性格 ${summary.personality} ·
      场景 ${summary.scenario} · 开场白 ${summary.first_mes} · 示例 ${summary.mes_example}
      ${summary.bookEntries ? ` · 世界书 ${summary.bookEntries} 条` : ''}
    </div>
    <div class="n2c-result-actions">
      <div class="menu_button n2c-small n2c-download-png"><i class="fa-solid fa-download"></i> PNG 角色卡</div>
      <div class="menu_button n2c-small n2c-download-json"><i class="fa-solid fa-file-code"></i> 卡片 JSON</div>
      <div class="menu_button n2c-small n2c-import"><i class="fa-solid fa-file-import"></i> 导入角色列表</div>
    </div>
  </div>
</div>`;
    }).join('');

    host.querySelectorAll('.n2c-result').forEach(row => {
        const index = Number(row.dataset.index);
        const profile = state.profiles[index];
        row.querySelector('.n2c-download-png')?.addEventListener('click', () => downloadProfilePng(profile));
        row.querySelector('.n2c-download-json')?.addEventListener('click', () => {
            const card = profile.cardV3 || profile.cardV2;
            const blob = new Blob([JSON.stringify(card, null, 2)], { type: 'application/json' });
            downloadBlob(blob, `${safeFileName(profile.name)}.json`);
        });
        row.querySelector('.n2c-import')?.addEventListener('click', async () => {
            try {
                await importProfileToTavern(profile);
                toast('success', `已导入「${profile.name}」`);
            } catch (error) {
                toast('error', `导入失败：${error.message}`);
            }
        });
    });
}

function downloadProfilePng(profile) {
    if (!profile._pngBytes) {
        toast('warn', '这张卡还没有生成 PNG，先点「生成角色卡」');
        return;
    }
    downloadBytes(profile._pngBytes, `${safeFileName(profile.name)}.png`);
}

// ================================================================
// 中途保存 / 恢复
// ================================================================

/**
 * 抓取当前进度快照。
 * 注意不存 `_pngBytes`：那是二进制大对象，塞进 JSON 会让存档膨胀十倍以上，
 * 而且重开酒馆后大概率已经导入过角色列表，没必要留着。
 */
function snapshotState() {
    return {
        novelTitle: state.novelTitle,
        rawText: state.rawText,
        volumes: state.volumes.map(volume => ({
            index: volume.index,
            label: volume.label,
            title: volume.title,
            chars: volume.chars,
            start: volume.start,
            end: volume.end,
            body: volume.body,
            _cardCount: volume._cardCount,
            _done: volume._done,
        })),
        volumeIndex: state.volumeIndex,
        volumeWarnings: state.volumeWarnings,
        chunkChars: state._chunkChars || getSettings().chunkChars,
        characters: state.characters.map(character => ({
            name: character.name,
            aliases: character.aliases,
            role: character.role,
            screen_time: character.screen_time,
            chunkIndexes: character.chunkIndexes,
            score: character.score,
            selected: character.selected,
            tier: character.tier,
            tierReason: character.tierReason,
            profile: character.profile || null,
        })),
        profiles: state.profiles.map(profile => ({
            name: profile.name,
            role: profile.role,
            tier: profile.tier,
            cardV2: profile.cardV2,
            cardV3: profile.cardV3,
            _summary: profile._summary,
        })),
        entries: state.entries,
        logLines: state.logLines.slice(-120),
        // 剧情推进器：剧本与当前进度一起存，恢复后能接着演
        playbook: state.playbook,
        storyRuntime: state.runtime,
        storyActive: state.storyActive,
        storyOpening: state.storyOpening,
        savedAt: Date.now(),
    };
}

function clearChunkCache() {
    state.chunks = [];
    state._chunkSource = '';
}

/** 恢复快照；分卷正文会重新参与切段，所以只清缓存不丢数据 */
function applySnapshot(snapshot) {
    state.novelTitle = snapshot.novelTitle || '';
    state.rawText = snapshot.rawText || '';
    state.volumes = Array.isArray(snapshot.volumes) ? snapshot.volumes : [];
    state.volumeIndex = Number(snapshot.volumeIndex) || 0;
    state.volumeWarnings = Array.isArray(snapshot.volumeWarnings) ? snapshot.volumeWarnings : [];
    state.characters = Array.isArray(snapshot.characters) ? snapshot.characters : [];
    state.profiles = Array.isArray(snapshot.profiles) ? snapshot.profiles : [];
    state.entries = Array.isArray(snapshot.entries) ? snapshot.entries : [];
    clearChunkCache();
    state._chunkChars = snapshot.chunkChars || null;

    // 剧情推进器（存档里带了就一起恢复）
    if (snapshot.playbook?.stages?.length) {
        state.playbook = snapshot.playbook;
        state.runtime = snapshot.storyRuntime || createRuntimeState(snapshot.playbook);
        state.storyActive = snapshot.storyActive === true;
        state.storyOpening = snapshot.storyOpening || '';
        persistStoryToSettings();
        const checkbox = $id('n2c-story-active');
        if (checkbox) checkbox.checked = state.storyActive;
    }

    const textarea = $id('n2c-text');
    if (textarea) textarea.value = state.rawText.length > 200_000 ? state.rawText.slice(0, 200_000) : state.rawText;
    const titleInput = $id('n2c-title');
    if (titleInput) titleInput.value = state.novelTitle;

    renderCharacterList();
    renderResults();
    renderVolumeList();
    renderStoryProgress();
    renderStoryOpening();
    updateTextInfo();

    const box = $id('n2c-log');
    if (box) box.innerHTML = '';
    for (const line of snapshot.logLines || []) {
        state.logLines.push(line);
        const element = document.createElement('div');
        element.className = `n2c-log-line n2c-log-${line.level || 'info'}`;
        element.insertAdjacentHTML('beforeend',
            `<span class="n2c-log-time">${escapeHtml(line.stamp)}</span>`
            + `<span class="n2c-log-text">${escapeHtml(line.message)}</span>`);
        box?.appendChild(element);
    }
}

async function saveProgress({ silent = false } = {}) {
    if (!requireEnabled()) return;
    if (!state.rawText && !state.characters.length && !state.profiles.length) {
        if (!silent) toast('warn', '还没有任何进度可以保存');
        return;
    }

    const nameInput = $id('n2c-save-name');
    const typed = nameInput?.value?.trim();
    const autoName = state.novelTitle ? `${state.novelTitle}` : '未命名作品';
    const volumeLabel = activeVolumeLabel();
    const name = typed || `${autoName}${volumeLabel ? ` ${volumeLabel}` : ''}`;

    try {
        const result = await saveSnapshot({
            id: state.lastSaveId || undefined,
            name,
            state: snapshotState(),
        });
        state.lastSaveId = result.id;
        state.lastSaveAt = result.savedAt;
        updateSaveInfo(`已存档：${name} · ${formatBytes(result.bytes)} · ${formatTime(result.savedAt)}`);
        if (!silent) {
            toast('success', `进度已保存（${formatBytes(result.bytes)}）`);
            log(`已存档「${name}」：${formatBytes(result.bytes)}`);
        }
        await renderSaveList();
    } catch (error) {
        updateSaveInfo(`存档失败：${error.message}`);
        log(`存档失败：${error.message}`, 'error');
        if (!silent) toast('error', `存档失败：${error.message}`);
    }
}

/** 关键节点自动存档：只在开启时生效，失败不打扰用户 */
async function autoSaveCheckpoint(reason) {
    if (!getSettings().autoSave) return;
    await saveProgress({ silent: true });
    log(`已在「${reason}」自动存档`);
}

function updateSaveInfo(text) {
    const info = $id('n2c-save-info');
    if (info) info.textContent = text;
}

async function renderSaveList() {
    const host = $id('n2c-save-list');
    if (!host) return;

    let list = [];
    try {
        list = await listSnapshots();
    } catch (error) {
        host.innerHTML = `<div class="n2c-hint">读取存档列表失败：${escapeHtml(error.message)}</div>`;
        return;
    }
    state.snapshotList = list;

    if (!list.length) {
        host.innerHTML = '<div class="n2c-hint">还没有存档。</div>';
        return;
    }

    host.innerHTML = list.slice(0, 8).map(item => `
<div class="n2c-save-row" data-id="${escapeHtml(item.id)}">
  <div class="n2c-save-main">
    <div class="n2c-save-name">${escapeHtml(item.name)}</div>
    <div class="n2c-save-meta">${formatTime(item.savedAt)} · ${formatBytes(item.bytes)}</div>
  </div>
  <div class="menu_button n2c-small n2c-save-load"><i class="fa-solid fa-rotate-left"></i> 恢复</div>
  <div class="menu_button n2c-small n2c-save-del"><i class="fa-solid fa-trash-can"></i></div>
</div>`).join('');

    host.querySelectorAll('.n2c-save-row').forEach(row => {
        const id = row.dataset.id;
        row.querySelector('.n2c-save-load')?.addEventListener('click', () => restoreSnapshot(id));
        row.querySelector('.n2c-save-del')?.addEventListener('click', async () => {
            try {
                await deleteSnapshot(id);
                log('已删除一份存档');
                await renderSaveList();
            } catch (error) {
                toast('error', `删除失败：${error.message}`);
            }
        });
    });
}

async function restoreSnapshot(id) {
    if (!requireEnabled()) return;
    if (state.running) {
        toast('warn', '正在运行中，先中止再恢复');
        return;
    }
    try {
        const record = await loadSnapshot(id);
        if (!record) {
            toast('error', '存档不存在或已被删除');
            return;
        }
        applySnapshot(record.state);
        state.lastSaveId = record.id;
        log(`已恢复存档「${record.name}」（${formatTime(record.savedAt)}）`);
        toast('success', `已恢复「${record.name}」`);
        updateSaveInfo(`当前进度来自存档：${record.name}`);
    } catch (error) {
        log(`恢复失败：${error.message}`, 'error');
        toast('error', `恢复失败：${error.message}`);
    }
}

/** 启动时如果发现上次有存档，提示一句而不是自动覆盖当前状态 */
async function maybeOfferRestore() {
    if (!isPluginEnabled()) return;
    try {
        const latest = await latestSnapshot();
        if (!latest) return;
        log(`发现上次的存档「${latest.name}」（${formatTime(latest.savedAt)}），可在「存档与进度」里恢复`);
        updateSaveInfo(`上次存档：${latest.name} · ${formatTime(latest.savedAt)}`);
    } catch {
        // 读不到就安静跳过，别打扰用户
    }
}

// ================================================================
// 剧情推进器运行时
// ================================================================

/** 每个聊天自己的进度存在 chat_metadata 里，换聊天不会串进度 */
const CHAT_META_KEY = 'novel_to_card_story';

/** setExtensionPrompt 的注入槽名（事件路径用不到它，作为兜底） */
const STORY_SLOT = 'novel_to_card_story';

/**
 * setExtensionPrompt 用动态 import 拿，不做静态导入。
 * 理由：它跨酒馆版本可用性不稳（参照 novel-injector 的写法），
 * 静态导入一旦失败会直接让扩展加载不了，动态拿最多是降级。
 */
let setExtensionPromptFn = null;
async function ensureExtensionPromptFn() {
    if (typeof setExtensionPromptFn === 'function') return setExtensionPromptFn;
    try {
        const module = await import('/script.js');
        setExtensionPromptFn = module.setExtensionPrompt || null;
    } catch {
        setExtensionPromptFn = null;
    }
    return setExtensionPromptFn;
}

/**
 * 剧本本身不放进默认设置（体积可能很大），单独挂在 extension_settings 下。
 * 只保留必要的字段，避免把一堆运行时临时值也序列化进去。
 */
function persistStoryToSettings() {
    const s = getSettings();
    s._storyPlaybook = state.playbook || null;
    s._storyOpening = state.storyOpening || '';
    s._storyActive = state.storyActive === true;
    putSettings();
}

/** 启动时把剧本恢复回来，并按当前聊天重建进度 */
function restoreStoryFromSettings() {
    const s = getSettings();
    if (!s._storyPlaybook?.stages?.length) return;
    state.playbook = s._storyPlaybook;
    state.storyOpening = s._storyOpening || '';
    // 运行时的开关键以设置里的为准：漏同步会导致"开关是开着的，但注入不生效"
    state.storyActive = s._storyActive === true;
    loadRuntimeFromChat();

    const checkbox = $id('n2c-story-active');
    if (checkbox) checkbox.checked = state.storyActive;
    updateStoryButtonState();

    log(`已恢复剧情脚本：${state.playbook.stages.length} 段，玩家扮演「${state.playbook.player?.name || '主角'}」`);
}
/**
 * 绑定剧情推进的运行时钩子。
 *
 * - CHAT_COMPLETION_PROMPT_READY：把当前剧情段注入本次请求（首选路径，
 *   直接改 eventData.chat，与上游/其他扩展的行为一致）
 * - MESSAGE_RECEIVED：读回模型在回复尾部写的 [推进] / [状态] 控制行
 * - CHAT_CHANGED：换聊天时重新加载该聊天的进度
 */
function bindStoryRuntime() {
    const context = safeContext();
    const events = context?.eventSource;
    const types = context?.eventTypes;
    if (!events?.on || !types) {
        log('拿不到酒馆事件系统，剧情注入将不可用', 'warn');
        return;
    }

    ensureExtensionPromptFn();

    if (types.CHAT_COMPLETION_PROMPT_READY) {
        events.on(types.CHAT_COMPLETION_PROMPT_READY, eventData => {
            // dryRun 是酒馆自己的预演请求，不该被我们注入
            if (eventData?.dryRun) return;
            if (!isPluginEnabled()) return;
            try {
                pushStoryInjection(eventData);
            } catch (error) {
                console.warn('[小说转角色卡] 剧情注入失败：', error);
            }
        });
    }

    if (types.MESSAGE_RECEIVED) {
        events.on(types.MESSAGE_RECEIVED, messageId => {
            if (!isPluginEnabled()) return;
            try {
                handleMessageControlLines(messageId);
            } catch (error) {
                console.warn('[小说转角色卡] 处理控制行失败：', error);
            }
        });
    }

    if (types.CHAT_CHANGED) {
        events.on(types.CHAT_CHANGED, () => {
            // 不能因为当前没剧本就直接返回：扩展可能比酒馆数据先初始化，
            // 那时剧本还没从设置里恢复。设置里有就先恢复，再重建本聊天的进度。
            if (!state.playbook?.stages?.length && getSettings()._storyPlaybook?.stages?.length) {
                restoreStoryFromSettings();
            }
            if (!state.playbook?.stages?.length) return;

            loadRuntimeFromChat();
            renderStoryProgress();
            renderStoryOpening();
            log(`已载入本聊天的剧情进度：第 ${(state.runtime?.stageIndex ?? 0) + 1} 段`);
        });
    }

    restoreStoryFromSettings();
}

function getChatMetadata() {
    try {
        return chat_metadata || null;
    } catch {
        return null;
    }
}

function loadRuntimeFromChat() {
    const meta = getChatMetadata();
    const saved = meta?.[CHAT_META_KEY];
    if (!saved || !Number.isFinite(saved.stageIndex)) {
        state.runtime = state.playbook ? createRuntimeState(state.playbook) : null;
        return;
    }
    state.runtime = {
        stageIndex: saved.stageIndex,
        variables: saved.variables || {},
        history: Array.isArray(saved.history) ? saved.history : [],
        startedAt: saved.startedAt || Date.now(),
    };
}

function saveRuntimeToChat() {
    const meta = getChatMetadata();
    if (!meta || !state.runtime) return;
    meta[CHAT_META_KEY] = {
        stageIndex: state.runtime.stageIndex,
        variables: state.runtime.variables,
        history: state.runtime.history,
        startedAt: state.runtime.startedAt,
    };
    // 交给酒馆自己防抖落盘，避免每次生成都写一遍
    try {
        saveMetadataDebounced?.();
    } catch {
        // 拿不到就下次再说
    }
}

/** 当前是否处于"游玩中"：脚本已生成且玩家开启了注入 */
function isStoryPlaying() {
    return !!(state.storyActive && state.playbook?.stages?.length && state.runtime);
}

/** 组装并写入本回合的注入内容 */
function pushStoryInjection(eventData) {
    if (!isStoryPlaying()) {
        clearStoryInjection(eventData);
        return;
    }
    const content = buildStoryPrompt({
        playbook: state.playbook,
        runtime: state.runtime,
        autoReport: getSettings().storyAutoReport !== false,
    });
    if (!content.trim()) return;
    injectIntoPrompt(eventData, STORY_SLOT, content);
}

function clearStoryInjection(eventData) {
    if (eventData?.chat && Array.isArray(eventData.chat)) return;
    try {
        setExtensionPromptFn?.(STORY_SLOT, '', 1, 0, true, 0);
    } catch {
        // 忽略
    }
}

/** 事件路径优先直接改 eventData.chat；拿不到就退回 setExtensionPrompt */
function injectIntoPrompt(eventData, slotKey, content) {
    const depth = Math.max(0, Number(getSettings().storyInjectDepth) || 4);
    if (eventData?.chat && Array.isArray(eventData.chat)) {
        const message = { role: 'system', content, is_system: true };
        const index = Math.max(0, eventData.chat.length - depth);
        eventData.chat.splice(index, 0, message);
        return;
    }
    try {
        setExtensionPromptFn?.(slotKey, content, 1, depth, true, 0);
    } catch (error) {
        log(`剧情注入失败：${error.message}`, 'warn');
    }
}

/** 截获模型回复里的 [推进] / [状态] 控制行，应用后从展示内容里剔除 */
function handleMessageControlLines(messageId) {
    if (!isStoryPlaying()) return;
    if (!getSettings().storyAutoAdvance && !getSettings().storyAutoReport) return;

    const context = safeContext();
    const chat = context?.chat;
    if (!Array.isArray(chat)) return;
    const message = chat[messageId];
    if (!message || message.is_user || message.is_system) return;

    const parsed = parseControlLines(message.mes);
    if (!parsed.advance && !parsed.changes.length) return;

    // 先把控制行从展示文本里去掉，避免它们出现在聊天里
    if (parsed.cleaned !== String(message.mes ?? '').trim()) {
        message.mes = parsed.cleaned;
        try {
            context.updateMessageBlock?.(messageId, message);
        } catch {
            // 更新气泡失败不影响状态推进
        }
    }

    if (parsed.changes.length && getSettings().storyAutoReport) {
        const { runtime, applied, skipped } = applyVariableChanges(state.runtime, state.playbook, parsed.changes);
        state.runtime = runtime;
        for (const item of applied) {
            log(`状态变化：${item.name} ${item.before} → ${item.after}`);
        }
        if (skipped.length) log(`这些变量没在剧本里定义，已忽略：${skipped.join('、')}`, 'warn');
    }

    if (parsed.advance && getSettings().storyAutoAdvance) {
        advanceToStage(state.runtime.stageIndex + 1, '剧情自然推进');
    }

    saveRuntimeToChat();
    renderStoryProgress();
}

function safeContext() {
    try {
        return getContext();
    } catch {
        return null;
    }
}

/** 推进/回退到指定节点 */
function advanceToStage(index, note) {
    if (!state.playbook?.stages?.length) return;
    const total = state.playbook.stages.length;
    const clamped = Math.max(0, Math.min(Math.floor(index), total - 1));
    if (clamped === state.runtime.stageIndex) return;

    state.runtime = advanceStage(state.runtime, state.playbook, { toIndex: clamped, note });
    saveRuntimeToChat();
    renderStoryProgress();

    const stage = currentStage(state.playbook, state.runtime);
    const verb = clamped > 0 ? '推进到' : '回到';
    log(`${verb}第 ${clamped + 1}/${total} 段「${stage.title}」`);
    toast('success', `${verb}第 ${clamped + 1} 段：${stage.title}`);
}

async function startStory() {
    if (!requireEnabled()) return;

    // 刷新页面后 state 是空的，但设置里可能存着剧本——先恢复再启动，
    // 否则用户点了「开始游玩」会毫无反应
    if (!state.playbook?.stages?.length && getSettings()._storyPlaybook?.stages?.length) {
        restoreStoryFromSettings();
    }
    if (!state.playbook?.stages?.length) {
        toast('warn', '请先在「剧情」页生成剧情脚本');
        return;
    }
    if (!state.runtime) state.runtime = createRuntimeState(state.playbook);

    state.storyActive = true;
    const checkbox = $id('n2c-story-active');
    if (checkbox) checkbox.checked = true;
    // 状态必须落盘：否则刷新页面后 restoreStoryFromSettings 读到的是旧值，
    // 开关看着还是开着的，注入却已经不生效了
    persistStoryToSettings();
    saveRuntimeToChat();
    renderStoryProgress();
    log(`已开启剧情注入：当前第 ${state.runtime.stageIndex + 1} 段「${currentStage(state.playbook, state.runtime)?.title}」`);
    toast('success', '剧情注入已开启，现在开始聊天就会按节点推进');

    updateStoryButtonState();
}

function stopStory() {
    state.storyActive = false;
    const checkbox = $id('n2c-story-active');
    if (checkbox) checkbox.checked = false;
    persistStoryToSettings();
    clearStoryInjection(null);
    renderStoryProgress();
    updateStoryButtonState();
    log('已关闭剧情注入');
}

function updateStoryButtonState() {
    const start = $id('n2c-story-start');
    const stop = $id('n2c-story-stop');
    if (start) start.style.display = isStoryPlaying() ? 'none' : '';
    if (stop) stop.style.display = isStoryPlaying() ? '' : 'none';
}

function renderStoryProgress() {
    const host = $id('n2c-story-progress');
    if (!host) return;

    if (!state.playbook?.stages?.length) {
        host.innerHTML = '<div class="n2c-hint">还没有剧情脚本。到本页上方生成，或在「转换」页先分卷再生成。</div>';
        updateStoryButtonState();
        return;
    }

    const progress = summarizeProgress(state.playbook, state.runtime);
    const stage = currentStage(state.playbook, state.runtime);
    const variables = formatVariables(state.playbook, state.runtime);
    const player = state.playbook.player || {};

    const variableRows = (state.playbook.variables || []).map(variable => {
        const value = state.runtime?.variables?.[variable.name];
        const shown = typeof value === 'boolean' ? (value ? '是' : '否') : String(value ?? '');
        return `<div class="n2c-var-row" title="${escapeHtml(variable.desc || '')}">
          <span class="n2c-var-name">${escapeHtml(variable.name)}</span>
          <input type="text" class="text_pole n2c-var-value" data-var="${escapeHtml(variable.name)}" value="${escapeHtml(shown)}">
        </div>`;
    }).join('');

    host.innerHTML = `
<div class="n2c-story-head">
  <div class="n2c-story-title">第 ${progress.current} / ${progress.total} 段 · ${escapeHtml(progress.title)}</div>
  <div class="n2c-story-meta">${escapeHtml(progress.location || '')}${player.name ? ` · 你扮演 ${escapeHtml(player.name)}` : ''}</div>
</div>
<div class="n2c-progress"><div class="n2c-progress-bar" style="width:${progress.percent}%"></div></div>
<div class="n2c-row n2c-row-actions">
  <div class="menu_button n2c-small" id="n2c-story-prev"><i class="fa-solid fa-backward-step"></i> 上一段</div>
  <div class="menu_button n2c-small n2c-primary" id="n2c-story-next"><i class="fa-solid fa-forward-step"></i> 下一段</div>
  <div class="menu_button n2c-small" id="n2c-story-insert"><i class="fa-solid fa-quote-left"></i> 把本段发到输入框</div>
</div>
${variableRows ? `<div class="n2c-label n2c-label-gap">追踪变量</div><div class="n2c-var-list">${variableRows}</div>` : ''}
<div class="n2c-hint">变量可直接改；改动会立刻用于下一次注入。</div>`;

    $id('n2c-story-prev')?.addEventListener('click', () => advanceToStage(state.runtime.stageIndex - 1, '手动回退'));
    $id('n2c-story-next')?.addEventListener('click', () => advanceToStage(state.runtime.stageIndex + 1, '手动推进'));
    $id('n2c-story-insert')?.addEventListener('click', () => insertStageToInput(stage));

    host.querySelectorAll('.n2c-var-value').forEach(input => {
        input.addEventListener('input', event => {
            const name = event.target.dataset.var;
            const definition = (state.playbook.variables || []).find(item => item.name === name);
            if (!definition || !state.runtime) return;
            let value = event.target.value;
            if (definition.type === 'number') {
                const number = Number(value);
                value = Number.isFinite(number) ? number : 0;
            } else if (definition.type === 'bool') {
                value = /^(是|true|1|yes|有)$/i.test(String(value));
            }
            state.runtime.variables[name] = value;
            saveRuntimeToChat();
        });
    });

    updateStoryButtonState();
}

/** 把当前节点写进聊天输入框，方便手动补一段环境描写或直接演 */
function insertStageToInput(stage) {
    if (!stage) return;
    const textarea = document.querySelector('#send_textarea');
    if (!textarea) {
        toast('warn', '找不到输入框，可手动复制');
        return;
    }
    const text = `（本段地点：${stage.location || '未知'}。${stage.situation.slice(0, 200)}）`;
    textarea.value = textarea.value ? `${textarea.value}\n${text}` : text;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    toast('success', '已把本段背景写进输入框');
}

/** 生成剧情脚本 */
async function runStoryBuild() {
    if (state.running) return;
    if (!requireEnabled()) return;

    const settings = getSettings();
    const text = activeText().trim();
    if (!text) {
        toast('warn', '请先在「转换」页载入小说文本');
        return;
    }

    const volumeLabel = activeVolumeLabel();
    const abort = new AbortController();
    state.abort = abort;
    setRunning(true);

    try {
        await ensureChunks(text);
        const callModel = buildModelClient();

        setProgress(10, '拆解剧情节点…');
        log(`开始拆解剧情${volumeLabel ? `（${volumeLabel}）` : ''}…`);
        const raw = await extractStoryStages({
            chunks: state.chunks,
            novelTitle: state.novelTitle,
            playerName: settings.storyPlayerName,
            callModel,
            instruction: settings.extraInstruction,
            signal: abort.signal,
            targetNodes: Number(settings.storyNodeCount) || 12,
        });

        const playbook = normalizePlaybook(raw);
        for (const warning of playbook.warnings) log(warning, 'warn');
        if (!playbook.stages.length) {
            throw new Error('模型没有返回可用的剧情节点');
        }

        state.playbook = playbook;
        state.runtime = createRuntimeState(playbook);
        state.storyActive = false;

        setProgress(75, '写开场白…');
        try {
            const opening = await generateOpening({
                novelTitle: state.novelTitle,
                player: playbook.player,
                stage: playbook.stages[0],
                style: settings.storyStyle,
                callModel,
                signal: abort.signal,
            });
            state.storyOpening = opening;
        } catch (error) {
            log(`开场白生成失败（不影响游玩）：${error.message}`, 'warn');
            state.storyOpening = '';
        }

        log(`剧情脚本完成：${playbook.stages.length} 段，玩家扮演「${playbook.player.name}」，${playbook.variables.length} 个追踪变量`);
        for (const stage of playbook.stages) {
            log(`  第 ${stage.index + 1} 段：${stage.title}${stage.location ? `（${stage.location}）` : ''}`);
        }

        saveRuntimeToChat();
        persistStoryToSettings();
        renderStoryProgress();
        renderStoryOpening();
        setProgress(100, '剧情脚本就绪');
        toast('success', `剧情脚本已生成：${playbook.stages.length} 段`);
        await autoSaveCheckpoint('剧情脚本生成完成');
    } catch (error) {
        log(`剧情拆解失败：${error.message}`, 'error');
        toast('error', `剧情拆解失败：${error.message}`);
        setProgress(0, '剧情拆解失败');
    } finally {
        setRunning(false);
        state.abort = null;
    }
}

function renderStoryOpening() {
    const host = $id('n2c-story-opening');
    if (!host) return;
    if (!state.storyOpening) {
        host.innerHTML = '<div class="n2c-hint">还没有开场白。生成剧情脚本时会一起产出。</div>';
        return;
    }
    host.innerHTML = `
      <div class="n2c-opening-text">${escapeHtml(state.storyOpening)}</div>
      <div class="n2c-row"><div class="menu_button n2c-small" id="n2c-copy-opening">
        <i class="fa-solid fa-copy"></i> 复制开场白</div></div>`;
    $id('n2c-copy-opening')?.addEventListener('click', () => {
        navigator.clipboard?.writeText(state.storyOpening)
            .then(() => toast('success', '开场白已复制'))
            .catch(() => toast('warn', '复制失败，请手动选中'));
    });
}

/** 把剧本导出成世界书，方便在没有扩展的场合也能用 */
function downloadStoryWorldBook() {
    if (!state.playbook?.stages?.length) {
        toast('warn', '还没有剧情脚本');
        return;
    }
    const data = buildStoryWorldInfo({
        playbook: state.playbook,
        novelTitle: state.novelTitle,
        buildWorldInfoData,
    });
    const name = `${safeFileName(state.novelTitle || '小说')}·剧情脚本`;
    downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `${name}.json`);
    log(`已导出剧情世界书：${name}.json（${state.playbook.stages.length} 段）`);
}

/** 用剧本生成一张"玩家角色卡"，导入后即可直接开玩 */
async function createPlayerCard() {
    if (!state.playbook?.stages?.length) {
        toast('warn', '还没有剧情脚本');
        return;
    }
    if (!requireEnabled()) return;

    const playbook = state.playbook;
    const player = playbook.player || {};
    const stage = playbook.stages[0];
    const name = player.name || '主角';
    const settings = getSettings();

    const profile = {
        name,
        role: player.identity || '剧情主角',
        summary: `${state.novelTitle || '小说'} 的互动剧情主角。${player.goal || ''}`,
        personality: player.relationships || '',
        scenario: stage?.situation || '',
        world_context: `由《${state.novelTitle || '未命名'}》拆出的 ${playbook.stages.length} 段互动剧情。`,
        first_mes: state.storyOpening || stage?.situation || '',
        example_dialogue: [],
    };

    const meta = {
        creator: settings.creatorName || '小说转角色卡',
        version: settings.cardVersionTag || '1.0',
        source: state.novelTitle,
        sources: [state.novelTitle].filter(Boolean),
        tags: ['剧情脚本', '可游玩'],
    };

    try {
        const cardV2 = buildCardV2(profile, meta);
        const cardV3 = buildCardV3(profile, meta);

        // 把剧情节点作为 character_book 内嵌，导入即自带世界书
        const storyBook = buildStoryWorldInfo({
            playbook,
            novelTitle: state.novelTitle,
            buildWorldInfoData,
        });
        const bookEntries = Object.values(storyBook.entries || {}).map(entry => ({
            comment: entry.comment,
            keys: entry.key,
            content: entry.content,
            category: entry.group || '剧情节点',
            constant: entry.constant,
        }));
        const bookName = `${name}·${state.novelTitle || '小说'}剧情`;
        cardV2.data.character_book = buildCharacterBook(bookEntries, { name: bookName });
        cardV3.data.character_book = buildCharacterBook(bookEntries, { name: bookName });

        const basePng = await generatePlaceholderPng(name, { size: Number(settings.avatarMaxSize) || 512 });
        const pngBytes = embedCardIntoPng(basePng, {
            chara: utf8ToBase64(JSON.stringify(cardV2)),
            ccv3: utf8ToBase64(JSON.stringify(cardV3)),
        });

        const built = { name, cardV2, cardV3, _pngBytes: pngBytes };

        if (settings.importToTavern) {
            await importProfileToTavern(built);
            log(`已生成并导入剧情卡「${name}」，选它开新聊天即可`);
            toast('success', `已导入剧情卡「${name}」`);
        } else {
            downloadBytes(pngBytes, `${safeFileName(name)}.png`);
            log(`已导出剧情卡「${name}」`);
        }
    } catch (error) {
        log(`生成剧情卡失败：${error.message}`, 'error');
        toast('error', `生成剧情卡失败：${error.message}`);
    }
}

// ================================================================
// 环境检查
// ================================================================

/** 模型下拉框的选项：优先用拉取到的列表，并把当前已选模型并进去避免显示丢空 */
function renderModelOptions() {
    const s = getSettings();
    const saved = String(s.apiModel || '').trim();
    const models = state.modelList?.length ? [...state.modelList] : [];

    if (saved && !models.includes(saved)) models.unshift(saved);
    if (!models.length) {
        return `<option value="${escapeHtml(saved)}">${saved ? escapeHtml(saved) : '（点右侧列表按钮获取）'}</option>`;
    }

    return models.map(name => {
        const selected = name === saved ? ' selected' : '';
        return `<option value="${escapeHtml(name)}"${selected}>${escapeHtml(name)}</option>`;
    }).join('');
}

/** 刷新模型下拉框；不动用户当前选择 */
function refreshModelSelect(preserveValue) {
    const select = $id('n2c-api-model-select');
    if (!select) return;
    const s = getSettings();
    const keep = preserveValue ?? s.apiModel ?? '';
    select.innerHTML = renderModelOptions();
    if (keep) {
        select.value = keep;
        // 列表里没有这个值时（例如刚手动输入），补一个选项避免选择被清空
        if (select.value !== keep) {
            const option = document.createElement('option');
            option.value = keep;
            option.textContent = keep;
            select.appendChild(option);
            select.value = keep;
        }
    }
    syncApiManualVisibility();
}

function syncApiManualVisibility() {
    const wrap = $id('n2c-api-manual-wrap');
    if (wrap) wrap.style.display = getSettings().apiManualModel ? '' : 'none';
}

/** 当前实际生效的模型名：开了手动输入就用输入框，否则用下拉框 */
function currentModelValue() {
    const settings = getSettings();
    const manual = $id('n2c-api-model')?.value?.trim();
    if (settings.apiManualModel && manual) return manual;
    const select = $id('n2c-api-model-select')?.value?.trim();
    if (select) return select;
    return settings.apiModel || manual || '';
}

/**
 * 从接口拉取模型列表并填进下拉框。
 * 走 ai.js 的 fetchModelList：先试酒馆后端代理，失败再直连 /models。
 */
async function fetchModels() {
    const settings = getSettings();
    if (!settings.apiUrl) {
        toast('warn', '请先填写接口地址');
        return;
    }

    const button = $id('n2c-api-models');
    const result = $id('n2c-api-test-result');
    if (button) button.classList.add('n2c-busy');
    if (result) result.textContent = '正在获取模型列表…';

    try {
        const context = requireContext();
        const { models, via } = await fetchModelList({
            apiConfig: { url: settings.apiUrl, key: settings.apiKey },
            getRequestHeaders: context.getRequestHeaders?.bind(context),
        });

        state.modelList = models;
        // 没选过模型就自动落在一个常见的对话模型上，省一次点击
        if (!settings.apiModel) {
            const guess = models.find(name => /chat|instruct|turbo|deepseek|gpt|claude|gemini/i.test(name));
            settings.apiModel = guess || models[0];
            putSettings();
        }
        refreshModelSelect();

        const channel = via === 'tavern' ? '酒馆代理' : '直连';
        const text = `获取到 ${models.length} 个模型（${channel}），已填入下拉框`;
        if (result) result.textContent = text;
        log(`模型列表：${text}`);
        toast('success', `获取到 ${models.length} 个模型`);
    } catch (error) {
        const text = `获取失败：${error.message}`;
        if (result) result.textContent = text;
        log(`获取模型列表失败：${error.message}`, 'error');
        toast('error', '获取模型列表失败，可在下方勾选「手动输入模型名」');
        // 失败时自动放开手动输入，别让用户卡在空下拉框上
        settings.apiManualModel = true;
        putSettings();
        const checkbox = $id('n2c-api-manual-model');
        if (checkbox) checkbox.checked = true;
        syncApiManualVisibility();
    } finally {
        if (button) button.classList.remove('n2c-busy');
    }
}

function requireContext() {
    const context = getContext();
    if (!context) throw new Error('拿不到酒馆上下文 getContext()');
    return context;
}

/** 只有选了独立 API 才展开配置区 */
function syncApiConfigVisibility() {
    const box = $id('n2c-api-config');
    if (!box) return;
    box.style.display = getSettings().apiClient === 'custom' ? '' : 'none';
}

/** 打开面板时把模型下拉框按已保存的设置铺好 */
function initApiControls() {
    syncApiConfigVisibility();
    syncApiManualVisibility();
    refreshModelSelect();
}

function buildModelClient() {
    const context = requireContext();
    const settings = getSettings();

    if (settings.apiClient !== 'custom') {
        return createConfiguredModelClient(context, { client: 'tavern' });
    }

    const custom = {
        url: settings.apiUrl,
        key: settings.apiKey,
        model: currentModelValue(),
        stream: settings.apiStream === true,
        temperature: settings.apiTemperature === '' ? undefined : Number(settings.apiTemperature),
        top_p: settings.apiTopP === '' ? undefined : Number(settings.apiTopP),
    };
    log(`使用独立 API：${custom.model || '(未填模型)'} @ ${custom.url || '(未填地址)'}`);
    return createConfiguredModelClient(context, { client: 'custom', custom });
}

async function testApiConnection() {
    const result = $id('n2c-api-test-result');
    const settings = getSettings();
    // 模型名以界面上实际生效的那个为准，避免手填与下拉不一致
    const model = currentModelValue();
    const custom = {
        url: settings.apiUrl,
        key: settings.apiKey,
        model,
        stream: false,
        temperature: undefined,
        top_p: undefined,
    };

    if (!custom.url || !custom.model) {
        if (result) result.textContent = '请先填写接口地址和模型名';
        toast('warn', '请先填写接口地址和模型名');
        return;
    }

    if (result) result.textContent = '测试中…';
    const button = $id('n2c-api-test');
    if (button) button.classList.add('n2c-busy');

    try {
        const context = requireContext();
        const response = await testCustomApi({
            apiConfig: custom,
            getRequestHeaders: context.getRequestHeaders?.bind(context),
        });
        const text = `连接成功（${response.elapsedMs} ms）回应：${response.sample}`;
        if (result) result.textContent = text;
        log(`独立 API 测试成功：${response.elapsedMs} ms`);
        toast('success', '独立 API 可用');
    } catch (error) {
        const text = `失败：${error.message}`;
        if (result) result.textContent = text;
        log(`独立 API 测试失败：${error.message}`, 'error');
        toast('error', `独立 API 不可用：${error.message}`);
    } finally {
        if (button) button.classList.remove('n2c-busy');
    }
}

/** 角色分级：调模型判定三档，然后按配额筛选 */
async function runClassify() {
    if (state.running) return;
    if (!requireEnabled()) return;
    if (!state.characters.length) {
        toast('warn', '请先点「分析人物」得到候选角色');
        return;
    }
    const text = activeText().trim();
    if (!text) return;

    const abort = new AbortController();
    state.abort = abort;
    const button = $id('n2c-classify');
    if (button) button.classList.add('n2c-busy');

    try {
        await ensureChunks(text);
        const callModel = buildModelClient();
        log(`开始判定 ${state.characters.length} 个角色的重要程度…`);

        const tiers = await classifyCharacters({
            characters: state.characters,
            chunks: state.chunks,
            novelTitle: state.novelTitle,
            callModel,
            signal: abort.signal,
        });

        let labeled = 0;
        for (const character of state.characters) {
            const hit = tiers.get(canonicalName(character.name));
            if (hit) {
                character.tier = hit.tier;
                character.tierReason = hit.reason;
                labeled++;
            } else if (!character.tier) {
                // 模型没提到这个人物，保守当作主要配角
                character.tier = '主要配角';
            }
        }

        log(`分级完成：${labeled}/${state.characters.length} 个角色被明确判定`);
        applyTierQuotas();
        renderCharacterList();
        updateTierSummary();
    } catch (error) {
        log(`分级失败：${error.message}`, 'error');
        toast('error', `分级失败：${error.message}`);
    } finally {
        if (button) button.classList.remove('n2c-busy');
        state.abort = null;
    }
}

/** 按主角/配角配额勾选：超出的自动取消勾选，而不是直接删掉 */
function applyTierQuotas() {
    const settings = getSettings();
    if (!settings.tierEnabled) return;

    const order = { '主角': 0, '主要配角': 1, '次要配角': 2 };
    state.characters.sort((left, right) => {
        const diff = (order[left.tier] ?? 1) - (order[right.tier] ?? 1);
        if (diff !== 0) return diff;
        return (right.score || 0) - (left.score || 0);
    });

    let protagonists = 0;
    let supporting = 0;
    for (const character of state.characters) {
        const tier = character.tier || '主要配角';
        if (tier === '主角') {
            protagonists++;
            character.selected = protagonists <= (Number(settings.maxProtagonists) || 3);
        } else {
            supporting++;
            character.selected = supporting <= (Number(settings.maxSupporting) || 6);
        }
    }
}

function countTiers() {
    const counts = { '主角': 0, '主要配角': 0, '次要配角': 0, '未判定': 0 };
    for (const character of state.characters) {
        if (character.tier && counts[character.tier] !== undefined) counts[character.tier]++;
        else counts['未判定']++;
    }
    return counts;
}

function updateTierSummary() {
    const summary = $id('n2c-tier-summary');
    if (!summary) return;

    if (!state.characters.length) {
        summary.textContent = '还没有识别结果，请先到「转换」页点「分析人物」。';
        return;
    }
    if (!getSettings().tierEnabled) {
        const selected = state.characters.filter(character => character.selected !== false).length;
        summary.textContent = `分级已关闭 · 已勾选 ${selected} / ${state.characters.length}。可改名字、取消勾选后生成。`;
        return;
    }
    const counts = countTiers();
    const selected = state.characters.filter(character => character.selected !== false).length;
    summary.textContent = `主角 ${counts['主角']} · 主要配角 ${counts['主要配角']} · 次要配角 ${counts['次要配角']}`
        + `${counts['未判定'] ? ` · 未判定 ${counts['未判定']}` : ''} · 已勾选 ${selected}`;
}

// ================================================================
// 主流程
// ================================================================

async function runAnalyze() {
    if (state.running) return;
    if (!requireEnabled()) return;
    const settings = getSettings();
    const text = activeText().trim();
    if (!text) {
        toast('warn', '请先载入或粘贴小说文本');
        return;
    }

    const volumeLabel = activeVolumeLabel();
    const abort = new AbortController();
    state.abort = abort;
    setRunning(true);
    setProgress(2, '准备分段…');
    log(`开始分析${volumeLabel ? ` ${volumeLabel}` : ''}：${text.length.toLocaleString()} 字`);

    try {
        await ensureChunks(text);
        const callModel = buildModelClient();

        setProgress(10, '扫描出场人物…');
        const discoveries = await discoverCharacters({
            chunks: state.chunks,
            novelTitle: state.novelTitle,
            callModel,
            concurrency: Number(settings.concurrency) || 3,
            signal: abort.signal,
            onProgress: (done, total, label) => {
                setProgress(10 + (done / total) * 70, label);
            },
        });
        log(`共收集到 ${discoveries.length} 条人物线索`);

        const merged = mergeCharacters(discoveries);
        log(`合并同名角色后剩 ${merged.length} 人`);

        state.characters = merged
            .slice(0, Math.max(1, Number(settings.maxCharacters) || 8))
            .map(character => ({ ...character, selected: true }));

        if (!state.characters.length) {
            log('没有识别到任何角色，试试调小分段字数或换一个更强的模型', 'warn');
            setProgress(0, '未识别到角色');
            return;
        }

        const names = state.characters.map(character => character.name).join('、');
        log(`候选角色：${names}`);

        // 分级：判定主角/配角并按配额勾选。只多花一次请求，但能省掉一堆路人的完整人设。
        if (settings.tierEnabled) {
            setProgress(86, '判定主角与配角…');
            try {
                const tiers = await classifyCharacters({
                    characters: state.characters,
                    chunks: state.chunks,
                    novelTitle: state.novelTitle,
                    callModel,
                    signal: abort.signal,
                });
                for (const character of state.characters) {
                    const hit = tiers.get(canonicalName(character.name));
                    if (hit) {
                        character.tier = hit.tier;
                        character.tierReason = hit.reason;
                    }
                }
                const counts = countTiers();
                log(`分级结果：主角 ${counts['主角']} · 主要配角 ${counts['主要配角']} · 次要配角 ${counts['次要配角']}`
                    + `${counts['未判定'] ? ` · 未判定 ${counts['未判定']}` : ''}`);
                applyTierQuotas();
            } catch (error) {
                log(`分级失败，改为全部按主要角色处理：${error.message}`, 'warn');
            }
        }

        renderCharacterList();
        setProgress(100, `识别完成，共 ${state.characters.length} 人`);
        toast('success', `识别到 ${state.characters.length} 个角色，可以生成角色卡了`);
        await autoSaveCheckpoint('人物分析完成');
    } catch (error) {
        log(error.message, 'error');
        setProgress(0, '分析失败');
        toast('error', error.message);
    } finally {
        setRunning(false);
        state.abort = null;
    }
}

async function ensureChunks(text) {
    const settings = getSettings();
    const chunkChars = Number(settings.chunkChars) || 6000;
    if (state.chunks.length && state._chunkSource === text && state._chunkChars === chunkChars) {
        return;
    }
    state.chunks = splitNovel(text, { chunkChars, overlapChars: Math.floor(chunkChars * 0.07) });
    state._chunkSource = text;
    state._chunkChars = chunkChars;
    log(`已切成 ${state.chunks.length} 段（每段约 ${chunkChars} 字）`);
}

async function runGenerate() {
    if (state.running) return;
    if (!requireEnabled()) return;
    const settings = getSettings();
    const text = activeText().trim();
    if (!text) {
        toast('warn', '请先载入或粘贴小说文本');
        return;
    }
    if (!state.characters.length) {
        toast('warn', '请先点「分析人物」');
        return;
    }
    const targets = selectedCharacters();
    if (!targets.length) {
        toast('warn', '没有勾选任何角色');
        return;
    }

    const volumeLabel = activeVolumeLabel();
    const abort = new AbortController();
    state.abort = abort;
    setRunning(true);
    state.profiles = [];
    state.entries = [];
    renderResults();

    const callModel = buildModelClient();
    const sourceName = state.novelTitle || '未命名作品';
    if (volumeLabel) log(`本次只处理 ${volumeLabel}`);

    try {
        await ensureChunks(text);

        // ---- 世界书
        if (settings.withWorldBook) {
            setProgress(3, '提取世界观…');
            try {
                state.entries = await buildWorldEntries(callModel, abort.signal);
                log(`世界书整理出 ${state.entries.length} 条`);
            } catch (error) {
                log(`世界书提取失败，跳过：${error.message}`, 'warn');
                state.entries = [];
            }
        }

        // ---- 逐角色出档案
        const total = targets.length;
        for (let index = 0; index < total; index++) {
            if (abort.signal.aborted) throw new Error('已中止');
            const character = targets[index];
            const tier = settings.tierEnabled ? (character.tier || '主要配角') : '主角';
            const brief = settings.briefSupporting && isBriefTier(tier);
            const tierTag = settings.tierEnabled ? `[${tier}${brief ? '·精简' : ''}] ` : '';

            setProgress(20 + (index / total) * 70, `提取档案 ${index + 1}/${total}：${character.name}`);
            log(`${tierTag}提取「${character.name}」的人设…`);

            const evidence = collectEvidence(state.chunks, character, {
                maxChunks: brief
                    ? Math.max(3, Math.floor((Number(settings.evidenceChunks) || 8) * 0.6))
                    : (Number(settings.evidenceChunks) || 8),
                windowSize: 1500,
                maxChars: brief ? 8000 : 14000,
            });
            if (!evidence) {
                log(`「${character.name}」在原文里找不到可用的片段，跳过`, 'warn');
                continue;
            }

            try {
                const profile = await extractProfile({
                    character,
                    evidence,
                    novelTitle: sourceName,
                    callModel,
                    instruction: settings.extraInstruction,
                    signal: abort.signal,
                    tier: brief ? '次要配角' : '主角',
                });
                character.profile = profile;
                if (settings.tierEnabled) profile.tier = tier;

                const built = await buildProfileCard(character, profile);
                built.tier = tier;
                state.profiles.push(built);
                renderResults();
                log(`「${built.name}」完成：正文 ${built._summary.total} 字`);
            } catch (error) {
                log(`「${character.name}」提取失败：${error.message}`, 'error');
            }
        }

        // 记录本卷产出，供卷列表显示
        const currentVolume = state.volumes[state.volumeIndex];
        if (currentVolume) {
            currentVolume._cardCount = (currentVolume._cardCount || 0) + state.profiles.length;
            currentVolume._done = state.profiles.length > 0;
            renderVolumeList();
        }

        setProgress(100, `完成，共生成 ${state.profiles.length} 张角色卡`);
        if (!state.profiles.length) {
            toast('error', '没有生成出任何角色卡，看日志排查');
            return;
        }
        toast('success', `${volumeLabel || ''}生成完成，共 ${state.profiles.length} 张角色卡`);

        if (settings.withWorldBook && settings.saveWorldBookFile && state.entries.length) {
            downloadWorldFile();
        }
        await autoSaveCheckpoint('角色卡生成完成');
    } catch (error) {
        log(error.message, error.level === 'error' ? 'error' : 'warn');
        toast('error', error.message);
        setProgress(0, '已中止');
    } finally {
        setRunning(false);
        state.abort = null;
    }
}

async function runWorldOnly() {
    if (state.running) return;
    if (!requireEnabled()) return;
    const text = activeText().trim();
    if (!text) {
        toast('warn', '请先载入或粘贴小说文本');
        return;
    }

    const volumeLabel = activeVolumeLabel();
    const abort = new AbortController();
    state.abort = abort;
    setRunning(true);
    try {
        await ensureChunks(text);
        const callModel = buildModelClient();
        setProgress(20, '提取世界观…');
        state.entries = await buildWorldEntries(callModel, abort.signal);
        setProgress(100, `完成，世界书 ${state.entries.length} 条`);
        downloadWorldFile();
        toast('success', `${volumeLabel || ''}世界书已导出，共 ${state.entries.length} 条`);
    } catch (error) {
        log(error.message, 'error');
        toast('error', error.message);
    } finally {
        setRunning(false);
        state.abort = null;
    }
}

async function buildWorldEntries(callModel, signal) {
    const settings = getSettings();
    const raw = await extractWorldEntries({
        chunks: state.chunks,
        novelTitle: state.novelTitle,
        characters: state.characters.map(character => character.name),
        categories: [],
        callModel,
        instruction: settings.extraInstruction,
        signal,
        sampleCount: 8,
    });
    let entries = normalizeEntries(raw);
    const limit = Number(settings.worldEntryCount) || 0;
    if (limit > 0 && entries.length > limit) {
        // 优先保留常驻条目，其余按原顺序截断
        const constants = entries.filter(entry => entry.constant);
        const rest = entries.filter(entry => !entry.constant);
        entries = [...constants, ...rest].slice(0, limit);
    }
    return entries;
}

function downloadWorldFile() {
    if (!state.entries.length) {
        toast('warn', '还没有世界书条目');
        return;
    }
    const volumeLabel = activeVolumeLabel();
    // 分卷时文件名带卷号，避免多卷导出的世界书互相覆盖
    const volumeSuffix = volumeLabel ? `（${volumeLabel.replace(/[「」]/g, '')}）` : '';
    const name = `${safeFileName(state.novelTitle || '小说')}${volumeSuffix}世界书`;
    const data = buildWorldInfoData(state.entries, {
        name,
        description: `由《${state.novelTitle || '未命名'}》${volumeLabel || ''}自动提取，共 ${state.entries.length} 条`,
    });
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    downloadBlob(blob, `${name}.json`);
    log(`已导出世界书文件：${name}.json（${state.entries.length} 条）`);
}

// ================================================================
// 角色卡构建 + 导出 + 导入
// ================================================================

async function buildProfileCard(character, profile) {
    const settings = getSettings();
    const name = normalizeName(profile.name || character.name);
    profile.name = name;

    const tags = [];
    if (settings.autoTag) {
        tags.push('小说提取');
        if (character.role) tags.push(character.role.slice(0, 12));
        if (character.screen_time) tags.push(character.screen_time === 'high' ? '主角' : '');
    }

    const volumeLabel = activeVolumeLabel();
    const sourceLabel = volumeLabel ? `${volumeLabel}` : '';

    const meta = {
        creator: settings.creatorName || '小说转角色卡',
        version: settings.cardVersionTag || '1.0',
        source: state.novelTitle,
        sources: [state.novelTitle, sourceLabel].filter(Boolean),
        tags: tags.filter(Boolean),
    };

    const cardV2 = buildCardV2(profile, meta);
    const cardV3 = buildCardV3(profile, meta);

    // 世界书：内嵌副本按角色单独命名，避免多张卡共用一个书名互相覆盖
    if (settings.withWorldBook && settings.embedWorldBook && state.entries.length) {
        const bookName = `${name}·${state.novelTitle || '小说'}${sourceLabel ? ` ${sourceLabel}` : ''}世界书`;
        const bookEntries = state.entries;
        cardV2.data.character_book = buildCharacterBook(bookEntries, { name: bookName });
        cardV3.data.character_book = buildCharacterBook(bookEntries, { name: bookName });
    }

    // ---- 头图
    // 默认原样保留用户选的底图字节：只插入 tEXt 区块，不重编码像素，
    // 这样 JPEG 底图不会因为转 PNG 而体积暴涨。只有开了「缩放头像」才重建。
    let basePng;
    if (state.darkImage) {
        const isPng = isPngBytes(state.darkImage);
        if (!settings.resizeAvatar && isPng) {
            basePng = state.darkImage;
        } else {
            try {
                basePng = await imageToPngBytes(
                    new Blob([state.darkImage]),
                    { maxSize: Number(settings.avatarMaxSize) || 512 },
                );
                log(`底图已转换为 PNG（${(basePng.length / 1024).toFixed(0)} KB，原图 ${(state.darkImage.length / 1024).toFixed(0)} KB）`);
            } catch (error) {
                log(`底图转换失败，改用占位头像：${error.message}`, 'warn');
            }
        }
    }
    if (!basePng) {
        if (!settings.placeholderAvatar) {
            log(`「${name}」没有可用底图且已关闭占位头像，跳过这张卡`, 'warn');
            throw new Error('缺少底图且未启用占位头像');
        }
        basePng = await generatePlaceholderPng(name, { size: Math.max(256, Math.min(768, Number(settings.avatarMaxSize) || 512)) });
    }

    // ---- 嵌入卡数据
    const payload = {};
    if (settings.cardVersion === '2' || settings.cardVersion === 'both') {
        payload.chara = utf8ToBase64(JSON.stringify(cardV2));
    } else {
        // V3 卡同样带一份 V2 视图，老前端也能读
        payload.chara = utf8ToBase64(JSON.stringify(cardV2));
    }
    if (settings.cardVersion === '3' || settings.cardVersion === 'both') {
        payload.ccv3 = utf8ToBase64(JSON.stringify(cardV3));
    }

    const pngBytes = embedCardIntoPng(basePng, payload);

    const built = {
        name,
        role: character.role || '',
        cardV2,
        cardV3,
        _pngBytes: pngBytes,
        _summary: summarizeCard(cardV3),
    };

    if (settings.importToTavern) {
        try {
            await importProfileToTavern(built);
            log(`已导入角色列表：${name}`);
        } catch (error) {
            log(`「${name}」自动导入失败：${error.message}`, 'warn');
        }
    }

    return built;
}

/**
 * 通过 /api/characters/create 把 PNG 卡写进角色列表。
 * 字段名沿用酒馆服务端各导入分支实际读取的键。
 */
async function importProfileToTavern(profile) {
    const context = requireContext();
    const bytes = profile._pngBytes;
    if (!bytes) throw new Error('这张卡没有 PNG 数据');

    const fileName = `${safeFileName(profile.name)}.png`;
    const file = new File([bytes], fileName, { type: 'image/png' });

    const form = new FormData();
    form.append('avatar', file);
    form.append('file_type', 'png');
    form.append('preserved_name', file.name);
    form.append('ch_name', profile.name);
    form.append('chara_card_v2', JSON.stringify(profile.cardV2));
    form.append('chara_card_v3', JSON.stringify(profile.cardV3));

    const headers = typeof context.getRequestHeaders === 'function' ? context.getRequestHeaders() : {};
    // 必须让浏览器自己带 multipart boundary
    delete headers['Content-Type'];
    delete headers['content-type'];

    const response = await fetch('/api/characters/create', {
        method: 'POST',
        headers,
        body: form,
        cache: 'no-cache',
    });

    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status} ${detail.slice(0, 200)}`);
    }

    // 刷新前端角色列表缓存，让新卡立即可见
    try {
        if (typeof getCharacters === 'function') await getCharacters();
    } catch (error) {
        console.warn('[小说转角色卡] 角色列表刷新失败：', error);
    }

    return true;
}

// ================================================================
// 启动
// ================================================================

jQuery(async () => {
    getSettings();
    if (!mountPanel()) {
        // 容器可能晚于扩展加载才出现，轮询等待
        let tries = 0;
        const timer = setInterval(() => {
            tries++;
            if (mountPanel() || tries > 40) clearInterval(timer);
        }, 500);
    }
    log('扩展已加载');
});
