import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeUsername, normalizeUserRecord,
  genSaltHex, hashPasswordPBKDF2,
  resolveIdentityFromToken, timingSafeEqualStr,
  getAuthFailureCount, bumpAuthFailure, AUTH_LOCKOUT_WINDOW_SECONDS
} from './users.ts';
import { signRoomToken } from './room-token.ts';

test('normalizeUsername trims and lowercases, and tolerates non-strings', () => {
  assert.equal(normalizeUsername('  Alice  '), 'alice');
  assert.equal(normalizeUsername('BOB'), 'bob');
  assert.equal(normalizeUsername(undefined), '');
  assert.equal(normalizeUsername(null), '');
});

test('normalizeUserRecord migrates the old "member" role to "editor"', () => {
  const record = normalizeUserRecord({ username: 'alice', role: 'member' });
  assert.equal(record.role, 'editor');
});

test('normalizeUserRecord defaults a missing assignedProjectId to null, leaves a set one alone', () => {
  assert.equal(normalizeUserRecord({ username: 'alice', role: 'editor' }).assignedProjectId, null);
  assert.equal(normalizeUserRecord({ username: 'alice', role: 'editor', assignedProjectId: 'p1' }).assignedProjectId, 'p1');
});

test('normalizeUserRecord passes through a falsy record unchanged', () => {
  assert.equal(normalizeUserRecord(null), null);
});

test('hashPasswordPBKDF2 round-trip: the same password and salt always hash the same', async () => {
  const salt = genSaltHex();
  const hashA = await hashPasswordPBKDF2('correct horse battery staple', salt);
  const hashB = await hashPasswordPBKDF2('correct horse battery staple', salt);
  assert.equal(hashA, hashB);
});

test('hashPasswordPBKDF2: a different password produces a different hash', async () => {
  const salt = genSaltHex();
  const hashA = await hashPasswordPBKDF2('correct horse battery staple', salt);
  const hashB = await hashPasswordPBKDF2('wrong password', salt);
  assert.notEqual(hashA, hashB);
});

function envWithUsers(users) {
  const store = new Map(users.map((u) => ['user:' + u.username, JSON.stringify(u)]));
  return {
    ROOM_TOKEN_SECRET: 'test-secret',
    USERS_KV: { async get(k) { return store.has(k) ? store.get(k) : null; }, async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); } }
  };
}
const aliceToken = (env, extra) => signRoomToken(env.ROOM_TOKEN_SECRET, Object.assign({ username: 'alice', displayName: 'Alice', role: 'admin', assignedProjectId: null }, extra || {}));

test('resolveIdentityFromToken resolves a valid token for an existing account', async () => {
  const env = envWithUsers([{ username: 'alice', displayName: 'Alice', role: 'admin', assignedProjectId: null }]);
  const identity = await resolveIdentityFromToken(env, await aliceToken(env));
  assert.equal(identity.username, 'alice');
  assert.equal(identity.role, 'admin');
});

test('resolveIdentityFromToken refuses a still-unexpired token once the account is removed', async () => {
  const env = envWithUsers([{ username: 'alice', displayName: 'Alice', role: 'admin', assignedProjectId: null }]);
  const token = await aliceToken(env);
  await env.USERS_KV.delete('user:alice');
  assert.equal(await resolveIdentityFromToken(env, token), null);
});

test("resolveIdentityFromToken uses the account's CURRENT role and project, not the token's", async () => {
  const env = envWithUsers([{ username: 'alice', displayName: 'Alice', role: 'viewer', assignedProjectId: 'p2' }]);
  const identity = await resolveIdentityFromToken(env, await aliceToken(env, { role: 'admin', assignedProjectId: null }));
  assert.equal(identity.role, 'viewer');
  assert.equal(identity.assignedProjectId, 'p2');
});

test('resolveIdentityFromToken refuses tokens issued before the last password reset, and accepts newer ones', async () => {
  const env = envWithUsers([{ username: 'alice', displayName: 'Alice', role: 'admin', assignedProjectId: null }]);
  const oldToken = await aliceToken(env);
  await new Promise((r) => setTimeout(r, 5));
  await env.USERS_KV.put('user:alice', JSON.stringify({ username: 'alice', displayName: 'Alice', role: 'admin', assignedProjectId: null, tokensValidAfter: Date.now() }));
  assert.equal(await resolveIdentityFromToken(env, oldToken), null);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await resolveIdentityFromToken(env, await aliceToken(env))).username, 'alice');
});

test('timingSafeEqualStr matches only identical strings', () => {
  assert.equal(timingSafeEqualStr('abc123', 'abc123'), true);
  assert.equal(timingSafeEqualStr('abc123', 'abc124'), false);
  assert.equal(timingSafeEqualStr('abc', 'abcd'), false);
  assert.equal(timingSafeEqualStr('', ''), true);
});

test('resolveIdentityFromToken returns null for an invalid token', async () => {
  const fakeEnv = { ROOM_TOKEN_SECRET: 'test-secret' };
  assert.equal(await resolveIdentityFromToken(fakeEnv, 'garbage'), null);
});

function makeFakeKV() {
  const store = new Map();
  return {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value, opts) { store.set(key, value); this._lastTtl = opts && opts.expirationTtl; },
    _store: store
  };
}

test('getAuthFailureCount returns 0 for a key that has never failed', async () => {
  const fakeEnv = { USERS_KV: makeFakeKV() };
  assert.equal(await getAuthFailureCount(fakeEnv, 'authfail:nobody'), 0);
});

test('getAuthFailureCount tolerates a corrupt (non-numeric) stored value', async () => {
  const kv = makeFakeKV();
  kv._store.set('authfail:alice', 'not-a-number');
  assert.equal(await getAuthFailureCount({ USERS_KV: kv }, 'authfail:alice'), 0);
});

test('bumpAuthFailure increments the counter and sets it to expire after the lockout window', async () => {
  const kv = makeFakeKV();
  const fakeEnv = { USERS_KV: kv };
  await bumpAuthFailure(fakeEnv, 'authfail:alice');
  assert.equal(await getAuthFailureCount(fakeEnv, 'authfail:alice'), 1);
  await bumpAuthFailure(fakeEnv, 'authfail:alice');
  assert.equal(await getAuthFailureCount(fakeEnv, 'authfail:alice'), 2);
  assert.equal(kv._lastTtl, AUTH_LOCKOUT_WINDOW_SECONDS);
});
