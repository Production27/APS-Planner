import test from 'node:test';
import assert from 'node:assert/strict';
import { signRoomToken, verifyRoomToken } from './room-token.ts';

test('signRoomToken/verifyRoomToken: a token signed with the right secret verifies and returns its payload', async () => {
  const token = await signRoomToken('test-secret', { username: 'alice', role: 'admin' });
  const payload = await verifyRoomToken('test-secret', token);
  assert.equal(payload.username, 'alice');
  assert.equal(payload.role, 'admin');
  assert.equal(typeof payload.exp, 'number');
});

test('verifyRoomToken rejects a token signed with a different secret', async () => {
  const token = await signRoomToken('test-secret', { username: 'alice' });
  const payload = await verifyRoomToken('wrong-secret', token);
  assert.equal(payload, null);
});

test('verifyRoomToken rejects an expired token', async () => {
  const token = await signRoomToken('test-secret', { username: 'alice' }, -1000);
  const payload = await verifyRoomToken('test-secret', token);
  assert.equal(payload, null);
});

test('verifyRoomToken rejects a malformed token', async () => {
  assert.equal(await verifyRoomToken('test-secret', 'not-a-real-token'), null);
  assert.equal(await verifyRoomToken('test-secret', null), null);
});
