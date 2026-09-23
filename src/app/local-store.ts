// The browser's own copy of project data (for instant startup and offline
// viewing) lives in IndexedDB. It used to be in localStorage, which
// browsers cap at about 5 MB per site: roughly 600 jobs. IndexedDB allows
// hundreds of MB. The copy is stored as the same JSON text as before, so
// what gets saved is unchanged; only where it lives moved.
//
// Each copy carries its save time. On a page close, IndexedDB may not
// finish a write, so flushProjectsToLocalCache() (src/app/project.ts)
// also writes localStorage there when the data fits. Startup reads both
// and uses the newer one.
const DB_NAME = 'teamsync-local';
const STORE = 'kv';
const PROJECTS_RECORD = 'projects';
const OPEN_TIMEOUT_MS = 3000;

export interface LocalCopy { text: string; savedAt: number }

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(function (resolve) {
    let done = false;
    const finish = function (db: IDBDatabase | null) { if (!done) { done = true; resolve(db); } };
    // Never let a stuck or blocked database hold up startup.
    setTimeout(function () { finish(null); }, OPEN_TIMEOUT_MS);
    try {
      if (typeof indexedDB === 'undefined') { finish(null); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(STORE); };
      req.onsuccess = function () { finish(req.result); };
      req.onerror = function () { finish(null); };
      req.onblocked = function () { finish(null); };
    } catch (e) {
      finish(null);
    }
  });
  return dbPromise;
}

export async function readIdbProjects(): Promise<LocalCopy | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise(function (resolve) {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(PROJECTS_RECORD);
      req.onsuccess = function () {
        const v = req.result;
        resolve(v && typeof v.text === 'string' && typeof v.savedAt === 'number' ? v : null);
      };
      req.onerror = function () { resolve(null); };
    } catch (e) {
      resolve(null);
    }
  });
}

// Resolves true once the write is committed, false if it couldn't be.
export async function writeIdbProjects(copy: LocalCopy): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;
  return new Promise(function (resolve) {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(copy, PROJECTS_RECORD);
      tx.oncomplete = function () { resolve(true); };
      tx.onerror = function () { resolve(false); };
      tx.onabort = function () { resolve(false); };
    } catch (e) {
      resolve(false);
    }
  });
}
