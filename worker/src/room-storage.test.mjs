// Per-item storage layout and the migration from the single 'room' value.
//   node --test worker/src/room-storage.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readItemizedRoom, writeFullRoom, writeRoomChange, migrateLegacyRoom,
  itemKey, projectMetaKey, META_KEY, LEGACY_KEY
} from './room-storage.ts';
import { blankProject, applyMessage, computeRoomDelta } from './room-state.ts';
import { ApsRoom } from './room-do.ts';
import { makeFakeStorage, makeFakeState, makeFakeWs } from './test-fakes.mjs';

const admin = { username: 'a', displayName: 'Admin', role: 'admin', assignedProjectId: null };

function legacyRoom(nJobs = 3) {
  const p1 = blankProject('Advanced');
  for (let i = 0; i < nJobs; i++) {
    p1.jobs['job-' + i] = { id: 'job-' + i, name: 'Job ' + i, order: i, tasks: [{ id: 't' + i, start: '2026-09-01', finish: '2026-09-03' }], comments: [{ id: 'c' + i, text: 'hi', replies: [] }], updatedAt: 1 };
    p1.boardCards['card-' + i] = { id: 'card-' + i, jobId: 'job-' + i, column: 'bid', checklists: { bid: [{ id: 'k', text: 'x', done: false }] }, updatedAt: 1 };
  }
  p1.calendarEvents['ev-1'] = { id: 'ev-1', title: 'Safety', start: '2026-09-10', repeat: 'weekly' };
  p1.boardColumns = [{ id: 'bid', label: 'Bid', color: '#6dd5e8' }];
  p1.workflowItems = [{ id: 'w1', label: 'Measure' }];
  p1.activityLog = [{ who: 'A', what: 'did', when: 5 }];
  p1.deletedIds = { gone: Date.now() };
  const p2 = blankProject('Bludorn');
  p2.jobs['a:b.c-d_e'] = { id: 'a:b.c-d_e', name: 'Odd id' };
  p2.boardCards[12345] = { id: 12345, column: 'bid' };
  return { projects: { 'project-fixed-a': p1, 'project-fixed-b': p2 } };
}

test('migration copies every item, verifies, marks v2, and leaves the old value untouched', async () => {
  const fake = makeFakeStorage();
  const legacy = legacyRoom();
  await fake.storage.put({ [LEGACY_KEY]: legacy });
  const before = JSON.stringify(fake._store.get(LEGACY_KEY));

  const result = await migrateLegacyRoom(fake.storage, legacy);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual({ jobs: result.jobs, cards: result.cards, events: result.events }, { jobs: 4, cards: 4, events: 1 });
  assert.deepEqual(await readItemizedRoom(fake.storage), JSON.parse(JSON.stringify(legacy)));
  assert.equal(JSON.stringify(fake._store.get(LEGACY_KEY)), before, 'the old value is never modified');
  assert.ok(fake._store.get(META_KEY).migratedFromLegacyAt);
  assert.ok(fake._store.has(itemKey('project-fixed-b', 'jobs', 'a:b.c-d_e')), 'odd ids survive');
  assert.ok(fake._store.has(itemKey('project-fixed-b', 'boardCards', '12345')));
});

test('a migration whose read-back does not match leaves no v2 data behind', async () => {
  const fake = makeFakeStorage();
  const legacy = legacyRoom();
  // Corrupt what gets read back: the list() of the first project drops a job.
  const realList = fake.storage.list;
  fake.storage.list = async (opts) => {
    const m = await realList(opts);
    if (opts.prefix === 'p|project-fixed-a|') m.delete(itemKey('project-fixed-a', 'jobs', 'job-1'));
    return m;
  };
  const result = await migrateLegacyRoom(fake.storage, legacy);
  assert.equal(result.ok, false);
  fake.storage.list = realList;
  assert.equal(fake._store.get(META_KEY), undefined, 'no marker');
  assert.equal([...fake._store.keys()].filter((k) => k.startsWith('p|')).length, 0, 'no half-copied entries');
});

