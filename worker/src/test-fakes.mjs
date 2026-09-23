// Shared in-memory stand-ins for Durable Object state/storage and
// WebSockets, for the worker's node:test suites (no real DO runtime in
// plain Node). The storage fake implements exactly what room-storage.ts
// uses — get / put(entries) / delete(keys) / list({prefix, start,
// startAfter, end, limit}) / transaction() — with transactions that roll
// back on error, like the real thing.

export function makeFakeStorage(opts = {}) {
  let store = new Map();
  let getCalls = 0;
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const storage = {
    async get(key) { getCalls++; return clone(store.get(key)); },
    async put(keyOrEntries, value) {
      if (opts.putFails) throw new Error('simulated storage.put failure');
      if (typeof keyOrEntries === 'string') store.set(keyOrEntries, clone(value));
      else for (const [k, v] of Object.entries(keyOrEntries)) store.set(k, clone(v));
    },
    async delete(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      let n = 0;
      for (const k of list) if (store.delete(k)) n++;
      return Array.isArray(keys) ? n : n > 0;
    },
    async list({ prefix = '', start, startAfter, end, limit } = {}) {
      const out = new Map();
      for (const k of [...store.keys()].sort()) {
        if (!k.startsWith(prefix)) continue;
        if (start !== undefined && k < start) continue;
        if (startAfter !== undefined && k <= startAfter) continue;
        if (end !== undefined && k >= end) continue;
        if (limit !== undefined && out.size >= limit) break;
        out.set(k, clone(store.get(k)));
      }
      return out;
    },
    async deleteAll() { store = new Map(); },
    async transaction(closure) {
      const snapshot = new Map([...store].map(([k, v]) => [k, clone(v)]));
      try { return await closure(storage); } catch (e) { store = snapshot; throw e; }
    },
  };
  return {
    storage,
    get _store() { return store; },
    get _getCalls() { return getCalls; },
  };
}

export function makeFakeState(wsList = [], opts = {}) {
  const fake = makeFakeStorage(opts);
  return {
    storage: fake.storage,
    getWebSockets() { return wsList; },
    get _store() { return fake._store; },
    get _getCalls() { return fake._getCalls; },
  };
}

export function makeFakeWs(attachment) {
  const sent = [];
  return {
    _attachment: attachment,
    deserializeAttachment() { return this._attachment; },
    serializeAttachment(a) { this._attachment = a; },
    send(payload) { sent.push(JSON.parse(payload)); },
    close(code, reason) { this._closed = { code, reason }; },
    _sent: sent,
    _closed: null,
  };
}
