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
// saveSettingsDebounced 由 script.js 导出，extensions.js 不导出它（导入错会在激活期直接抛 SyntaxError）
import { saveSettingsDebounced, getCharacters } from '../../../../script.js';

import {
    splitNovel,
    createModelClient,
    discoverCharacters,
    mergeCharacters,
    collectEvidence,
    extractProfile,
    extractWorldEntries,
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

function renderPanelHtml() {
    const s = getSettings();
    return `
<div id="n2c-panel" class="inline-drawer">
  <div class="inline-drawer-toggle inline-drawer-header">
    <b>小说转角色卡</b>
    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
  </div>
  <div class="inline-drawer-content">

    <div class="n2c-section">
      <div class="n2c-label">1. 小说文本</div>
      <div class="n2c-row">
        <input type="text" id="n2c-title" class="text_pole n2c-grow" placeholder="作品名（可选，用于提示词）">
        <label class="n2c-file-btn menu_button" title="支持 .txt / .md / .jsonl">
          <i class="fa-solid fa-file-import"></i> 选择文件
          <input type="file" id="n2c-file" accept=".txt,.md,.jsonl,.text,text/plain" hidden>
        </label>
        <div class="menu_button" id="n2c-clear-text" title="清空已载入的文本"><i class="fa-solid fa-trash-can"></i></div>
      </div>
      <textarea id="n2c-text" class="text_pole n2c-textarea" rows="6" placeholder="在此粘贴小说正文，或点右上角选择文件（建议单次不超过 30 万字）"></textarea>
      <div class="n2c-hint" id="n2c-text-info">未载入文本</div>
    </div>

    <div class="n2c-section">
      <div class="n2c-row">
        <div class="menu_button n2c-primary" id="n2c-analyze"><i class="fa-solid fa-user-magnifying-glass"></i> 分析人物</div>
        <div class="menu_button" id="n2c-generate"><i class="fa-solid fa-id-card"></i> 生成角色卡</div>
        <div class="menu_button" id="n2c-make-world"><i class="fa-solid fa-book-atlas"></i> 只生成世界书</div>
        <div class="menu_button n2c-danger" id="n2c-cancel" style="display:none"><i class="fa-solid fa-ban"></i> 中止</div>
      </div>
      <div class="n2c-progress"><div class="n2c-progress-bar" id="n2c-progress-bar"></div></div>
      <div class="n2c-hint" id="n2c-progress-text"></div>
    </div>

    <div class="n2c-section">
      <div class="n2c-label">2. 识别到的角色 <span class="n2c-hint-inline">（可改名字、取消勾选）</span></div>
      <div id="n2c-chars" class="n2c-chars"></div>
    </div>

    <div class="n2c-section">
      <div class="n2c-label">3. 结果</div>
      <div id="n2c-results" class="n2c-results"><div class="n2c-hint">尚未生成任何角色卡。</div></div>
    </div>

    <div class="n2c-section">
      <div class="inline-drawer n2c-subdrawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>高级设置</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
          <div class="n2c-grid">
            <label class="n2c-field"><span>分段字数</span>
              <input type="number" id="n2c-chunk-chars" class="text_pole" min="1500" max="20000" step="500" value="${s.chunkChars}"></label>
            <label class="n2c-field"><span>请求并发</span>
              <input type="number" id="n2c-concurrency" class="text_pole" min="1" max="8" step="1" value="${s.concurrency}"></label>
            <label class="n2c-field"><span>最多角色数</span>
              <input type="number" id="n2c-max-chars" class="text_pole" min="1" max="40" step="1" value="${s.maxCharacters}"></label>
            <label class="n2c-field"><span>每角色证据段数</span>
              <input type="number" id="n2c-evidence" class="text_pole" min="1" max="20" step="1" value="${s.evidenceChunks}"></label>
            <label class="n2c-field"><span>角色卡版本</span>
              <select id="n2c-card-version" class="text_pole">
                <option value="3" ${s.cardVersion === '3' ? 'selected' : ''}>V3（推荐）</option>
                <option value="2" ${s.cardVersion === '2' ? 'selected' : ''}>V2</option>
                <option value="both" ${s.cardVersion === 'both' ? 'selected' : ''}>两者都要</option>
              </select></label>
            <label class="n2c-field"><span>头像最长边(px)</span>
              <input type="number" id="n2c-avatar-size" class="text_pole" min="128" max="1024" step="64" value="${s.avatarMaxSize}"></label>
          </div>

          <div class="n2c-checks">
            <label class="checkbox_label"><input type="checkbox" id="n2c-with-world" ${s.withWorldBook ? 'checked' : ''}><span>同时提取世界书</span></label>
            <label class="checkbox_label"><input type="checkbox" id="n2c-embed-world" ${s.embedWorldBook ? 'checked' : ''}><span>世界书内嵌进角色卡</span></label>
            <label class="checkbox_label"><input type="checkbox" id="n2c-save-world-file" ${s.saveWorldBookFile ? 'checked' : ''}><span>额外导出世界书 JSON</span></label>
            <label class="checkbox_label"><input type="checkbox" id="n2c-import" ${s.importToTavern ? 'checked' : ''}><span>自动导入到角色列表</span></label>
            <label class="checkbox_label"><input type="checkbox" id="n2c-placeholder" ${s.placeholderAvatar ? 'checked' : ''}><span>没有底图时生成占位头像</span></label>
            <label class="checkbox_label"><input type="checkbox" id="n2c-resize-avatar" ${s.resizeAvatar ? 'checked' : ''}><span>缩放并重建底图（会转成 PNG）</span></label>
            <label class="checkbox_label"><input type="checkbox" id="n2c-auto-tag" ${s.autoTag ? 'checked' : ''}><span>自动写入标签</span></label>
          </div>

          <div class="n2c-field n2c-field-wide"><span>世界书条目数上限（0 = 由模型决定）</span>
            <input type="number" id="n2c-world-count" class="text_pole" min="0" max="60" step="1" value="${s.worldEntryCount}"></div>

          <div class="n2c-field n2c-field-wide"><span>底图（可选，作为所有角色卡的初始头像）</span>
            <div class="n2c-row">
              <label class="n2c-file-btn menu_button"><i class="fa-solid fa-image"></i> 选择图片
                <input type="file" id="n2c-avatar-file" accept="image/*" hidden></label>
              <div class="menu_button" id="n2c-avatar-clear"><i class="fa-solid fa-xmark"></i> 清除</div>
              <span class="n2c-hint" id="n2c-avatar-info">未选择</span>
            </div>
          </div>

          <div class="n2c-field n2c-field-wide"><span>额外提示词（追加到每个角色的提取要求里）</span>
            <textarea id="n2c-instruction" class="text_pole n2c-textarea" rows="3" placeholder="例如：保留原著的口癖；主角的性别按原文推断，不要默认男性">${escapeHtml(s.extraInstruction)}</textarea></div>

          <div class="n2c-field n2c-field-wide"><span>作者署名 / 版本号</span>
            <div class="n2c-row">
              <input type="text" id="n2c-creator" class="text_pole n2c-grow" value="${escapeHtml(s.creatorName)}">
              <input type="text" id="n2c-version-tag" class="text_pole" style="max-width:110px" value="${escapeHtml(s.cardVersionTag)}">
            </div>
          </div>

          <div class="n2c-row">
            <div class="menu_button" id="n2c-read-card"><i class="fa-solid fa-file-shield"></i> 读取已有角色卡 PNG</div>
            <input type="file" id="n2c-card-file" accept=".png,image/png" hidden>
          </div>
        </div>
      </div>
    </div>

    <div class="n2c-section">
      <div class="n2c-row n2c-log-head">
        <div class="n2c-label">运行日志</div>
        <div class="menu_button n2c-small" id="n2c-clear-log">清空</div>
      </div>
      <div id="n2c-log" class="n2c-log"></div>
    </div>

  </div>
</div>`;
}

function mountPanel() {
    const host = $id('extensions_settings') || $id('extensions_settings2');
    if (!host) {
        console.warn('[小说转角色卡] 找不到扩展设置容器，面板未挂载');
        return false;
    }
    if ($id('n2c-panel')) return true;

    host.insertAdjacentHTML('beforeend', renderPanelHtml());
    bindPanelEvents();
    renderCharacterList();
    updateTextInfo();
    return true;
}

// ================================================================
// 事件绑定
// ================================================================

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

    const bindNumber = (id, key, { min, max }) => {
        $id(id)?.addEventListener('input', event => {
            let value = Number(event.target.value);
            if (!Number.isFinite(value)) return;
            if (min !== undefined) value = Math.max(min, value);
            if (max !== undefined) value = Math.min(max, value);
            s[key] = value;
            putSettings();
        });
    };

    bindNumber('n2c-chunk-chars', 'chunkChars', { min: 1500, max: 20000 });
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
    info.textContent = `${length.toLocaleString()} 字 · 约 ${chunks} 段 · 人物扫描约 ${chunks} 次请求`;
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
        return;
    }

    const rows = state.characters.map((character, index) => {
        const checked = character.selected !== false ? 'checked' : '';
        const confidence = character.profile?.confidence
            ? `<span class="n2c-badge n2c-badge-${escapeHtml(String(character.profile.confidence).toLowerCase())}">${escapeHtml(character.profile.confidence)}</span>`
            : '';
        return `
<div class="n2c-char-row" data-index="${index}">
  <label class="checkbox_label n2c-char-check"><input type="checkbox" class="n2c-char-toggle" ${checked}></label>
  <input type="text" class="text_pole n2c-char-name" value="${escapeHtml(character.name)}">
  <input type="text" class="text_pole n2c-char-role" value="${escapeHtml(character.role || '')}" placeholder="身份定位">
  <span class="n2c-char-meta">${character.chunkIndexes?.length || 0} 段出场 ${confidence}</span>
</div>`;
    }).join('');

    host.innerHTML = rows;

    host.querySelectorAll('.n2c-char-row').forEach(row => {
        const index = Number(row.dataset.index);
        row.querySelector('.n2c-char-toggle')?.addEventListener('change', event => {
            state.characters[index].selected = event.target.checked;
        });
        row.querySelector('.n2c-char-name')?.addEventListener('input', event => {
            state.characters[index].name = event.target.value;
        });
        row.querySelector('.n2c-char-role')?.addEventListener('input', event => {
            state.characters[index].role = event.target.value;
        });
    });
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

    if (!state.profiles.length) {
        host.innerHTML = '<div class="n2c-hint">尚未生成任何角色卡。</div>';
        return;
    }

    host.innerHTML = state.profiles.map((profile, index) => {
        const summary = profile._summary || summarizeCard(profile.cardV3 || profile.cardV2);
        const png = profile._pngBytes;
        const preview = png ? URL.createObjectURL(new Blob([png], { type: 'image/png' })) : '';
        return `
<div class="n2c-result" data-index="${index}">
  ${preview ? `<img class="n2c-result-avatar" src="${preview}" alt="${escapeHtml(summary.name)}">` : ''}
  <div class="n2c-result-body">
    <div class="n2c-result-name">${escapeHtml(summary.name)}</div>
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
// 环境检查
// ================================================================

function requireContext() {
    const context = getContext();
    if (!context) throw new Error('拿不到酒馆上下文 getContext()');
    return context;
}

function buildModelClient() {
    const context = requireContext();
    return createModelClient(context);
}

// ================================================================
// 主流程
// ================================================================

async function runAnalyze() {
    if (state.running) return;
    const settings = getSettings();
    const text = String(state.rawText || '').trim();
    if (!text) {
        toast('warn', '请先载入或粘贴小说文本');
        return;
    }

    const abort = new AbortController();
    state.abort = abort;
    setRunning(true);
    setProgress(2, '准备分段…');
    log(`开始分析：${text.length.toLocaleString()} 字`);

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
        renderCharacterList();
        setProgress(100, `识别完成，共 ${state.characters.length} 人`);
        toast('success', `识别到 ${state.characters.length} 个角色，可以生成角色卡了`);
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
    const settings = getSettings();
    const text = String(state.rawText || '').trim();
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

    const abort = new AbortController();
    state.abort = abort;
    setRunning(true);
    state.profiles = [];
    state.entries = [];
    renderResults();

    const callModel = buildModelClient();
    const sourceName = state.novelTitle || '未命名作品';

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
            setProgress(20 + (index / total) * 70, `提取档案 ${index + 1}/${total}：${character.name}`);
            log(`提取「${character.name}」的人设…`);

            const evidence = collectEvidence(state.chunks, character, {
                maxChunks: Number(settings.evidenceChunks) || 8,
                windowSize: 1500,
                maxChars: 14000,
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
                });
                character.profile = profile;

                const built = await buildProfileCard(character, profile);
                state.profiles.push(built);
                renderResults();
                log(`「${built.name}」完成：正文 ${built._summary.total} 字`);
            } catch (error) {
                log(`「${character.name}」提取失败：${error.message}`, 'error');
            }
        }

        setProgress(100, `完成，共生成 ${state.profiles.length} 张角色卡`);
        if (!state.profiles.length) {
            toast('error', '没有生成出任何角色卡，看日志排查');
            return;
        }
        toast('success', `生成完成，共 ${state.profiles.length} 张角色卡`);

        if (settings.withWorldBook && settings.saveWorldBookFile && state.entries.length) {
            downloadWorldFile();
        }
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
    const text = String(state.rawText || '').trim();
    if (!text) {
        toast('warn', '请先载入或粘贴小说文本');
        return;
    }

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
        toast('success', `世界书已导出，共 ${state.entries.length} 条`);
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
    const name = `${safeFileName(state.novelTitle || '小说')}世界书`;
    const data = buildWorldInfoData(state.entries, {
        name,
        description: `由《${state.novelTitle || '未命名'}》自动提取，共 ${state.entries.length} 条`,
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

    const meta = {
        creator: settings.creatorName || '小说转角色卡',
        version: settings.cardVersionTag || '1.0',
        source: state.novelTitle,
        sources: state.novelTitle ? [state.novelTitle] : [],
        tags: tags.filter(Boolean),
    };

    const cardV2 = buildCardV2(profile, meta);
    const cardV3 = buildCardV3(profile, meta);

    // 世界书：内嵌副本按角色单独命名，避免多张卡共用一个书名互相覆盖
    if (settings.withWorldBook && settings.embedWorldBook && state.entries.length) {
        const bookName = `${name}·${state.novelTitle || '小说'}世界书`;
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
