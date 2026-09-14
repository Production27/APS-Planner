import test from 'node:test';
import assert from 'node:assert/strict';
import {
  roomStateToAppFormat, appFormatToRoomState,
  handleTriggerBackup, handleListBackups, handleDownloadBackup, handleRestoreBackup
} from './backup.ts';
import { signRoomToken } from './room-token.ts';

function sampleRoomState() {
  return {
    projects: {
      p1: {
        name: 'Sample Project',
        jobs: { 'job-2': { id: 'job-2', order: 1 }, 'job-1': { id: 'job-1', order: 0 } },
        boardCards: { 'card-1': { id: 'card-1' } },
        calendarEvents: { 'ev-1': { id: 'ev-1' } },
        boardColumns: [{ id: 'col-1' }],
        fieldOptions: { pm: ['Alice'] },
        deletedIds: { 'x': 12345 },
        header: { title: 'Sample', subtitle: '', theme: { c1: '#111', c2: '#222' } }
      }
    }
  };
}

test('roomStateToAppFormat sorts jobs by order and converts maps to arrays', () => {
  const appData = roomStateToAppFormat(sampleRoomState());
  assert.equal(appData.version, 3);
  assert.deepEqual(appData.projects.p1.jobs.map(j => j.id), ['job-1', 'job-2']);
  assert.deepEqual(appData.projects.p1.boardCards, [{ id: 'card-1' }]);
  assert.equal(appData.activeProjectId, 'p1');
});

test('appFormatToRoomState converts arrays back into id-keyed maps', () => {
  const appData = roomStateToAppFormat(sampleRoomState());
  const roundTripped = appFormatToRoomState(appData);
  assert.deepEqual(Object.keys(roundTripped.projects.p1.jobs).sort(), ['job-1', 'job-2']);
  assert.equal(roundTripped.projects.p1.boardCards['card-1'].id, 'card-1');
  assert.equal(roundTripped.projects.p1.name, 'Sample Project');
});

test('a full export-then-import round trip preserves job/card/event content', () => {
  const original = sampleRoomState();
  const restored = appFormatToRoomState(roomStateToAppFormat(original));
  assert.deepEqual(restored.projects.p1.jobs['job-1'], original.projects.p1.jobs['job-1']);
  assert.deepEqual(restored.projects.p1.boardCards['card-1'], original.projects.p1.boardCards['card-1']);
  assert.deepEqual(restored.projects.p1.fieldOptions, original.projects.p1.fieldOptions);
});

test('roomStateToAppFormat defaults a missing project name/header rather than crashing', () => {
  const appData = roomStateToAppFormat({ projects: { p1: { jobs: {}, boardCards: {}, calendarEvents: {} } } });
  assert.equal(appData.projects.p1.name, 'Untitled Project');
  assert.equal(appData.projects.p1.header.title, 'Untitled');
});

// ── Admin gating on the four route handlers — these used to accept a bare
// role claim straight off the token (handleDownloadBackup/handleRestoreBackup)
// or a since-removed checkAdminAuth() with the same weakness
// (handleTriggerBackup/handleListBackups); all four now go through
// requireAdmin's fresh-from-KV recheck, same as every other admin-gated
// endpoint. These tests only exercise the auth gate itself — a caller that
// clears it can still fail later for unrelated reasons (no APS_ROOM stub
// wired up here), which is fine since that's not what's under test. ──

function makeFakeKV(users) {
  const store = new Map();
  for (const u of users) store.set('user:' + u.username, JSON.stringify(u));
  return { async get(key) { return store.has(key) ? store.get(key) : null; } };
}

function makeFakeEnv(users) {
  return { USERS_KV: makeFakeKV(users), ROOM_TOKEN_SECRET: 'test-secret' };
}

async function tokenFor(env, user) {
  return signRoomToken(env.ROOM_TOKEN_SECRET, { username: user.username, displayName: user.username, role: user.role, assignedProjectId: null });
}

function makeRequest(body) {
  return { json: async () => body };
}

for (const [name, handler] of [
  ['handleTriggerBackup', handleTriggerBackup],
  ['handleListBackups', handleListBackups],
  ['handleDownloadBackup', handleDownloadBackup],
  ['handleRestoreBackup', handleRestoreBackup]
]) {
  test(`${name} rejects an unauthenticated request`, async () => {
    const env = makeFakeEnv([]);
    const res = await handler(makeRequest({}), env, {});
    assert.equal(res.status, 401);
  });

  test(`${name} rejects a non-admin caller, rechecked fresh from KV even if the token claims admin`, async () => {
    const env = makeFakeEnv([{ username: 'bob', role: 'editor' }]); // demoted/never-was admin in KV
    const token = await tokenFor(env, { username: 'bob', role: 'admin' }); // stale/forged token role
    const res = await handler(makeRequest({ token }), env, {});
    assert.equal(res.status, 403);
  });
}

test('handleListBackups returns the backup list for a real admin', async () => {
  const env = makeFakeEnv([{ username: 'alice', role: 'admin' }]);
  env.BACKUP_BUCKET = { async list() { return { objects: [{ key: 'backups/a.json', size: 10, uploaded: new Date().toISOString() }] }; } };
  const token = await tokenFor(env, { username: 'alice', role: 'admin' });
  const res = await handleListBackups(makeRequest({ token }), env, {});
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.backups.length, 1);
});
