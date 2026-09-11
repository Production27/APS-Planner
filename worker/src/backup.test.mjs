import test from 'node:test';
import assert from 'node:assert/strict';
import { roomStateToAppFormat, appFormatToRoomState } from './backup.ts';

function sampleRoomState() {
  return {
    projects: {
      p1: {
        name: 'Sample Project',
        jobs: { 'job-2': { id: 'job-2', order: 1 }, 'job-1': { id: 'job-1', order: 0 } },
        boardCards: { 'card-1': { id: 'card-1' } },
        calendarEvents: { 'ev-1': { id: 'ev-1' } },
        boardColumns: [{ id: 'col-1' }],
        fieldOptions: { pm: ['Alice'] },
        deletedIds: { 'x': 12345 },
        header: { title: 'Sample', subtitle: '', theme: { c1: '#111', c2: '#222' } }
      }
    }
  };
}

test('roomStateToAppFormat sorts jobs by order and converts maps to arrays', () => {
  const appData = roomStateToAppFormat(sampleRoomState());
  assert.equal(appData.version, 3);
  assert.deepEqual(appData.projects.p1.jobs.map(j => j.id), ['job-1', 'job-2']);
  assert.deepEqual(appData.projects.p1.boardCards, [{ id: 'card-1' }]);
  assert.equal(appData.activeProjectId, 'p1');
});

test('appFormatToRoomState converts arrays back into id-keyed maps', () => {
  const appData = roomStateToAppFormat(sampleRoomState());
  const roundTripped = appFormatToRoomState(appData);
  assert.deepEqual(Object.keys(roundTripped.projects.p1.jobs).sort(), ['job-1', 'job-2']);
  assert.equal(roundTripped.projects.p1.boardCards['card-1'].id, 'card-1');
  assert.equal(roundTripped.projects.p1.name, 'Sample Project');
});

test('a full export-then-import round trip preserves job/card/event content', () => {
  const original = sampleRoomState();
  const restored = appFormatToRoomState(roomStateToAppFormat(original));
  assert.deepEqual(restored.projects.p1.jobs['job-1'], original.projects.p1.jobs['job-1']);
  assert.deepEqual(restored.projects.p1.boardCards['card-1'], original.projects.p1.boardCards['card-1']);
  assert.deepEqual(restored.projects.p1.fieldOptions, original.projects.p1.fieldOptions);
});

test('roomStateToAppFormat defaults a missing project name/header rather than crashing', () => {
  const appData = roomStateToAppFormat({ projects: { p1: { jobs: {}, boardCards: {}, calendarEvents: {} } } });
  assert.equal(appData.projects.p1.name, 'Untitled Project');
  assert.equal(appData.projects.p1.header.title, 'Untitled');
});
