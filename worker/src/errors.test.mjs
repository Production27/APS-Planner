import test from 'node:test';
import assert from 'node:assert/strict';
import { handleReportError, handleErrorsList, CLIENT_ERROR_LOG_KEY, CLIENT_ERROR_LOG_CAP } from './errors.ts';
import { signRoomToken } from './room-token.ts';

function makeFakeKV(users) {
  const store = new Map();
  for (const u of users || []) store.set('user:' + u.username, JSON.stringify(u));
  return {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
    _store: store
  };
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

test('handleReportError accepts an unauthenticated report and stores it', async () => {
  const env = makeFakeEnv([]);
  const res = await handleReportError(makeRequest({ kind: 'error', message: 'boom' }), env, {});
  assert.equal(res.status, 200);
  const list = JSON.parse(await env.USERS_KV.get(CLIENT_ERROR_LOG_KEY));
  assert.equal(list.length, 1);
  assert.equal(list[0].message, 'boom');
  assert.equal(list[0].username, null);
});

test('handleReportError attaches the verified identity when a valid token is present, not a client-claimed one', async () => {
  const env = makeFakeEnv([{ username: 'alice', role: 'editor' }]);
  const token = await tokenFor(env, { username: 'alice', role: 'editor' });
  const res = await handleReportError(makeRequest({ token, kind: 'error', message: 'boom' }), env, {});
  assert.equal(res.status, 200);
  const list = JSON.parse(await env.USERS_KV.get(CLIENT_ERROR_LOG_KEY));
  assert.equal(list[0].username, 'alice');
});

test('handleReportError caps the stored log at CLIENT_ERROR_LOG_CAP entries', async () => {
  const env = makeFakeEnv([]);
  await env.USERS_KV.put(CLIENT_ERROR_LOG_KEY, JSON.stringify(Array(CLIENT_ERROR_LOG_CAP).fill({ message: 'old' })));
  await handleReportError(makeRequest({ message: 'newest' }), env, {});
  const list = JSON.parse(await env.USERS_KV.get(CLIENT_ERROR_LOG_KEY));
  assert.equal(list.length, CLIENT_ERROR_LOG_CAP);
  assert.equal(list[0].message, 'newest');
});

test('handleErrorsList rejects an unauthenticated request', async () => {
  const env = makeFakeEnv([]);
  const res = await handleErrorsList(makeRequest({}), env, {});
  assert.equal(res.status, 401);
});

test('handleErrorsList rejects a non-admin caller, rechecked fresh from KV even if the token claims admin', async () => {
  const env = makeFakeEnv([{ username: 'bob', role: 'editor' }]);
  const token = await tokenFor(env, { username: 'bob', role: 'admin' });
  const res = await handleErrorsList(makeRequest({ token }), env, {});
  assert.equal(res.status, 403);
});

test('handleErrorsList returns the stored error list for a real admin', async () => {
  const env = makeFakeEnv([{ username: 'alice', role: 'admin' }]);
  await env.USERS_KV.put(CLIENT_ERROR_LOG_KEY, JSON.stringify([{ message: 'boom' }]));
  const token = await tokenFor(env, { username: 'alice', role: 'admin' });
  const res = await handleErrorsList(makeRequest({ token }), env, {});
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.errors.length, 1);
});
