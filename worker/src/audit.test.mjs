// Audit trail (audit.ts, ApsRoom's audit storage) and the admin export
// endpoints (compliance.ts). Run with:
//   node --test worker/src/audit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeChange, auditKey, AUDIT_PREFIX, AUDIT_RETENTION_DAYS, AUDIT_MAX_ROWS_PER_WRITE } from './audit.ts';
import { blankProject, applyMessage, computeRoomDelta } from './room-state.ts';
import { writeFullRoom } from './room-storage.ts';
import { ApsRoom } from './room-do.ts';
import { handleAuditExport, handleDataExport } from './compliance.ts';
import { signRoomToken } from './room-token.ts';
import { makeFakeState, makeFakeWs } from './test-fakes.mjs';

const admin = { username: 'boss', displayName: 'Boss', role: 'admin', assignedProjectId: null };
const who = { user: 'boss', role: 'admin', ip: '203.0.113.9' };

function room() {
  const p1 = blankProject('Advanced');
  p1.jobs = { j1: { id: 'j1', name: 'Smith House', updatedAt: 1 }, j2: { id: 'j2', name: 'Jones Barn', updatedAt: 1 } };
  p1.boardCards = { c1: { id: 'c1', jobId: 'j1', title: 'Smith House', column: 'bid', updatedAt: 1 } };
  return { projects: { p1 } };
}
function change(prev, msg) {
  const r = applyMessage(prev, msg, admin);
  return describeChange(prev, r.state, computeRoomDelta(prev, r.state), who, 1000);
}

// ── describeChange ──
test('describeChange: created, updated and archived jobs each get a row with name, id and who', () => {
  const rows = change(room(), { type: 'upsertProjectBatch', projectId: 'p1', jobs: [
    { id: 'j1', name: 'Smith House (renamed)', updatedAt: 5 },
    { id: 'j2', name: 'Jones Barn', archived: true, updatedAt: 5 },
    { id: 'j3', name: 'New Garage', updatedAt: 5 },
  ] });
  const byId = Object.fromEntries(rows.map((r) => [r.itemId, r]));
  assert.equal(byId.j1.action, 'Updated job');
  assert.equal(byId.j1.item, 'Smith House (renamed)');
  assert.equal(byId.j2.action, 'Archived job');
  assert.equal(byId.j3.action, 'Created job');
  for (const r of rows) {
    assert.equal(r.user, 'boss'); assert.equal(r.ip, '203.0.113.9'); assert.equal(r.at, 1000);
    assert.equal(r.projectId, 'p1'); assert.equal(r.projectName, 'Advanced');
  }
});

test('describeChange: a delete names what was deleted; project settings and renames get their own rows', () => {
  const del = change(room(), { type: 'deleteFromMap', projectId: 'p1', mapKey: 'jobs', id: 'j2' });
  assert.deepEqual(del.map((r) => [r.action, r.item, r.itemId]), [['Deleted job', 'Jones Barn', 'j2']]);
  const cols = change(room(), { type: 'setBoardColumns', projectId: 'p1', baseFieldRevision: 0, value: [{ id: 'bid', label: 'Bid' }] });
  assert.deepEqual(cols.map((r) => r.action), ['Changed board columns']);
  const ren = change(room(), { type: 'renameProject', projectId: 'p1', name: 'Advanced Precut' });
  assert.equal(ren[0].action, 'Renamed project');
  assert.match(ren[0].details, /from "Advanced" to "Advanced Precut"/);
});

test('describeChange: a huge single save is capped with a summary row', () => {
  const jobs = Array.from({ length: AUDIT_MAX_ROWS_PER_WRITE + 50 }, (_, i) => ({ id: 'bulk' + i, name: 'Bulk ' + i, updatedAt: 1 }));
  const rows = change(room(), { type: 'upsertProjectBatch', projectId: 'p1', jobs });
  assert.equal(rows.length, AUDIT_MAX_ROWS_PER_WRITE);
  assert.equal(rows[rows.length - 1].action, 'Bulk change');
  assert.match(rows[rows.length - 1].details, /^51 more/);
});

