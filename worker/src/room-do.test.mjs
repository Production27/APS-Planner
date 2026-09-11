// Unit tests for ApsRoom using hand-rolled fakes for state.storage and
// state.getWebSockets() — no real Durable Objects runtime available in
// plain Node, so anything touching WebSocketPair/acceptWebSocket
// (handleWebSocketUpgrade() specifically) is NOT covered here; that path
// is instead verified manually against a real `wrangler dev` runtime
// (see the worker split's commit history) before every deploy. Everything
// else ApsRoom does only touches storage.get/put and a list of fake
// socket-like objects, which plain objects can stand in for just fine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ApsRoom } from './room-do.ts';

function makeFakeState(wsList = []) {
  const store = new Map();
  let getCalls = 0;
  return {
    storage: {
      async get(key) { getCalls++; return store.get(key); },
      async put(key, val) { store.set(key, val); }
    },
    getWebSockets() { return wsList; },
    _store: store,
    get _getCalls() { return getCalls; }
  };
}

function makeFakeWs(attachment) {
  const sent = [];
  return {
    _attachment: attachment,
    deserializeAttachment() { return this._attachment; },
    serializeAttachment(a) { this._attachment = a; },
    send(payload) { sent.push(JSON.parse(payload)); },
    close(code, reason) { this._closed = { code, reason }; },
    _sent: sent,
    _closed: null
  };
}

// ── loadRoomState / persist ──

test('loadRoomState returns an empty room when nothing is stored yet, and caches it', async () => {
  const state = makeFakeState();
  const room = new ApsRoom(state, {});
  const first = await room.loadRoomState();
  assert.deepEqual(first, { projects: {} });
  await room.loadRoomState();
  assert.equal(state._getCalls, 1, 'second call should use the cached value, not re-read storage');
});

test('persist writes the current roomState to storage under the "room" key', async () => {
  const state = makeFakeState();
  const room = new ApsRoom(state, {});
  room.roomState = { projects: { p1: { name: 'Test' } } };
  await room.persist();
  assert.deepEqual(state._store.get('room'), { projects: { p1: { name: 'Test' } } });
});

// ── broadcastPresence ──

test('broadcastPresence excludes stale entries and sends the live roster to everyone', () => {
  const fresh = makeFakeWs({ username: 'alice', displayName: 'Alice', lastSeen: Date.now() });
  const stale = makeFakeWs({ username: 'bob', displayName: 'Bob', lastSeen: Date.now() - 200 * 1000 });
  const state = makeFakeState([fresh, stale]);
  const room = new ApsRoom(state, {});
  room.broadcastPresence();

  const payloadFresh = fresh._sent[0];
  assert.equal(payloadFresh.type, 'presence');
  assert.deepEqual(payloadFresh.users.map(u => u.username), ['alice']);
  // Broadcast goes to every socket, including the stale one being pruned FROM the list.
  assert.deepEqual(stale._sent[0].users.map(u => u.username), ['alice']);
});

// ── webSocketMessage: authorization gates ──

test('webSocketMessage rejects a message below the required tier without persisting or broadcasting', async () => {
  const viewerWs = makeFakeWs({ username: 'v', role: 'viewer', assignedProjectId: null });
  const state = makeFakeState([viewerWs]);
  const room = new ApsRoom(state, {});

  await room.webSocketMessage(viewerWs, JSON.stringify({ type: 'upsertJob', projectId: 'p1', job: { id: 'job-1' }, msgId: 1 }));

  const response = viewerWs._sent[0];
  assert.equal(response.type, 'error');
  assert.match(response.message, /Forbidden: requires editor/);
  assert.equal(state._store.get('room'), undefined, 'a rejected message must not persist anything');
});

