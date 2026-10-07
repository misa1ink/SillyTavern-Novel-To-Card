/**
 * PNG 角色卡编解码。
 *
 * 角色卡规范（SillyTavern Character Card V2 / Character Card V3）把卡面 JSON
 * 以 base64 文本形式放进 PNG 的 tEXt 区块：
 *   - tEXt 关键字 `chara` → V2 卡 JSON 的 base64
 *   - tEXt 关键字 `ccv3`  → V3 卡 JSON 的 base64
 *
 * 因此导出「PNG 角色卡」= 拿一张底图，在 IHDR 之后插入这两个 tEXt 区块，
 * 像素数据（IDAT）完全不重新编码，画质无损、体积不涨。
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** tEXt 关键字只允许 Latin-1 可打印字符（0x20-0x7E，空格除外开头），base64 满足要求。 */
const TEXT_KEYWORDS = ['chara', 'ccv3'];

// ---------------------------------------------------------------- CRC32

let crcTable = null;

function getCrcTable() {
    if (crcTable) return crcTable;
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        crcTable[n] = c >>> 0;
    }
    return crcTable;
}

export function crc32(bytes) {
    const table = getCrcTable();
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
        crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------- base64 / utf8

export function utf8ToBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

export function base64ToUtf8(base64) {
    const clean = String(base64).replace(/\s+/g, '');
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder('utf-8').decode(bytes);
}

// ---------------------------------------------------------------- chunk 读写

/** 是否是一张 PNG（只查签名，不解码） */
export function isPngBytes(bytes) {
    if (!bytes || bytes.length < 8) return false;
    return PNG_SIGNATURE.every((value, index) => bytes[index] === value);
}

/**
 * 遍历 PNG 区块。
 * @param {Uint8Array} bytes
 * @returns {{type: string, start: number, dataStart: number, dataLength: number, totalLength: number}[]}
 */
export function readChunks(bytes) {
    const chunks = [];
    let offset = 8;
    while (offset + 12 <= bytes.length) {
        const length = (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
        if (length < 0) break;
        const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
        const totalLength = 12 + length;
        if (offset + totalLength > bytes.length) break;
        chunks.push({
            type,
            start: offset,
            dataStart: offset + 8,
            dataLength: length,
            totalLength,
        });
        if (type === 'IEND') break;
        offset += totalLength;
    }
    return chunks;
}

/** 只取 tEXt 区块（role 卡数据只会出现在这里），不做 zlib 解压。 */
function extractTextChunks(bytes) {
    const result = {};
    for (const chunk of readChunks(bytes)) {
        if (chunk.type !== 'tEXt') continue;
        const data = bytes.subarray(chunk.dataStart, chunk.dataStart + chunk.dataLength);
        const zero = data.indexOf(0);
        if (zero < 0) continue;
        const keyword = String.fromCharCode.apply(null, data.subarray(0, zero));
        if (!TEXT_KEYWORDS.includes(keyword)) continue;
        let text = '';
        for (let i = zero + 1; i < data.length; i++) text += String.fromCharCode(data[i]);
        result[keyword] = text;
    }
    return result;
}

/**
 * 组装一个 tEXt 区块：[长度(4)][类型(4)][关键字][0x00][文本][CRC(4)]
 * 共 12 字节开销 + 数据长度。
 */
function buildTextChunk(keyword, text) {
    const keywordBytes = new TextEncoder().encode(keyword);
    const textBytes = new TextEncoder().encode(text);
    const dataLength = keywordBytes.length + 1 + textBytes.length;

    const out = new Uint8Array(12 + dataLength);
    const view = new DataView(out.buffer);

    view.setUint32(0, dataLength);
    out[4] = 0x74; // t
    out[5] = 0x45; // E
    out[6] = 0x58; // X
    out[7] = 0x74; // t
    out.set(keywordBytes, 8);
    out[8 + keywordBytes.length] = 0;
    out.set(textBytes, 9 + keywordBytes.length);

    // CRC 覆盖「类型 + 数据」，逐字节计算，不做偏移假设
    let crc = 0xffffffff;
    const table = getCrcTable();
    for (let i = 4; i < 8 + dataLength; i++) {
        crc = table[(crc ^ out[i]) & 0xff] ^ (crc >>> 8);
    }
    view.setUint32(8 + dataLength, (crc ^ 0xffffffff) >>> 0);
    return out;
}

/**
 * 把角色卡数据嵌入 PNG，返回新的 PNG 字节。
 * 若原图已带 chara/ccv3 区块则先剔除，避免出现重复关键字。
 *
 * @param {Uint8Array} pngBytes 源 PNG
 * @param {{chara?: string, ccv3?: string}} payload 已 base64 的卡数据
 * @returns {Uint8Array}
 */
export function embedCardIntoPng(pngBytes, payload) {
    if (!isPngBytes(pngBytes)) {
        throw new Error('源文件不是合法的 PNG 图片');
    }

    const chunks = readChunks(pngBytes);
    const ihdrIndex = chunks.findIndex(chunk => chunk.type === 'IHDR');
    if (ihdrIndex < 0) {
        throw new Error('PNG 缺少 IHDR 区块，文件可能已损坏');
    }

    const insertionOffset = chunks[ihdrIndex].start + chunks[ihdrIndex].totalLength;
    const pieces = [pngBytes.subarray(0, insertionOffset)];

    if (payload.chara) pieces.push(buildTextChunk('chara', payload.chara));
    if (payload.ccv3) pieces.push(buildTextChunk('ccv3', payload.ccv3));

    // IHDR 之后原样保留所有剩余区块（包括原有的 IDAT/IEND），只略过旧的卡数据区块
    for (const chunk of chunks) {
        if (chunk.start < insertionOffset) continue;
        if (chunk.type === 'tEXt') {
            const data = pngBytes.subarray(chunk.dataStart, chunk.dataStart + chunk.dataLength);
            const zero = data.indexOf(0);
            const keyword = zero > 0 ? String.fromCharCode.apply(null, data.subarray(0, zero)) : '';
            if (TEXT_KEYWORDS.includes(keyword)) continue;
        }
        pieces.push(pngBytes.subarray(chunk.start, chunk.start + chunk.totalLength));
    }

    const total = pieces.reduce((sum, piece) => sum + piece.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const piece of pieces) {
        merged.set(piece, offset);
        offset += piece.length;
    }
    return merged;
}

/**
 * 从 PNG 字节中读出角色卡 JSON 对象。读不到返回 null。
 * @param {Uint8Array} pngBytes
 */
export function readCardFromPng(pngBytes) {
    if (!isPngBytes(pngBytes)) return null;
    const textChunks = extractTextChunks(pngBytes);
    for (const keyword of ['ccv3', 'chara']) {
        const raw = textChunks[keyword];
        if (!raw) continue;
        try {
            return JSON.parse(base64ToUtf8(raw));
        } catch (error) {
            console.warn(`[小说转角色卡] ${keyword} 区块解析失败：`, error);
        }
    }
    return null;
}

/** 一张 PNG 是否已经是角色卡 */
export function hasEmbeddedCard(pngBytes) {
    return readCardFromPng(pngBytes) !== null;
}

// ---------------------------------------------------------------- 图片处理

/**
 * 把任意浏览器可解码的图片压成不超过 maxSize 的 PNG 字节。
 * 用于统一头像尺寸并控制文件体积；JPEG 转 PNG 会变大，由调用方决定是否值得。
 *
 * @param {Blob|File} file
 * @param {{maxSize?: number}} options
 * @returns {Promise<Uint8Array>}
 */
export async function imageToPngBytes(file, options = {}) {
    const { maxSize = 512 } = options;
    const bitmap = await loadBitmap(file);

    const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, width, height);
    if (typeof bitmap.close === 'function') bitmap.close();

    const blob = await new Promise((resolve, reject) => {
        canvas.toBlob(result => (result ? resolve(result) : reject(new Error('canvas 导出 PNG 失败'))), 'image/png');
    });
    return new Uint8Array(await blob.arrayBuffer());
}

async function loadBitmap(file) {
    if (typeof createImageBitmap === 'function') {
        try {
            return await createImageBitmap(file);
        } catch {
            // 回退到 <img>，兼容 WebView 对部分编码支持不全的情况
        }
    }
    const url = URL.createObjectURL(file);
    try {
        const img = new Image();
        await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = () => reject(new Error('图片解码失败'));
            img.src = url;
        });
        return img;
    } finally {
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }
}