test('ApsRoom falls back to the single-value layout if migration fails, and keeps working', async () => {
  const state = makeFakeState([]);
  await state.storage.put({ [LEGACY_KEY]: legacyRoom() });
  state.storage.transaction = async () => { throw new Error('simulated storage outage during migration'); };
  const ws = makeFakeWs({ ...admin, proto: 2 });
  state.getWebSockets = () => [ws];
  const room = new ApsRoom(state, {});
  const loaded = await room.loadRoomState();
  assert.equal(room.legacyLayout, true);
  assert.ok(loaded.projects['project-fixed-a'].jobs['job-0']);
  await room.webSocketMessage(ws, JSON.stringify({ type: 'upsertJob', projectId: 'project-fixed-a', msgId: 1, job: { id: 'job-0', name: 'Still saves', updatedAt: 9 } }));
  assert.ok(ws._sent.find((m) => m.type === 'ack'));
  assert.equal(state._store.get(LEGACY_KEY).projects['project-fixed-a'].jobs['job-0'].name, 'Still saves');
});

test('ApsRoom migrates on first load, then a fresh instance reads the same data back', async () => {
  const state = makeFakeState([]);
  const legacy = legacyRoom();
  await state.storage.put({ [LEGACY_KEY]: legacy });
  const room = new ApsRoom(state, {});
  await room.loadRoomState();
  assert.equal(room.legacyLayout, false);
  const again = new ApsRoom(state, {});
  assert.deepEqual(await again.loadRoomState(), JSON.parse(JSON.stringify(legacy)));
});

test('two loads at once migrate only once', async () => {
  const state = makeFakeState([]);
  await state.storage.put({ [LEGACY_KEY]: legacyRoom() });
  let migrations = 0;
  const realTxn = state.storage.transaction;
  state.storage.transaction = async (fn) => { migrations++; return realTxn(fn); };
  const room = new ApsRoom(state, {});
  const [a, b] = await Promise.all([room.loadRoomState(), room.loadRoomState()]);
  assert.equal(a, b);
  assert.equal(migrations, 1);
});

// ── writes after migration ──
async function migrated(nJobs) {
  const fake = makeFakeStorage();
  const legacy = legacyRoom(nJobs);
  await migrateLegacyRoom(fake.storage, legacy);
  return { fake, state: await readItemizedRoom(fake.storage) };
}
function spyPuts(fake) {
  const log = { puts: [], deletes: [] };
  const put = fake.storage.put, del = fake.storage.delete;
  fake.storage.put = async (e, v) => { log.puts.push(...(typeof e === 'string' ? [e] : Object.keys(e))); return put(e, v); };
  fake.storage.delete = async (k) => { log.deletes.push(...(Array.isArray(k) ? k : [k])); return del(k); };
  return log;
}

test('one job edit writes that job plus the project\'s small settings entry (revision counter) — nothing else', async () => {
  const { fake, state } = await migrated(50);
  const r = applyMessage(state, { type: 'upsertProjectBatch', projectId: 'project-fixed-a', jobs: [{ id: 'job-7', name: 'Edited', order: 7, updatedAt: 9 }] }, admin);
  const log = spyPuts(fake);
  await writeRoomChange(fake.storage, r.state, computeRoomDelta(state, r.state));
  assert.deepEqual(log.puts.sort(), [itemKey('project-fixed-a', 'jobs', 'job-7'), projectMetaKey('project-fixed-a')].sort());
  assert.deepEqual(log.deletes, []);
  assert.equal((await readItemizedRoom(fake.storage)).projects['project-fixed-a'].jobs['job-7'].name, 'Edited');
});

test('a delete removes the entry and updates the project settings (tombstone)', async () => {
  const { fake, state } = await migrated(5);
  const r = applyMessage(state, { type: 'deleteFromMap', projectId: 'project-fixed-a', mapKey: 'jobs', id: 'job-2' }, admin);
  const log = spyPuts(fake);
  await writeRoomChange(fake.storage, r.state, computeRoomDelta(state, r.state));
  assert.deepEqual(log.deletes, [itemKey('project-fixed-a', 'jobs', 'job-2')]);
  assert.deepEqual(log.puts, [projectMetaKey('project-fixed-a')]);
  const back = await readItemizedRoom(fake.storage);
  assert.equal(back.projects['project-fixed-a'].jobs['job-2'], undefined);
  assert.ok(back.projects['project-fixed-a'].deletedIds['job-2']);
});

