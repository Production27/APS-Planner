import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAdminNotices, handleAdminNoticesSeen } from './admin-notices.ts';
import { recordAudit, ADMIN_NOTICE_LOG_KEY } from './audit.ts';
import { CLIENT_ERROR_LOG_KEY } from './errors.ts';
import { signRoomToken } from './room-token.ts';

function makeFakeEnv(users) {
  const store = new Map();
  for (const u of users || []) store.set('user:' + u.username, JSON.stringify(u));
  return {
    USERS_KV: {
      async get(key) { return store.has(key) ? store.get(key) : null; },
      async put(key, value) { store.set(key, value); },
    },
    ROOM_TOKEN_SECRET: 'test-secret',
  };
}

async function tokenFor(env, user) {
  return signRoomToken(env.ROOM_TOKEN_SECRET, { username: user.username, displayName: user.username, role: user.role, assignedProjectId: null });
}

function makeRequest(body) {
  return { json: async () => body };
}

test('recordAudit adds notable account events to the admin notice log, and skips routine ones', async () => {
  const env = makeFakeEnv([]);
  await recordAudit(env, { user: 'bob', action: 'Changed own email', details: 'none -> bob@example.com' });
  await recordAudit(env, { user: 'bob', action: 'Signed in' });
  const list = JSON.parse(await env.USERS_KV.get(ADMIN_NOTICE_LOG_KEY));
  assert.equal(list.length, 1);
  assert.equal(list[0].action, 'Changed own email');
  assert.equal(list[0].user, 'bob');
});

test('handleAdminNotices rejects a non-admin caller', async () => {
  const env = makeFakeEnv([{ username: 'bob', role: 'editor' }]);
  const res = await handleAdminNotices(makeRequest({ token: await tokenFor(env, { username: 'bob', role: 'admin' }) }), env, {});
  assert.equal(res.status, 403);
});

test('handleAdminNotices merges account events and errors, newest first, leaving out the admin\'s own actions', async () => {
  const env = makeFakeEnv([{ username: 'alice', role: 'admin' }]);
  await env.USERS_KV.put(ADMIN_NOTICE_LOG_KEY, JSON.stringify([
    { at: 3000, user: 'alice', action: 'Added user account', item: 'carl' },
    { at: 1000, user: 'bob', action: 'Changed own email' },
  ]));
  await env.USERS_KV.put(CLIENT_ERROR_LOG_KEY, JSON.stringify([{ receivedAt: new Date(2000).toISOString(), message: 'boom', username: 'bob' }]));
  const res = await handleAdminNotices(makeRequest({ token: await tokenFor(env, { username: 'alice', role: 'admin' }) }), env, {});
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data.items.map((n) => n.action), ['App error', 'Changed own email']);
  assert.equal(data.items[0].kind, 'error');
  assert.equal(data.unread, 2);
});

test('handleAdminNoticesSeen clears the unread count up to the time sent, and never moves backwards', async () => {
  const env = makeFakeEnv([{ username: 'alice', role: 'admin' }]);
  const token = await tokenFor(env, { username: 'alice', role: 'admin' });
  await env.USERS_KV.put(ADMIN_NOTICE_LOG_KEY, JSON.stringify([
    { at: 2000, user: 'bob', action: 'Removed user account' },
    { at: 1000, user: 'bob', action: 'Changed own email' },
  ]));
  let res = await handleAdminNoticesSeen(makeRequest({ token, at: 1000 }), env, {});
  assert.equal(res.status, 200);
  res = await handleAdminNoticesSeen(makeRequest({ token, at: 500 }), env, {});
  assert.equal((await res.json()).seenAt, 1000);
  const data = await (await handleAdminNotices(makeRequest({ token }), env, {})).json();
  assert.equal(data.unread, 1);
  assert.equal(data.seenAt, 1000);
});
