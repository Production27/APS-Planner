// --- ROOM STORAGE — how the room's state is laid out in the Durable
// Object's storage. ---
//
// Layout v2 ("itemized"): one storage entry per job, card and calendar
// event, plus one per project for everything else, plus a room-level
// index:
//   meta                                  { version: 2, projects: [pid, ...], migratedFromLegacyAt? }
//   p|<pid>|meta                          project minus jobs/boardCards/calendarEvents
//   p|<pid>|j|<id>  p|<pid>|c|<id>  p|<pid>|e|<id>   one job / card / event
// (pid and id are encodeURIComponent()-ed, so a '|' can never appear
// inside either.)
//
// Replaces layout v1: the whole room — every project, archived jobs
// included — stored as ONE value under 'room'. Cloudflare caps a single
// value at 2 MB, which a realistic room reaches at roughly 250 jobs, and
// every edit rewrote the entire value. Now an edit writes only the one or
// two entries it touched (see writeRoomChange()), and the only size limit
// left is per job/card/event and per project's settings.
//
// Migration (migrateLegacyRoom()) is copy-then-verify: the v1 value is
// copied into v2 entries, read back, and compared field for field before
// the 'meta' marker that makes v2 authoritative is written. The v1 'room'
// value itself is never deleted or modified afterwards — it stays as a
// frozen copy of the pre-migration data.
import type { RoomState, Project } from './types.ts';
import type { RoomDelta } from './room-state.ts';
import { deepEqual } from './room-state.ts';

export const LEGACY_KEY = 'room';
export const META_KEY = 'meta';
export const LAYOUT_VERSION = 2;

// Storage writes are grouped this many keys at a time (Cloudflare's own
// per-call cap for put(entries)/delete(keys)).
const BATCH = 128;

const KIND_CODES = { jobs: 'j', boardCards: 'c', calendarEvents: 'e' } as const;
type ItemKind = keyof typeof KIND_CODES;
const KINDS = Object.keys(KIND_CODES) as ItemKind[];
const KIND_BY_CODE: Record<string, ItemKind> = { j: 'jobs', c: 'boardCards', e: 'calendarEvents' };

export interface RoomMeta {
  version: number;
  projects: string[];
  migratedFromLegacyAt?: number;
}

// The subset of DurableObjectStorage this module uses — lets tests pass a
// plain in-memory fake.
export interface KvStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
  delete(keys: string[]): Promise<number>;
  list<T = unknown>(options: { prefix: string }): Promise<Map<string, T>>;
  transaction<T>(closure: (txn: KvStorage) => Promise<T>): Promise<T>;
}

const enc = encodeURIComponent;
export function projectPrefix(pid: string): string { return 'p|' + enc(pid) + '|'; }
export function projectMetaKey(pid: string): string { return projectPrefix(pid) + 'meta'; }
export function itemKey(pid: string, kind: ItemKind, id: string): string { return projectPrefix(pid) + KIND_CODES[kind] + '|' + enc(id); }

function projectMetaOf(project: Project): Record<string, unknown> {
  const meta: Record<string, unknown> = { ...project };
  KINDS.forEach(function (k) { delete meta[k]; });
  return meta;
}

// Every entry a project occupies, keyed by storage key.
function projectEntries(pid: string, project: Project): Record<string, unknown> {
  const out: Record<string, unknown> = { [projectMetaKey(pid)]: projectMetaOf(project) };
  KINDS.forEach(function (kind) {
    const map = (project[kind] || {}) as Record<string, unknown>;
    Object.keys(map).forEach(function (id) { out[itemKey(pid, kind, id)] = map[id]; });
  });
  return out;
}

async function putAll(s: KvStorage, entries: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(entries);
  for (let i = 0; i < keys.length; i += BATCH) {
    const chunk: Record<string, unknown> = {};
    keys.slice(i, i + BATCH).forEach(function (k) { chunk[k] = entries[k]; });
    await s.put(chunk);
  }
}
async function deleteAll(s: KvStorage, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += BATCH) await s.delete(keys.slice(i, i + BATCH));
}

// Reads a v2 room. Returns null if there's no v2 'meta' marker yet.
export async function readItemizedRoom(s: KvStorage): Promise<RoomState | null> {
  const meta = await s.get<RoomMeta>(META_KEY);
  if (!meta || meta.version !== LAYOUT_VERSION) return null;
  const state: RoomState = { projects: {} };
  for (const pid of meta.projects || []) {
    const rows = await s.list<unknown>({ prefix: projectPrefix(pid) });
    const pmeta = rows.get(projectMetaKey(pid)) as Record<string, unknown> | undefined;
    if (!pmeta) continue;
    const project = { ...pmeta, jobs: {}, boardCards: {}, calendarEvents: {} } as unknown as Project;
    const prefixLen = projectPrefix(pid).length;
    rows.forEach(function (value, key) {
      const rest = key.slice(prefixLen);
      const sep = rest.indexOf('|');
      if (sep !== 1) return; // the project's own 'meta' row, or anything unexpected
      const kind = KIND_BY_CODE[rest[0]];
      if (!kind) return;
      (project[kind] as Record<string, unknown>)[decodeURIComponent(rest.slice(2))] = value;
    });
    state.projects[pid] = project;
  }
  return state;
}

