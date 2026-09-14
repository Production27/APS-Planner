import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeUsername, normalizeUserRecord,
  genSaltHex, hashPasswordPBKDF2,
  resolveIdentityFromToken,
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

test('resolveIdentityFromToken resolves a valid token, wiring through to room-token.ts correctly', async () => {
  const fakeEnv = { ROOM_TOKEN_SECRET: 'test-secret' };
  const token = await signRoomToken(fakeEnv.ROOM_TOKEN_SECRET, {
    username: 'alice', displayName: 'Alice', role: 'admin', assignedProjectId: null
  });
  const identity = await resolveIdentityFromToken(fakeEnv, token);
  assert.equal(identity.username, 'alice');
  assert.equal(identity.role, 'admin');
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
