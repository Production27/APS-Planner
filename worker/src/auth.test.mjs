import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAuth } from './auth.ts';
import { hashPasswordPBKDF2, genSaltHex, AUTH_MAX_FAILURES_PER_USERNAME, AUTH_MAX_FAILURES_PER_IP } from './users.ts';

function makeFakeKV() {
  const store = new Map();
  return {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    _store: store
  };
}

async function makeFakeEnv(username, password) {
  const salt = genSaltHex();
  const passwordHash = await hashPasswordPBKDF2(password, salt);
  const kv = makeFakeKV();
  kv._store.set('user:' + username, JSON.stringify({
    username, displayName: username, role: 'editor', assignedProjectId: null,
    passwordHash, salt, createdAt: Date.now()
  }));
  return { USERS_KV: kv, ROOM_TOKEN_SECRET: 'test-secret' };
}

function makeRequest(body, ip) {
  return {
    method: 'POST',
    headers: { get(name) { return name === 'CF-Connecting-IP' ? (ip || '1.2.3.4') : null; } },
    json: async () => body
  };
}

test('handleAuth succeeds with correct credentials and returns a token', async () => {
  const env = await makeFakeEnv('alice', 'correct horse battery staple');
  const res = await handleAuth(makeRequest({ username: 'alice', password: 'correct horse battery staple' }), env, {}, undefined);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.user.username, 'alice');
  assert.ok(data.token);
});

test('handleAuth rejects a wrong password and charges the per-username failure counter', async () => {
  const env = await makeFakeEnv('alice', 'correct horse battery staple');
  const res = await handleAuth(makeRequest({ username: 'alice', password: 'wrong' }), env, {}, undefined);
  assert.equal(res.status, 401);
  assert.equal(await env.USERS_KV.get('authfail:alice'), '1');
});

test('handleAuth also charges the failure counter for an unknown username (so enumeration gets no free pass)', async () => {
  const env = await makeFakeEnv('alice', 'correct horse battery staple');
  await handleAuth(makeRequest({ username: 'nobody', password: 'whatever' }), env, {}, undefined);
  assert.equal(await env.USERS_KV.get('authfail:nobody'), '1');
});

test('handleAuth clears the per-username failure count on a successful login', async () => {
  const env = await makeFakeEnv('alice', 'correct horse battery staple');
  await handleAuth(makeRequest({ username: 'alice', password: 'wrong' }), env, {}, undefined);
  assert.equal(await env.USERS_KV.get('authfail:alice'), '1');
  await handleAuth(makeRequest({ username: 'alice', password: 'correct horse battery staple' }), env, {}, undefined);
  assert.equal(await env.USERS_KV.get('authfail:alice'), null);
});

test('handleAuth locks out a username after AUTH_MAX_FAILURES_PER_USERNAME failed attempts, even with the correct password', async () => {
  const env = await makeFakeEnv('alice', 'correct horse battery staple');
  for (let i = 0; i < AUTH_MAX_FAILURES_PER_USERNAME; i++) {
    await handleAuth(makeRequest({ username: 'alice', password: 'wrong' }, '9.9.9.' + i), env, {}, undefined);
  }
  const res = await handleAuth(makeRequest({ username: 'alice', password: 'correct horse battery staple' }, '9.9.9.99'), env, {}, undefined);
  assert.equal(res.status, 429);
});

test('handleAuth locks out by IP across different usernames once AUTH_MAX_FAILURES_PER_IP is hit', async () => {
  const env = await makeFakeEnv('alice', 'correct horse battery staple');
  for (let i = 0; i < AUTH_MAX_FAILURES_PER_IP; i++) {
    await handleAuth(makeRequest({ username: 'user' + i, password: 'wrong' }, 'shared-ip'), env, {}, undefined);
  }
  const res = await handleAuth(makeRequest({ username: 'alice', password: 'correct horse battery staple' }, 'shared-ip'), env, {}, undefined);
  assert.equal(res.status, 429);
});

test('handleAuth rejects a non-POST request', async () => {
  const env = await makeFakeEnv('alice', 'correct horse battery staple');
  const res = await handleAuth({ ...makeRequest({}), method: 'GET' }, env, {}, undefined);
  assert.equal(res.status, 405);
});
