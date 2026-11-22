// Persistent storage (IndexedDB) for things too big for localStorage: imported override files,
// custom mod jars and custom item textures. Every call degrades to a no-op when IndexedDB is
// unavailable (private windows), so the editor keeps working session-only.
const DB_NAME = 'modular_files';
const STORES = ['overrides', 'jars', 'textures'];

let dbPromise;
function openDb() {
  dbPromise ??= new Promise(resolve => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => STORES.forEach(s => req.result.createObjectStore(s, { keyPath: 'key' }));
      req.onsuccess = () => resolve(req.result);
      req.onerror = req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise(resolve => {
    try {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = tx.onabort = () => resolve(undefined);
    } catch { resolve(undefined); }
  });
}

export const putRecord = (store, key, value) => run(store, 'readwrite', s => s.put({ key, value }));
export const deleteRecord = (store, key) => run(store, 'readwrite', s => s.delete(key));
export const clearStore = store => run(store, 'readwrite', s => s.clear());
export const getRecord = async (store, key) => (await run(store, 'readonly', s => s.get(key)))?.value ?? null;
export const getAllRecords = async store => (await run(store, 'readonly', s => s.getAll())) ?? [];

/** Asks the browser not to evict our data under storage pressure. Best effort. */
export const requestPersistence = () => navigator.storage?.persist?.().catch(() => false);
