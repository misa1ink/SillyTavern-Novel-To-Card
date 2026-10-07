/**
 * IndexedDB 的最小内存实现，够 tests/harness.mjs 验证存档往返。
 * 只实现本项目用到的部分：open / objectStore / put / get / getAll / delete / index。
 */

class FakeRequest {
    constructor() {
        this.result = undefined;
        this.error = null;
        this.onsuccess = null;
        this.onerror = null;
        this.onupgradeneeded = null;
    }
}

class FakeObjectStore {
    constructor(name, data) {
        this.name = name;
        this._data = data;
        this.keyPath = null;
        this._indexes = new Map();
    }

    createIndex(name) {
        this._indexes.set(name, true);
        return { name };
    }

    put(record) {
        const request = new FakeRequest();
        const key = record[this.keyPath] ?? record.id;
        this._data.set(key, structuredCloneLite(record));
        queueMicrotask(() => {
            request.result = key;
            request.onsuccess?.();
        });
        return request;
    }

    get(key) {
        const request = new FakeRequest();
        const present = this._data.has(key);
        queueMicrotask(() => {
            request.result = present ? this._data.get(key) : undefined;
            request.onsuccess?.();
        });
        return request;
    }

    getAll() {
        const request = new FakeRequest();
        queueMicrotask(() => {
            request.result = [...this._data.values()];
            request.onsuccess?.();
        });
        return request;
    }

    delete(key) {
        const request = new FakeRequest();
        this._data.delete(key);
        queueMicrotask(() => {
            request.result = undefined;
            request.onsuccess?.();
        });
        return request;
    }
}

class FakeTransaction {
    constructor(stores) {
        this._stores = stores;
        this.error = null;
        this.oncomplete = null;
        this.onerror = null;
        this.onabort = null;
        this.objectStoreNames = { contains: name => stores.has(name) };
    }

    objectStore(name) {
        const store = this._stores.get(name);
        if (!store) throw new Error(`No object store named ${name}`);
        return store;
    }

    /** 事务在微任务里统一收尾，模拟 IndexedDB 的异步语义 */
    _finish() {
        queueMicrotask(() => {
            queueMicrotask(() => this.oncomplete?.());
        });
    }
}

class FakeDb {
    constructor(name, version) {
        this.name = name;
        this.version = version;
        this._stores = new Map();
        this.objectStoreNames = { contains: name => this._stores.has(name) };
        FakeDb.instances.set(name, this);
    }

    static instances = new Map();

    createObjectStore(name, options = {}) {
        const store = new FakeObjectStore(name, new Map());
        store.keyPath = options.keyPath;
        this._stores.set(name, store);
        return store;
    }

    transaction(name, _mode) {
        const tx = new FakeTransaction(this._stores);
        // put/get/delete 都是异步完成的，这里在下一次微任务里触发 oncomplete
        queueMicrotask(() => {
            queueMicrotask(() => queueMicrotask(() => tx.oncomplete?.()));
        });
        return tx;
    }

    close() {}
}

function structuredCloneLite(value) {
    return JSON.parse(JSON.stringify(value));
}

/** 装到 sandbox 上的 indexedDB 工厂 */
export function createFakeIndexedDB() {
    return {
        open(name, version) {
            const request = new FakeRequest();
            // 用 setTimeout 而不是 microtask：持久层是 open.onupgradeneeded = ... ; open.onsuccess = ...
            // 同步赋值的，若在 microtask 里就触发，upgradeneeded 还没挂上，建表会丢。
            setTimeout(() => {
                let db = FakeDb.instances.get(name);
                const isNew = !db;
                if (!db) db = new FakeDb(name, version);
                request.result = db;
                if (isNew) request.onupgradeneeded?.();
                request.onsuccess?.();
            }, 0);
            return request;
        },
        /** 测试用：清空所有实例，模拟「重开酒馆」 */
        _reset() {
            FakeDb.instances.clear();
        },
        get _instances() {
            return FakeDb.instances;
        },
    };
}
