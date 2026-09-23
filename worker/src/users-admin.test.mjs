import test from 'node:test';
import assert from 'node:assert/strict';
import {
  requireAdmin, computeRoleProjectChange, handleUsersUpdate, handleUsersRemove, handleUsersResetPassword
} from './users-admin.ts';
import { resolveIdentityFromToken } from './users.ts';
import { signRoomToken } from './room-token.ts';

function makeFakeKV(users) {
  const store = new Map();
  for (const u of users) store.set('user:' + u.username, JSON.stringify(u));
  return {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    async list({ prefix } = {}) {
      const keys = [...store.keys()].filter(k => !prefix || k.startsWith(prefix)).map(name => ({ name }));
      return { keys };
    }
  };
}

function makeFakeEnv(users) {
  return {
    USERS_KV: makeFakeKV(users),
    ROOM_TOKEN_SECRET: 'test-secret',
    // requireAdmin's demotee gets kicked from the room via getRoomStub(env).fetch()
    // (kickUserFromRoom in users-admin.ts) — a no-op stub is enough here since
    // that call is documented as best-effort and not what these tests assert on.
    APS_ROOM: {
      idFromName(name) { return { name }; },
      get() { return { fetch: async () => new Response('ok') }; }
    }
  };
}

async function tokenFor(env, user) {
  return signRoomToken(env.ROOM_TOKEN_SECRET, {
    username: user.username, displayName: user.displayName || user.username,
    role: user.role, assignedProjectId: user.assignedProjectId || null
  });
}

function makeRequest(body) {
  return { json: async () => body };
}

test('computeRoleProjectChange: an isLead-only edit (same role, same project) is a no-op', () => {
  const target = { role: 'editor', assignedProjectId: 'p1' };
  const result = computeRoleProjectChange(target, { newRole: 'editor', newAssignedProjectId: 'p1' });
  assert.deepEqual(result, { roleChanged: false, projectChanged: false, newAssignedProjectId: 'p1' });
});

test('computeRoleProjectChange: detects a role change', () => {
  const target = { role: 'editor', assignedProjectId: null };
  const result = computeRoleProjectChange(target, { newRole: 'viewer', newAssignedProjectId: null });
  assert.equal(result.roleChanged, true);
  assert.equal(result.projectChanged, false);
});

test('computeRoleProjectChange: detects a project change', () => {
  const target = { role: 'editor', assignedProjectId: 'p1' };
  const result = computeRoleProjectChange(target, { newRole: 'editor', newAssignedProjectId: 'p2' });
  assert.equal(result.roleChanged, false);
  assert.equal(result.projectChanged, true);
});

test('computeRoleProjectChange: promoting to admin forces assignedProjectId to null even if a project was passed', () => {
  const target = { role: 'editor', assignedProjectId: 'p1' };
  const result = computeRoleProjectChange(target, { newRole: 'admin', newAssignedProjectId: 'p1' });
  assert.equal(result.newAssignedProjectId, null);
  assert.equal(result.projectChanged, true);
});

test('requireAdmin rejects a null caller', async () => {
  const env = makeFakeEnv([]);
  const result = await requireAdmin(env, null, {});
  assert.equal(result.error.status, 401);
});

test('requireAdmin rejects a caller whose account no longer exists in KV', async () => {
  const env = makeFakeEnv([]);
  const result = await requireAdmin(env, { username: 'ghost', role: 'admin' }, {});
  assert.equal(result.error.status, 403);
});

test('requireAdmin rejects a non-admin caller', async () => {
  const env = makeFakeEnv([{ username: 'bob', role: 'editor' }]);
  const result = await requireAdmin(env, { username: 'bob', role: 'editor' }, {});
  assert.equal(result.error.status, 403);
});

test('requireAdmin accepts a real admin', async () => {
  const env = makeFakeEnv([{ username: 'alice', role: 'admin' }]);
  const result = await requireAdmin(env, { username: 'alice', role: 'admin' }, {});
  assert.equal(result.error, undefined);
  assert.equal(result.user.username, 'alice');
});

