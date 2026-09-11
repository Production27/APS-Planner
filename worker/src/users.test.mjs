import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeUsername, normalizeUserRecord,
  genSaltHex, hashPasswordPBKDF2,
  resolveIdentityFromToken
} from './users.js';
import { signRoomToken } from './room-token.js';

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

test('resolveIdentityFromToken resolves a valid token, wiring through to room-token.js correctly', async () => {
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
