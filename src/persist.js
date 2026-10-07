/**
 * 中途存档：把长任务的进度持久化到 IndexedDB。
 *
 * 为什么不用 extension_settings / localStorage：
 * 300 万字的小说正文就有约 6MB，而 localStorage 上限通常 5MB，
 * 且 extension_settings 每次保存会整包序列化，塞正文进去会拖垮酒馆。
 * IndexedDB 没有这个限制，也不参与酒馆的设置读写链路。
 *
 * 存的是一次完整快照：正文 + 分卷 + 已切分段 + 候选角色 + 已出卡档案 + 世界书 + 日志。
 * 存的是 JSON 字符串，避免结构化克隆遇到 getter / 代理时报错。
 */

const DB_NAME = 'novel_to_card';
const DB_VERSION = 1;
const STORE = 'snapshots';

/** 快照格式版本；将来字段有变动时用它做兼容判断 */
export const SNAPSHOT_VERSION = 1;

function openDb() {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('当前环境不支持 IndexedDB，无法存档'));
            return;
        }
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE)) {
                const store = db.createObjectStore(STORE, { keyPath: 'id' });
                store.createIndex('savedAt', 'savedAt');
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new Error(`打开存档库失败：${request.error?.message || '未知错误'}`));
    });
}

/**
 * 在一个事务里执行操作。
 *
 * 关键点：判断 `fn` 的返回值「是不是一个 IDBRequest」，靠的是有没有 onsuccess/onerror，
 * 而不是看它的 `result` 有没有值——`result` 是异步回填的，未完成时就是 undefined，
 * 按值判断会把请求对象本身当成结果返回（删除后读回、空结果 get 都会踩到）。
 */
function withStore(db, mode, fn) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const store = tx.objectStore(STORE);
        let request;
        try {
            request = fn(store);
        } catch (error) {
            reject(error);
            return;
        }

        const isRequest = request && typeof request === 'object'
            && ('onsuccess' in request || 'onerror' in request);

        if (isRequest) {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(new Error(request.error?.message || '存档操作失败'));
        }

        tx.oncomplete = () => { if (!isRequest) resolve(request); };
        tx.onerror = () => reject(new Error(tx.error?.message || '存档事务失败'));
        tx.onabort = () => reject(new Error(tx.error?.message || '存档事务被中止'));
    });
}

/**
 * 写入一份快照。同名 id 会覆盖。
 * @param {{id?: string, name: string, state: object}} snapshot
 * @returns {Promise<{id: string, savedAt: number, bytes: number}>}
 */
export async function saveSnapshot({ id, name, state }) {
    const db = await openDb();
    try {
        const payload = JSON.stringify(state);
        const record = {
            id: id || `snap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: String(name || '未命名存档').slice(0, 80),
            savedAt: Date.now(),
            version: SNAPSHOT_VERSION,
            bytes: payload.length,
            state: payload,
        };
        await withStore(db, 'readwrite', store => store.put(record));
        return { id: record.id, savedAt: record.savedAt, bytes: record.bytes };
    } finally {
        db.close();
    }
}

/**
 * 列出所有存档的摘要（不含 state 本体，避免一次读出几 MB）。
 */
export async function listSnapshots() {
    const db = await openDb();
    try {
        const records = await withStore(db, 'readonly', store => store.getAll());
        return (Array.isArray(records) ? records : [])
            .map(record => ({
                id: record.id,
                name: record.name,
                savedAt: record.savedAt,
                bytes: record.bytes,
                version: record.version,
            }))
            .sort((left, right) => right.savedAt - left.savedAt);
    } finally {
        db.close();
    }
}

/**
 * 读取一份存档并还原 state。
 * @returns {Promise<{id: string, name: string, savedAt: number, state: object}|null>}
 */
export async function loadSnapshot(id) {
    const db = await openDb();
    try {
        const record = await withStore(db, 'readonly', store => store.get(id));
        if (!record) return null;
        let state;
        try {
            state = JSON.parse(record.state);
        } catch (error) {
            throw new Error(`存档内容已损坏：${error.message}`);
        }
        if (record.version !== SNAPSHOT_VERSION) {
            console.warn(`[小说转角色卡] 存档版本 ${record.version} 与当前 ${SNAPSHOT_VERSION} 不一致，尝试按现有字段还原`);
        }
        return { id: record.id, name: record.name, savedAt: record.savedAt, state };
    } finally {
        db.close();
    }
}

export async function deleteSnapshot(id) {
    const db = await openDb();
    try {
        await withStore(db, 'readwrite', store => store.delete(id));
    } finally {
        db.close();
    }
}

/** 只取最近一份存档的摘要，用于启动时提示「是否继续上次」 */
export async function latestSnapshot() {
    const list = await listSnapshots();
    return list[0] || null;
}

/** 格式化字节数，给 UI 显示 */
export function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

/** 格式化时间戳 */
export function formatTime(timestamp) {
    try {
        return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
    } catch {
        return String(timestamp);
    }
}