test('requireAdmin rechecks fresh from KV: a caller demoted after their token was minted is rejected even though the token still claims admin', async () => {
  const env = makeFakeEnv([{ username: 'alice', role: 'editor' }]); // demoted in KV since the token was signed
  const staleTokenCaller = { username: 'alice', role: 'admin' };
  const result = await requireAdmin(env, staleTokenCaller, {});
  assert.equal(result.error.status, 403);
});

test('handleUsersUpdate refuses to demote the last remaining admin', async () => {
  const env = makeFakeEnv([{ username: 'alice', role: 'admin', assignedProjectId: null }]);
  const token = await tokenFor(env, { username: 'alice', role: 'admin' });
  const res = await handleUsersUpdate(makeRequest({ token, targetUsername: 'alice', newRole: 'editor' }), env, {});
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.match(data.error, /last admin/i);
});

test('handleUsersUpdate allows demoting an admin when another admin remains', async () => {
  const env = makeFakeEnv([
    { username: 'alice', role: 'admin', assignedProjectId: null },
    { username: 'carol', role: 'admin', assignedProjectId: null }
  ]);
  const token = await tokenFor(env, { username: 'alice', role: 'admin' });
  const res = await handleUsersUpdate(makeRequest({ token, targetUsername: 'carol', newRole: 'editor' }), env, {});
  assert.equal(res.status, 200);
});

test('handleUsersRemove refuses to remove the last remaining admin', async () => {
  const env = makeFakeEnv([{ username: 'alice', role: 'admin' }]);
  const token = await tokenFor(env, { username: 'alice', role: 'admin' });
  const res = await handleUsersRemove(makeRequest({ token, targetUsername: 'alice' }), env, {});
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.match(data.error, /last admin/i);
});

test('handleUsersRemove allows removing an admin when another admin remains', async () => {
  const env = makeFakeEnv([
    { username: 'alice', role: 'admin' },
    { username: 'carol', role: 'admin' }
  ]);
  const token = await tokenFor(env, { username: 'alice', role: 'admin' });
  const res = await handleUsersRemove(makeRequest({ token, targetUsername: 'carol' }), env, {});
  assert.equal(res.status, 200);
});

test("a password reset signs out the account's existing sessions, and an admin reset also kicks its connections", async () => {
  const admin = { username: 'boss', role: 'admin', assignedProjectId: null, createdAt: 1 };
  const bob = { username: 'bob', role: 'editor', assignedProjectId: null, createdAt: 2 };
  const env = makeFakeEnv([admin, bob]);
  const kicks = [];
  env.APS_ROOM = { idFromName: (n) => ({ n }), get: () => ({ fetch: async (url) => { kicks.push(String(url)); return new Response('ok'); } }) };
  const bobToken = await tokenFor(env, bob);
  assert.ok(await resolveIdentityFromToken(env, bobToken), 'valid before the reset');
  await new Promise((r) => setTimeout(r, 5));
  const res = await handleUsersResetPassword(makeRequest({ token: await tokenFor(env, admin), targetUsername: 'bob', newPassword: 'fresh-password' }), env, {});
  assert.equal(res.status, 200);
  assert.equal(await resolveIdentityFromToken(env, bobToken), null, 'old session refused after the reset');
  assert.equal(kicks.filter((u) => u.includes('kick-user?username=bob')).length, 1);
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(await resolveIdentityFromToken(env, await tokenFor(env, bob)), 'a new sign-in works');
});

test("a self-service password change does not kick the caller's own connection", async () => {
  const bob = { username: 'bob', role: 'editor', assignedProjectId: null, createdAt: 2 };
  const env = makeFakeEnv([bob]);
  const kicks = [];
  env.APS_ROOM = { idFromName: (n) => ({ n }), get: () => ({ fetch: async (url) => { kicks.push(String(url)); return new Response('ok'); } }) };
  const res = await handleUsersResetPassword(makeRequest({ token: await tokenFor(env, bob), targetUsername: 'bob', newPassword: 'fresh-password' }), env, {});
  assert.equal(res.status, 200);
  assert.equal(kicks.filter((u) => u.includes("kick-user")).length, 0);
});