// Replaces whatever v2 entries exist with exactly `state` (used for the
// migration, for an import/restore, and for a brand-new empty room).
export async function writeFullRoom(s: KvStorage, state: RoomState, extraMeta?: Partial<RoomMeta>): Promise<void> {
  await s.transaction(async function (txn) {
    const existing = await txn.list<unknown>({ prefix: 'p|' });
    const next: Record<string, unknown> = {};
    Object.keys(state.projects || {}).forEach(function (pid) { Object.assign(next, projectEntries(pid, state.projects[pid])); });
    const stale = Array.from(existing.keys()).filter(function (k) { return !(k in next); });
    await deleteAll(txn, stale);
    await putAll(txn, next);
    const meta: RoomMeta = { version: LAYOUT_VERSION, projects: Object.keys(state.projects || {}), ...(extraMeta || {}) };
    await txn.put({ [META_KEY]: meta });
  });
}

// Persists one accepted write, given what it changed (computeRoomDelta()):
// changed items are put, removed items deleted, and a project's settings
// entry rewritten only if one of its settings changed. All in one
// transaction, so a failure leaves storage exactly as it was.
export async function writeRoomChange(s: KvStorage, next: RoomState, delta: RoomDelta): Promise<void> {
  await s.transaction(async function (txn) {
    const puts: Record<string, unknown> = {};
    const deletes: string[] = [];
    let projectListChanged = false;
    for (const pid of Object.keys(delta.projects)) {
      const d = delta.projects[pid] as Record<string, unknown>;
      if (d.projectRemoved) {
        const rows = await txn.list<unknown>({ prefix: projectPrefix(pid) });
        deletes.push(...Array.from(rows.keys()));
        projectListChanged = true;
        continue;
      }
      const project = next.projects[pid];
      if (d.replace) {
        Object.assign(puts, projectEntries(pid, project));
        projectListChanged = true;
        continue;
      }
      let settingsChanged = false;
      Object.keys(d).forEach(function (k) {
        if ((KINDS as string[]).indexOf(k) !== -1) {
          const changed = d[k] as Record<string, unknown>;
          Object.keys(changed).forEach(function (id) { puts[itemKey(pid, k as ItemKind, id)] = changed[id]; });
        } else if (k === 'removedIds') {
          const removed = d[k] as Partial<Record<ItemKind, string[]>>;
          KINDS.forEach(function (kind) { (removed[kind] || []).forEach(function (id) { deletes.push(itemKey(pid, kind, id)); }); });
        } else {
          settingsChanged = true;
        }
      });
      if (settingsChanged) puts[projectMetaKey(pid)] = projectMetaOf(project);
    }
    await deleteAll(txn, deletes);
    await putAll(txn, puts);
    if (projectListChanged) {
      const meta = (await txn.get<RoomMeta>(META_KEY)) || { version: LAYOUT_VERSION, projects: [] };
      await txn.put({ [META_KEY]: { ...meta, projects: Object.keys(next.projects) } });
    }
  });
}

export interface MigrationResult {
  ok: boolean;
  jobs: number;
  cards: number;
  events: number;
  error?: string;
}

// Copies the v1 'room' value into the v2 layout, then reads it back and
// compares. Only a successful comparison writes the 'meta' marker that
// makes v2 authoritative; on any mismatch or error the v2 entries are
// cleared again and the caller keeps running on v1, exactly as before.
export async function migrateLegacyRoom(s: KvStorage, legacy: RoomState): Promise<MigrationResult> {
  const counts = { jobs: 0, cards: 0, events: 0 };
  Object.values(legacy.projects || {}).forEach(function (p) {
    counts.jobs += Object.keys(p.jobs || {}).length;
    counts.cards += Object.keys(p.boardCards || {}).length;
    counts.events += Object.keys(p.calendarEvents || {}).length;
  });
  try {
    // Written without the marker first, so a crash mid-way can't leave a
    // half-copied v2 room looking authoritative.
    await s.transaction(async function (txn) {
      const existing = await txn.list<unknown>({ prefix: 'p|' });
      await deleteAll(txn, Array.from(existing.keys()));
      const entries: Record<string, unknown> = {};
      Object.keys(legacy.projects || {}).forEach(function (pid) { Object.assign(entries, projectEntries(pid, legacy.projects[pid])); });
      await putAll(txn, entries);
      await txn.delete([META_KEY]);
    });
    const readBack = await readWithoutMarker(s, Object.keys(legacy.projects || {}));
    if (!deepEqual(normalizeForCompare(readBack), normalizeForCompare(legacy))) {
      await clearItemized(s);
      return { ok: false, ...counts, error: 'read-back did not match the original' };
    }
    await s.put({ [META_KEY]: { version: LAYOUT_VERSION, projects: Object.keys(legacy.projects || {}), migratedFromLegacyAt: Date.now() } as RoomMeta });
    return { ok: true, ...counts };
  } catch (e) {
    try { await clearItemized(s); } catch (e2) { /* best effort */ }
    return { ok: false, ...counts, error: String(e) };
  }
}

async function readWithoutMarker(s: KvStorage, pids: string[]): Promise<RoomState> {
  // readItemizedRoom() requires the marker; stage a temporary in-memory
  // view of it instead of writing one.
  const view: KvStorage = {
    get: async function <T>(key: string) { return (key === META_KEY ? { version: LAYOUT_VERSION, projects: pids } : await s.get(key)) as T | undefined; },
    put: s.put.bind(s), delete: s.delete.bind(s), list: s.list.bind(s), transaction: s.transaction.bind(s),
  };
  return (await readItemizedRoom(view)) as RoomState;
}

async function clearItemized(s: KvStorage): Promise<void> {
  await s.transaction(async function (txn) {
    const existing = await txn.list<unknown>({ prefix: 'p|' });
    await deleteAll(txn, Array.from(existing.keys()));
    await txn.delete([META_KEY]);
  });
}

// Key order inside an object doesn't matter for equality; deepEqual()
// already ignores it. Undefined-valued keys don't survive storage, so
// drop them before comparing.
function normalizeForCompare(state: RoomState): RoomState {
  return JSON.parse(JSON.stringify(state));
}
