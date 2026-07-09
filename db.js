// db.js — durable storage for Ascension.
// Fixes the recurring "storage fails on mobile" bug by trying the most durable
// backend available and degrading gracefully, all behind one API:
//   IndexedDB  ->  localStorage  ->  in-memory
// The store is an append-only event log. State is derived by core.foldEvents().

const DB_NAME = 'ascension';
const STORE = 'events';
const LS_KEY = 'ascension.events.v1';
const DEV_KEY = 'ascension.device';

function makeDeviceId() {
  try {
    let id = localStorage.getItem(DEV_KEY);
    if (!id) { id = 'dev_' + Math.random().toString(36).slice(2, 10); localStorage.setItem(DEV_KEY, id); }
    return id;
  } catch { return 'dev_' + Math.random().toString(36).slice(2, 10); }
}

/* ---- IndexedDB adapter (preferred: durable, structured, survives reload) ---- */
function openIDB() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) return reject(new Error('no idb'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('idb open failed'));
  });
}

class IDBStore {
  constructor(db) { this.db = db; this.kind = 'indexeddb'; }
  _tx(mode) { return this.db.transaction(STORE, mode).objectStore(STORE); }
  append(evt) {
    return new Promise((res, rej) => { const r = this._tx('readwrite').add(evt); r.onsuccess = () => res(evt); r.onerror = () => rej(r.error); });
  }
  all() {
    return new Promise((res, rej) => { const r = this._tx('readonly').getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error); });
  }
  bulk(evts) {
    return new Promise((res, rej) => {
      const tx = this.db.transaction(STORE, 'readwrite'); const os = tx.objectStore(STORE);
      for (const e of evts) os.put(e); tx.oncomplete = () => res(evts.length); tx.onerror = () => rej(tx.error);
    });
  }
  clear() {
    return new Promise((res, rej) => { const r = this._tx('readwrite').clear(); r.onsuccess = () => res(); r.onerror = () => rej(r.error); });
  }
}

/* ---- localStorage adapter (fallback: durable-ish, simple) ---- */
class LSStore {
  constructor() { this.kind = 'localstorage'; }
  _read() { try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; } }
  _write(a) { localStorage.setItem(LS_KEY, JSON.stringify(a)); }
  async append(evt) { const a = this._read(); a.push(evt); this._write(a); return evt; }
  async all() { return this._read(); }
  async bulk(evts) { const a = this._read(); const ids = new Set(a.map((e) => e.id)); for (const e of evts) if (!ids.has(e.id)) a.push(e); this._write(a); return evts.length; }
  async clear() { this._write([]); }
}

/* ---- in-memory adapter (last resort: at least the session works) ---- */
class MemStore {
  constructor() { this.kind = 'memory'; this.a = []; }
  async append(evt) { this.a.push(evt); return evt; }
  async all() { return this.a.slice(); }
  async bulk(evts) { const ids = new Set(this.a.map((e) => e.id)); for (const e of evts) if (!ids.has(e.id)) this.a.push(e); return evts.length; }
  async clear() { this.a = []; }
}

export async function openStore() {
  const deviceId = makeDeviceId();
  let store;
  try {
    store = new IDBStore(await openIDB());
    // If IDB opened but a previous run wrote to localStorage, migrate it in.
    try { const legacy = JSON.parse(localStorage.getItem(LS_KEY) || '[]'); if (legacy.length) await store.bulk(legacy); } catch {}
  } catch {
    try { const t = '__ascension_probe__'; localStorage.setItem(t, '1'); localStorage.removeItem(t); store = new LSStore(); }
    catch { store = new MemStore(); }
  }
  return {
    deviceId,
    backend: store.kind,
    append: (evt) => store.append(evt),
    all: () => store.all(),
    import: (evts) => store.bulk(evts),
    clear: () => store.clear(),
  };
}