test('auditKey sorts by time', () => {
  assert.ok(auditKey(999, 'z') < auditKey(1000, 'a'));
  assert.ok(auditKey(1e12, 'a') < auditKey(2e12, 'a'));
});

// ── ApsRoom storage ──
async function roomWith(state) {
  const r = new ApsRoom(state, {});
  r.roomState = room();
  return r;
}
const auditRows = (state) => [...state._store].filter(([k]) => k.startsWith(AUDIT_PREFIX)).map(([, v]) => v);

test('a saved WebSocket write records audit rows with the connection\'s user and address; a no-op write records none', async () => {
  const ws = makeFakeWs({ ...admin, proto: 2, ip: '198.51.100.7' });
  const state = makeFakeState([ws]);
  const r = await roomWith(state);
  await r.webSocketMessage(ws, JSON.stringify({ type: 'upsertProjectBatch', projectId: 'p1', msgId: 'm1', jobs: [{ id: 'j1', name: 'Smith House v2', updatedAt: 9 }] }));
  await new Promise((res) => setTimeout(res, 10));
  let rows = auditRows(state);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].user, rows[0].role, rows[0].ip, rows[0].action, rows[0].itemId], ['boss', 'admin', '198.51.100.7', 'Updated job', 'j1']);
  await r.webSocketMessage(ws, JSON.stringify({ type: 'upsertProjectBatch', projectId: 'p1', msgId: 'm2', jobs: [{ id: 'j1', name: 'Smith House v2', updatedAt: 50 }] }));
  await new Promise((res) => setTimeout(res, 10));
  assert.equal(auditRows(state).length, 1, 'identical re-send is not a change');
});

test('a write refused for permissions records nothing', async () => {
  const ws = makeFakeWs({ username: 'v', displayName: 'V', role: 'viewer', assignedProjectId: null, proto: 2 });
  const state = makeFakeState([ws]);
  const r = await roomWith(state);
  await r.webSocketMessage(ws, JSON.stringify({ type: 'upsertJob', projectId: 'p1', msgId: 'm1', job: { id: 'j1', name: 'Hacked', updatedAt: 9 } }));
  await new Promise((res) => setTimeout(res, 10));
  assert.equal(auditRows(state).length, 0);
});

test('/internal/audit appends; /internal/audit-list filters by date and pages with a cursor', async () => {
  const state = makeFakeState([]);
  const r = await roomWith(state);
  const t0 = Date.now() - 60000; // recent: older entries would be pruned
  const entries = Array.from({ length: 12 }, (_, i) => ({ at: t0 + i, user: 'u' + i, action: 'Signed in' }));
  const put = await r.fetch(new Request('https://internal/internal/audit', { method: 'POST', body: JSON.stringify({ entries }) }));
  assert.equal(put.status, 200);
  const list = async (qs) => (await r.fetch(new Request('https://internal/internal/audit-list?' + qs))).json();
  const all = await list('from=' + (t0 + 3) + '&to=' + (t0 + 8));
  assert.deepEqual(all.entries.map((e) => e.at - t0), [3, 4, 5, 6, 7, 8]);
  assert.equal(all.cursor, null);
  const p1 = await list('from=' + t0 + '&to=' + (t0 + 5000) + '&limit=5');
  assert.equal(p1.entries.length, 5);
  const p2 = await list('from=' + t0 + '&to=' + (t0 + 5000) + '&limit=5&after=' + encodeURIComponent(p1.cursor));
  const p3 = await list('from=' + t0 + '&to=' + (t0 + 5000) + '&limit=5&after=' + encodeURIComponent(p2.cursor));
  assert.deepEqual([...p1.entries, ...p2.entries, ...p3.entries].map((e) => e.user), entries.map((e) => e.user));
  assert.equal(p3.cursor, null);
});

test('entries older than the retention period are pruned', async () => {
  const state = makeFakeState([]);
  const r = await roomWith(state);
  const old = Date.now() - (AUDIT_RETENTION_DAYS + 1) * 86400000;
  await r.appendAudit([{ at: old, user: 'a', action: 'Signed in' }]);
  r.lastAuditPruneAt = 0;
  await r.appendAudit([{ at: Date.now(), user: 'b', action: 'Signed in' }]);
  assert.deepEqual(auditRows(state).map((e) => e.user), ['b']);
});