/**
 * 没有立绘时生成一张占位头像：深色渐变 + 角色名首字。
 * @param {string} name
 * @param {{size?: number, seed?: number}} options
 */
export async function generatePlaceholderPng(name, options = {}) {
    const { size = 512, seed = 0 } = options;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    const hue = (hashString(name) + seed * 47) % 360;
    const gradient = ctx.createLinearGradient(0, 0, size, size);
    gradient.addColorStop(0, `hsl(${hue}, 45%, 22%)`);
    gradient.addColorStop(1, `hsl(${(hue + 55) % 360}, 40%, 12%)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);

    // 轻微噪点，避免大面积纯色在聊天 UI 里显得突兀
    const noise = ctx.getImageData(0, 0, size, size);
    for (let i = 0; i < noise.data.length; i += 4) {
        const delta = (Math.random() - 0.5) * 10;
        noise.data[i] += delta;
        noise.data[i + 1] += delta;
        noise.data[i + 2] += delta;
    }
    ctx.putImageData(noise, 0, 0);

    const glyph = firstGlyph(name);
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = `bold ${Math.round(size * 0.42)}px "Noto Serif SC", "Source Han Serif SC", "Microsoft YaHei", serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(glyph, size / 2, size / 2 - size * 0.02);

    ctx.fillStyle = 'rgba(255,255,255,0.62)';
    ctx.font = `${Math.round(size * 0.055)}px "Microsoft YaHei", sans-serif`;
    const label = String(name || '').slice(0, 12);
    ctx.fillText(label, size / 2, size * 0.8);

    const blob = await new Promise((resolve, reject) => {
        canvas.toBlob(result => (result ? resolve(result) : reject(new Error('canvas 导出 PNG 失败'))), 'image/png');
    });
    return new Uint8Array(await blob.arrayBuffer());
}

function firstGlyph(name) {
    const text = String(name || '').trim();
    if (!text) return '?';
    const chars = Array.from(text.replace(/[\s·・\-_]+/g, ''));
    return chars[0] || '?';
}

function hashString(text) {
    let hash = 0;
    const str = String(text || '');
    for (let i = 0; i < str.length; i++) {
        hash = (hash * 31 + str.charCodeAt(i)) % 100000;
    }
    return hash;
}

// ---------------------------------------------------------------- 文件读写

export function downloadBytes(bytes, filename, mime = 'image/png') {
    const blob = new Blob([bytes], { type: mime });
    downloadBlob(blob, filename);
}

export function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(new Error(`读取文件失败：${file?.name || ''}`));
        reader.readAsText(file, 'utf-8');
    });
}

export function readFileAsBytes(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(new Uint8Array(reader.result));
        reader.onerror = () => reject(new Error(`读取文件失败：${file?.name || ''}`));
        reader.readAsArrayBuffer(file);
    });
}