test('project added and removed', async () => {
  const { fake, state } = await migrated(2);
  const added = applyMessage(state, { type: 'upsertJob', projectId: 'p-new', job: { id: 'x1', updatedAt: 1 } }, admin);
  await writeRoomChange(fake.storage, added.state, computeRoomDelta(state, added.state));
  assert.ok((await readItemizedRoom(fake.storage)).projects['p-new'].jobs.x1);
  const removed = applyMessage(added.state, { type: 'removeProject', projectId: 'project-fixed-b' }, admin);
  await writeRoomChange(fake.storage, removed.state, computeRoomDelta(added.state, removed.state));
  const back = await readItemizedRoom(fake.storage);
  assert.equal(back.projects['project-fixed-b'], undefined);
  assert.equal([...fake._store.keys()].filter((k) => k.startsWith('p|project-fixed-b|')).length, 0);
  assert.deepEqual(fake._store.get(META_KEY).projects.sort(), ['p-new', 'project-fixed-a']);
});

test('a failed write leaves storage exactly as it was', async () => {
  const { fake, state } = await migrated(3);
  const before = JSON.stringify([...fake._store]);
  const r = applyMessage(state, { type: 'deleteFromMap', projectId: 'project-fixed-a', mapKey: 'jobs', id: 'job-1' }, admin);
  const realPut = fake.storage.put;
  fake.storage.put = async () => { throw new Error('disk full'); };
  await assert.rejects(writeRoomChange(fake.storage, r.state, computeRoomDelta(state, r.state)));
  fake.storage.put = realPut;
  assert.equal(JSON.stringify([...fake._store]), before, 'the delete that ran before the failing put was rolled back');
});

test('import/restore replaces everything, removing items the imported state lacks', async () => {
  const { fake } = await migrated(4);
  const replacement = { projects: { 'project-fixed-a': Object.assign(blankProject('Restored'), { jobs: { only: { id: 'only' } } }) } };
  await writeFullRoom(fake.storage, replacement);
  assert.deepEqual(await readItemizedRoom(fake.storage), JSON.parse(JSON.stringify(replacement)));
  assert.equal([...fake._store.keys()].filter((k) => k.startsWith('p|project-fixed-b|')).length, 0);
});

test('1000 realistic jobs: migrates, and no single stored value comes near the 2 MB limit', async () => {
  const legacy = legacyRoom(0);
  const p = legacy.projects['project-fixed-a'];
  const note = 'frame wall panel truss header joist sill plate stud king jack cripple beam post footing anchor bolt shear '.repeat(2);
  for (let i = 0; i < 1000; i++) {
    p.jobs['j' + i] = { id: 'j' + i, name: 'Job ' + i, tasks: Array.from({ length: 5 }, (_, k) => ({ id: 't' + k, notes: note })), comments: Array.from({ length: 8 }, (_, c) => ({ id: 'c' + c, text: note, replies: [] })) };
    p.boardCards['c' + i] = { id: 'c' + i, jobId: 'j' + i, description: note, checklists: { bid: Array.from({ length: 30 }, (_, m) => ({ id: 'k' + m, text: note.slice(0, 40), done: false })) } };
  }
  const totalBytes = JSON.stringify(legacy).length;
  assert.ok(totalBytes > 2 * 1024 * 1024, 'this room is bigger than the old 2 MB single-value limit (' + totalBytes + ' bytes)');
  const fake = makeFakeStorage();
  const result = await migrateLegacyRoom(fake.storage, legacy);
  assert.equal(result.ok, true, result.error);
  const largest = Math.max(...[...fake._store.values()].map((v) => JSON.stringify(v).length));
  assert.ok(largest < 64 * 1024, 'largest single entry is ' + largest + ' bytes');
});
