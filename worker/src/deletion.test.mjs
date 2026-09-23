// Scheduled "delete all our data" (compliance.ts). Run with:
//   node --test worker/src/deletion.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handleDeletionSchedule, handleDeletionCancel, handleDeletionStatus, runDueDeletion,
  DELETION_KV_KEY, DELETION_DELAY_MS, DELETION_CONFIRM_PHRASE
} from './compliance.ts';
import { AUDIT_PREFIX } from './audit.ts';
import { blankProject } from './room-state.ts';
import { hashPasswordPBKDF2 } from './users.ts';
import { signRoomToken } from './room-token.ts';
import { ApsRoom } from './room-do.ts';
import worker from './index.ts';
import { makeFakeState, makeFakeWs } from './test-fakes.mjs';

async function user(username, role, password) {
  const salt = '00112233445566778899aabbccddeeff';
  return { username, displayName: username, role, assignedProjectId: null, salt, passwordHash: await hashPasswordPBKDF2(password, salt), createdAt: 1 };
}

async function makeEnv() {
  const kv = new Map();
  for (const u of [await user('boss', 'admin', 'boss-password'), await user('second', 'admin', 'second-password'), await user('eddie', 'editor', 'eddie-password')]) {
    kv.set('user:' + u.username, JSON.stringify(u));
  }
  kv.set('authfail:someone', '2');
  const r2 = new Map([['backups/teamsync-1.json', 'b1'], ['backups/teamsync-2.json', 'b2'], ['attachments/x.pdf', 'x'], ['other/keep.txt', 'k']]);
  const state = makeFakeState([]);
  const room = new ApsRoom(state, {});
  const p = blankProject('Advanced');
  p.jobs = { j1: { id: 'j1', name: 'Smith House' } };
  room.roomState = { projects: { p1: p } };
  await state.storage.put({ 'p|p1|j|j1': { id: 'j1' }, meta: { v: 2 } });
  let backupsRun = 0;
  return {
    ROOM_TOKEN_SECRET: 'test-secret',
    USERS_KV: {
      async get(k) { return kv.has(k) ? kv.get(k) : null; },
      async put(k, v) { kv.set(k, v); },
      async delete(k) { kv.delete(k); },
      async list({ prefix, cursor } = {}) {
        const keys = [...kv.keys()].filter((k) => !prefix || k.startsWith(prefix)).sort();
        const start = cursor ? Number(cursor) : 0;
        const page = keys.slice(start, start + 2); // small pages, to exercise the cursor
        const done = start + 2 >= keys.length;
        return { keys: page.map((name) => ({ name })), list_complete: done, cursor: done ? undefined : String(start + 2) };
      },
    },
    BACKUP_BUCKET: {
      async list({ prefix = '', limit = 1000 } = {}) {
        const objects = [...r2.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit).map((key) => ({ key, size: 1, uploaded: new Date(0) }));
        return { objects, truncated: false };
      },
      async delete(keys) { (Array.isArray(keys) ? keys : [keys]).forEach((k) => r2.delete(k)); },
      async put(k, v) { r2.set(k, v); backupsRun++; },
    },
    APS_ROOM: { idFromName: (n) => ({ n }), get: () => ({ fetch: (url, init) => room.fetch(new Request(url, init)) }) },
    _kv: kv, _r2: r2, _state: state, _room: room, get _backupsRun() { return backupsRun; },
  };
}
const tokenFor = (username, role) => signRoomToken('test-secret', { username, displayName: username, role, assignedProjectId: null });
const req = (body) => ({ json: async () => body, headers: new Headers({ 'CF-Connecting-IP': '192.0.2.5' }) });
const auditActions = (env) => [...env._state._store].filter(([k]) => k.startsWith(AUDIT_PREFIX)).map(([, v]) => v.action);
async function schedule(env, over) {
  return handleDeletionSchedule(req(Object.assign({ token: await tokenFor('boss', 'admin'), password: 'boss-password', confirm: DELETION_CONFIRM_PHRASE }, over || {})), env, {});
}

