// Delta sync: copy-on-write handlers, computeRoomDelta(), delta scoping,
// and ApsRoom's per-protocol broadcast. Run with:
//   node --test worker/src/delta.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blankProject, applyMessage, computeRoomDelta, computeProjectDelta,
  filterRoomDeltaForAttachment, copyProjectForWrite
} from './room-state.ts';
import { ApsRoom } from './room-do.ts';
import { makeFakeState, makeFakeWs } from './test-fakes.mjs';

const admin = { username: 'a', displayName: 'Admin', role: 'admin', assignedProjectId: null };

function room() {
  const p1 = blankProject('One');
  p1.jobs = { j1: { id: 'j1', name: 'Job 1', updatedAt: 1 }, j2: { id: 'j2', name: 'Job 2', updatedAt: 1 } };
  p1.boardCards = { c1: { id: 'c1', jobId: 'j1', column: 'bid', updatedAt: 1 } };
  const p2 = blankProject('Two');
  p2.jobs = { k1: { id: 'k1', name: 'Other', updatedAt: 1 } };
  return { projects: { p1, p2 } };
}

// Every handler must leave the previous state exactly as it was —
// computeRoomDelta() and the rollback-on-persist-failure path both rely on it.
const writes = [
  { type: 'upsertJob', projectId: 'p1', job: { id: 'j1', name: 'Renamed', updatedAt: 5 } },
  { type: 'upsertCard', projectId: 'p1', card: { id: 'c1', jobId: 'j1', column: 'active', updatedAt: 5 } },
  { type: 'upsertCalendarEvent', projectId: 'p1', event: { id: 'e1', title: 'Meet', start: '2026-09-01', updatedAt: 5 } },
  { type: 'upsertProjectBatch', projectId: 'p1', jobs: [{ id: 'j2', name: 'Two!', updatedAt: 5 }] },
  { type: 'deleteFromMap', projectId: 'p1', mapKey: 'jobs', id: 'j2' },
  { type: 'recordTombstone', projectId: 'p1', id: 'zz' },
  { type: 'logActivity', projectId: 'p1', what: 'did a thing' },
  { type: 'setBoardColumns', projectId: 'p1', baseFieldRevision: 0, value: [{ id: 'bid', label: 'Bid' }] },
  { type: 'renameProject', projectId: 'p1', name: 'One+' },
  { type: 'removeProject', projectId: 'p2' },
];
for (const msg of writes) {
  test('copy-on-write: ' + msg.type + ' leaves the previous state untouched', () => {
    const prev = room();
    const before = JSON.stringify(prev);
    const r = applyMessage(prev, msg, admin);
    assert.equal(r.changed, true, msg.type + ' should change state');
    assert.equal(JSON.stringify(prev), before);
    assert.notEqual(r.state, prev);
  });
}

test('delta: upserting one job sends only that job, and untouched projects are omitted', () => {
  const prev = room();
  const r = applyMessage(prev, { type: 'upsertProjectBatch', projectId: 'p1', jobs: [{ id: 'j1', name: 'Renamed', updatedAt: 5 }] }, admin);
  const d = computeRoomDelta(prev, r.state);
  assert.deepEqual(Object.keys(d.projects), ['p1']);
  assert.deepEqual(Object.keys(d.projects.p1.jobs), ['j1']);
  assert.equal(d.projects.p1.jobs.j1.name, 'Renamed');
  assert.equal(d.projects.p1.boardCards, undefined);
  assert.equal(d.projects.p1.rev, 1);
  assert.equal(d.projects.p1.activityLog, undefined, 'unchanged activity log is not re-sent');
  assert.equal(d.projects.p1.deletedIds, undefined, 'unchanged tombstones are not re-sent');
});

test('delta: a delete sends the removed id and the new tombstone', () => {
  const prev = room();
  const r = applyMessage(prev, { type: 'deleteFromMap', projectId: 'p1', mapKey: 'jobs', id: 'j2' }, admin);
  const d = computeRoomDelta(prev, r.state).projects.p1;
  assert.deepEqual(d.removedIds, { jobs: ['j2'] });
  assert.ok(d.deletedIds.j2);
  assert.equal(d.jobs, undefined);
});

test('delta: whole-field writes and activity entries carry just those fields', () => {
  const prev = room();
  const r1 = applyMessage(prev, { type: 'setBoardColumns', projectId: 'p1', baseFieldRevision: 0, value: [{ id: 'bid', label: 'Bid' }] }, admin);
  const d1 = computeRoomDelta(prev, r1.state).projects.p1;
  assert.deepEqual(d1.boardColumns, [{ id: 'bid', label: 'Bid' }]);
  assert.equal(d1.fieldRevisions.boardColumns, 1);
  const r2 = applyMessage(prev, { type: 'logActivity', projectId: 'p1', what: 'x' }, admin);
  const d2 = computeRoomDelta(prev, r2.state).projects.p1;
  assert.equal(d2.activityLog.length, 1);
  assert.equal(d2.jobs, undefined);
});