test('restoring a backup never removes audit entries', async () => {
  const state = makeFakeState([]);
  const r = await roomWith(state);
  await r.appendAudit([{ at: Date.now(), user: 'a', action: 'Signed in' }]);
  await writeFullRoom(state.storage, { projects: { p9: blankProject('Restored') } });
  assert.equal(auditRows(state).length, 1);
});

// ── compliance endpoints ──
function makeEnv(users) {
  const kv = new Map(users.map((u) => ['user:' + u.username, JSON.stringify(u)]));
  const state = makeFakeState([]);
  const doRoom = new ApsRoom(state, {});
  doRoom.roomState = room();
  const objects = new Map([['attachments/a1.pdf', { size: 1234, uploaded: new Date(5000) }]]);
  return {
    ROOM_TOKEN_SECRET: 'test-secret',
    USERS_KV: {
      async get(k) { return kv.has(k) ? kv.get(k) : null; }, async put(k, v) { kv.set(k, v); }, async delete(k) { kv.delete(k); },
      async list({ prefix } = {}) { return { keys: [...kv.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })) }; }
    },
    APS_ROOM: { idFromName: (n) => ({ n }), get: () => ({ fetch: (url, init) => doRoom.fetch(new Request(url, init)) }) },
    BACKUP_BUCKET: { async list() { return { objects: [...objects].map(([key, o]) => ({ key, size: o.size, uploaded: o.uploaded })), truncated: false }; } },
    _state: state,
  };
}
const bossUser = { username: 'boss', displayName: 'Boss', role: 'admin', assignedProjectId: null, passwordHash: 'SECRET-HASH', salt: 'SECRET-SALT', createdAt: 1 };
const eddieUser = { username: 'eddie', displayName: 'Eddie', role: 'editor', assignedProjectId: null, passwordHash: 'SECRET-HASH-2', salt: 'SECRET-SALT-2', createdAt: 2 };
const tok = (u) => signRoomToken('test-secret', { username: u.username, displayName: u.displayName, role: u.role, assignedProjectId: null });
const req = (body) => ({ json: async () => body, headers: new Headers({ 'CF-Connecting-IP': '192.0.2.1' }) });

test('audit export: admins only, and the download itself is audited', async () => {
  const env = makeEnv([bossUser, eddieUser]);
  const denied = await handleAuditExport(req({ token: await tok(eddieUser) }), env, {});
  assert.equal(denied.status, 403);
  const ok = await handleAuditExport(req({ token: await tok(bossUser), from: 0, to: Date.now() + 1000 }), env, {});
  assert.equal(ok.status, 200);
  const again = await (await handleAuditExport(req({ token: await tok(bossUser), from: 0, to: Date.now() + 1000 }), env, {})).json();
  assert.ok(again.entries.some((e) => e.action === 'Downloaded audit log' && e.user === 'boss' && e.ip === '192.0.2.1'));
});

test('data export: admins only; includes projects, users and attachments, never password data', async () => {
  const env = makeEnv([bossUser, eddieUser]);
  assert.equal((await handleDataExport(req({ token: await tok(eddieUser) }), env, {})).status, 403);
  const res = await handleDataExport(req({ token: await tok(bossUser) }), env, {});
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes('SECRET-HASH') && !text.includes('SECRET-SALT'), 'no password hashes or salts');
  const data = JSON.parse(text);
  assert.equal(data.format, 'teamsync-export-v1');
  assert.deepEqual(data.users.map((u) => u.username).sort(), ['boss', 'eddie']);
  assert.ok(JSON.stringify(data.projects).includes('Smith House'));
  assert.deepEqual(data.attachments.map((a) => a.key), ['attachments/a1.pdf']);
  const rows = [...env._state._store].filter(([k]) => k.startsWith(AUDIT_PREFIX)).map(([, v]) => v);
  assert.ok(rows.some((e) => e.action === 'Exported all company data'));
});