test('scheduling is refused for non-admins, a wrong phrase, or a wrong password, and then nothing is scheduled', async () => {
  const env = await makeEnv();
  assert.equal((await handleDeletionSchedule(req({ token: await tokenFor('eddie', 'editor'), password: 'eddie-password', confirm: DELETION_CONFIRM_PHRASE }), env, {})).status, 403);
  assert.equal((await schedule(env, { confirm: 'delete all data' })).status, 400);
  assert.equal((await schedule(env, { password: 'wrong' })).status, 403);
  assert.equal(env._kv.has(DELETION_KV_KEY), false);
});

test('scheduling sets the date 7 days out on the server, is audited, and a second request does not move the date', async () => {
  const env = await makeEnv();
  const before = Date.now();
  const res = await schedule(env);
  assert.equal(res.status, 200);
  const { scheduled } = await res.json();
  assert.equal(scheduled.requestedBy, 'boss');
  assert.ok(scheduled.executeAt >= before + DELETION_DELAY_MS && scheduled.executeAt <= Date.now() + DELETION_DELAY_MS);
  assert.ok(auditActions(env).includes('Scheduled deletion of all company data'));
  const again = await (await schedule(env)).json();
  assert.equal(again.scheduled.executeAt, scheduled.executeAt);
});

test('every signed-in user can see a pending deletion; signed-out callers cannot', async () => {
  const env = await makeEnv();
  await schedule(env);
  const seen = await (await handleDeletionStatus(req({ token: await tokenFor('eddie', 'editor') }), env, {})).json();
  assert.equal(seen.scheduled.requestedBy, 'boss');
  assert.equal((await handleDeletionStatus(req({}), env, {})).status, 401);
});

test('any admin can cancel (audited); non-admins cannot', async () => {
  const env = await makeEnv();
  await schedule(env);
  assert.equal((await handleDeletionCancel(req({ token: await tokenFor('eddie', 'editor') }), env, {})).status, 403);
  assert.equal(env._kv.has(DELETION_KV_KEY), true);
  assert.equal((await handleDeletionCancel(req({ token: await tokenFor('second', 'admin') }), env, {})).status, 200);
  assert.equal(env._kv.has(DELETION_KV_KEY), false);
  assert.ok(auditActions(env).includes('Cancelled deletion of all company data'));
});

test('nothing is deleted when no deletion is scheduled, or before its date', async () => {
  const env = await makeEnv();
  assert.equal(await runDueDeletion(env), false);
  await schedule(env);
  assert.equal(await runDueDeletion(env, Date.now() + DELETION_DELAY_MS - 60000), false);
  assert.equal(env._r2.size, 4);
  assert.ok(env._kv.has('user:boss'));
  assert.ok(env._state._store.has('p|p1|j|j1'));
});

test('once due, everything is deleted: project data, audit trail, backups, attachments, accounts; one final audit entry remains', async () => {
  const ws = makeFakeWs({ username: 'eddie', role: 'editor', proto: 2 });
  const env = await makeEnv();
  env._state.getWebSockets = () => [ws];
  await schedule(env);
  assert.equal(await runDueDeletion(env, Date.now() + DELETION_DELAY_MS + 1000), true);
  assert.deepEqual([...env._r2.keys()], ['other/keep.txt'], 'backups and attachments gone');
  assert.equal(env._kv.size, 0, 'accounts, lockout counters and the schedule itself gone');
  const left = [...env._state._store];
  assert.equal(left.length, 1, 'only the final audit entry remains in room storage');
  assert.equal(left[0][1].action, 'Deleted all company data');
  assert.equal(left[0][1].user, 'boss');
  assert.equal(ws._closed.code, 4002, 'connected users are disconnected');
  const reloaded = await env._room.loadRoomState();
  assert.deepEqual(Object.keys(reloaded.projects).length, 0, 'the room starts empty');
});

test('the scheduled job runs a due deletion instead of that run\'s backup, and backs up normally otherwise', async () => {
  const env = await makeEnv();
  await worker.scheduled({}, env, { waitUntil() {} });
  assert.equal(env._backupsRun, 1, 'no deletion pending: normal backup');
  await schedule(env);
  const realNow = Date.now;
  Date.now = () => realNow() + DELETION_DELAY_MS + 1000;
  try { await worker.scheduled({}, env, { waitUntil() {} }); } finally { Date.now = realNow; }
  assert.equal(env._backupsRun, 1, 'no backup written on the deletion run');
  assert.equal(env._kv.size, 0);
});