test('webSocketMessage rejects a write outside a restricted account\'s assigned project', async () => {
  const restrictedWs = makeFakeWs({ username: 'e', role: 'editor', assignedProjectId: 'p1' });
  const state = makeFakeState([restrictedWs]);
  const room = new ApsRoom(state, {});

  await room.webSocketMessage(restrictedWs, JSON.stringify({ type: 'upsertJob', projectId: 'p2', job: { id: 'job-1' }, msgId: 2 }));

  const response = restrictedWs._sent[0];
  assert.equal(response.type, 'error');
  assert.match(response.message, /outside your assigned project/);
});

test('an admin bypasses project scoping even with a stale assignedProjectId', async () => {
  const adminWs = makeFakeWs({ username: 'a', role: 'admin', assignedProjectId: 'p1' });
  const state = makeFakeState([adminWs]);
  const room = new ApsRoom(state, {});

  await room.webSocketMessage(adminWs, JSON.stringify({ type: 'upsertJob', projectId: 'p2', job: { id: 'job-1', updatedAt: 1 }, msgId: 3 }));

  const ack = adminWs._sent.find(m => m.type === 'ack');
  assert.ok(ack, 'a valid cross-project admin write should be accepted and acked');
  assert.equal(ack.msgId, 3);
});

// ── webSocketMessage: a valid write persists and broadcasts to every connection ──

test('a valid, authorized write persists to storage and broadcasts a scoped snapshot to all connections', async () => {
  const writerWs = makeFakeWs({ username: 'e', role: 'editor', assignedProjectId: null });
  const observerWs = makeFakeWs({ username: 'o', role: 'viewer', assignedProjectId: null });
  const state = makeFakeState([writerWs, observerWs]);
  const room = new ApsRoom(state, {});

  await room.webSocketMessage(writerWs, JSON.stringify({
    type: 'upsertJob', projectId: 'p1', job: { id: 'job-1', updatedAt: 1 }, msgId: 5
  }));

  assert.ok(state._store.get('room').projects.p1.jobs['job-1'], 'the write should have persisted');
  const observerSnapshot = observerWs._sent.find(m => m.type === 'snapshot');
  assert.ok(observerSnapshot, 'every connection, not just the writer, should receive the new snapshot');
  assert.ok(observerSnapshot.projects.p1.jobs['job-1']);
});

// ── fetch(): /internal/kick-user ──

test('fetch /internal/kick-user closes only the sockets matching the target username', async () => {
  const target = makeFakeWs({ username: 'bob' });
  const other = makeFakeWs({ username: 'alice' });
  const state = makeFakeState([target, other]);
  const room = new ApsRoom(state, {});

  const res = await room.fetch(new Request('https://internal/internal/kick-user?username=bob', { method: 'POST' }));
  const body = await res.json();

  assert.equal(body.kicked, 1);
  assert.ok(target._closed, 'the matching socket should be closed');
  assert.equal(other._closed, null, 'a non-matching socket should be left alone');
});

// ── fetch(): /internal/export and /internal/import round trip ──

test('fetch /internal/export then /internal/import round-trips the room state', async () => {
  const state = makeFakeState();
  const room = new ApsRoom(state, {});
  room.roomState = { projects: { p1: { name: 'Original' } } };

  const exportRes = await room.fetch(new Request('https://internal/internal/export'));
  const exported = await exportRes.json();
  assert.deepEqual(exported, { projects: { p1: { name: 'Original' } } });

  const importRes = await room.fetch(new Request('https://internal/internal/import', {
    method: 'POST', body: JSON.stringify({ projects: { p2: { name: 'Imported' } } })
  }));
  const importBody = await importRes.json();
  assert.equal(importBody.success, true);
  assert.deepEqual(room.roomState, { projects: { p2: { name: 'Imported' } } });
});

test('fetch /internal/import rejects a body that is not { projects: {...} }', async () => {
  const state = makeFakeState();
  const room = new ApsRoom(state, {});
  const res = await room.fetch(new Request('https://internal/internal/import', {
    method: 'POST', body: JSON.stringify({ notProjects: true })
  }));
  assert.equal(res.status, 400);
});