test('delta: project added / removed', () => {
  const prev = room();
  const added = applyMessage(prev, { type: 'renameProject', projectId: 'p3', name: 'Three' }, admin);
  assert.equal(computeRoomDelta(prev, added.state).projects.p3.replace.name, 'Three');
  const removed = applyMessage(prev, { type: 'removeProject', projectId: 'p2' }, admin);
  assert.deepEqual(computeRoomDelta(prev, removed.state).projects.p2, { projectRemoved: true });
});

test('delta: nothing changed → null; an identical re-send is not a change at all', () => {
  const prev = room();
  assert.equal(computeRoomDelta(prev, prev), null);
  assert.equal(computeProjectDelta(prev.projects.p1, copyProjectForWrite(prev.projects.p1)), null);
  const r = applyMessage(prev, { type: 'upsertProjectBatch', projectId: 'p1', jobs: [{ id: 'j1', name: 'Job 1', updatedAt: 99 }] }, admin);
  assert.equal(r.changed, false, 'same content with a newer updatedAt is a no-op');
});

test('delta scoping: a project-restricted user only sees their own project', () => {
  const d = { projects: { p1: { jobs: {} }, p2: { jobs: {} } } };
  assert.deepEqual(Object.keys(filterRoomDeltaForAttachment(d, { role: 'editor', assignedProjectId: 'p2' }).projects), ['p2']);
  assert.equal(filterRoomDeltaForAttachment({ projects: { p1: {} } }, { role: 'editor', assignedProjectId: 'p2' }), null);
  assert.equal(filterRoomDeltaForAttachment(d, { role: 'admin', assignedProjectId: 'p2' }), d);
});

// ── ApsRoom broadcast ──
test('broadcast: protocol-2 clients get a delta, older clients a full snapshot, out-of-scope clients nothing', async () => {
  const writer = makeFakeWs({ ...admin, proto: 2 });
  const modern = makeFakeWs({ username: 'm', displayName: 'M', role: 'editor', assignedProjectId: null, proto: 2 });
  const legacy = makeFakeWs({ username: 'l', displayName: 'L', role: 'editor', assignedProjectId: null });
  const otherProject = makeFakeWs({ username: 'o', displayName: 'O', role: 'editor', assignedProjectId: 'p2', proto: 2 });
  const state = makeFakeState([writer, modern, legacy, otherProject]);
  const r = new ApsRoom(state, {});
  r.roomState = room();
  await r.webSocketMessage(writer, JSON.stringify({ type: 'upsertProjectBatch', projectId: 'p1', msgId: 'm1', jobs: [{ id: 'j1', name: 'Changed', updatedAt: 9 }] }));

  assert.deepEqual(writer._sent.map((m) => m.type), ['ack', 'delta']);
  const delta = modern._sent.find((m) => m.type === 'delta');
  assert.ok(delta, 'modern client receives a delta');
  assert.deepEqual(Object.keys(delta.projects.p1.jobs), ['j1']);
  assert.equal(modern._sent.some((m) => m.type === 'snapshot'), false);

  const snap = legacy._sent.find((m) => m.type === 'snapshot');
  assert.ok(snap, 'legacy client receives a full snapshot');
  assert.equal(snap.projects.p1.jobs.j1.name, 'Changed');
  assert.ok(snap.projects.p1.jobs.j2, 'snapshot still contains everything');

  assert.equal(otherProject._sent.length, 0, 'a p2-only user hears nothing about a p1 edit');
});

test('broadcast: a write that changes nothing broadcasts nothing', async () => {
  const writer = makeFakeWs({ ...admin, proto: 2 });
  const other = makeFakeWs({ username: 'm', displayName: 'M', role: 'editor', assignedProjectId: null, proto: 2 });
  const r = new ApsRoom(makeFakeState([writer, other]), {});
  r.roomState = room();
  await r.webSocketMessage(writer, JSON.stringify({ type: 'upsertProjectBatch', projectId: 'p1', msgId: 'm2', jobs: [{ id: 'j1', name: 'Job 1', updatedAt: 50 }] }));
  assert.deepEqual(writer._sent.map((m) => m.type), ['ack']);
  assert.equal(other._sent.length, 0);
});
