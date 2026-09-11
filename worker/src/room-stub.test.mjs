import test from 'node:test';
import assert from 'node:assert/strict';
import { getRoomStub } from './room-stub.ts';

test('getRoomStub always resolves the same fixed room name, regardless of caller', () => {
  const seenNames = [];
  const fakeEnv = {
    APS_ROOM: {
      idFromName(name) { seenNames.push(name); return { name }; },
      get(id) { return { stubFor: id.name }; }
    }
  };
  const stubA = getRoomStub(fakeEnv);
  const stubB = getRoomStub(fakeEnv);
  assert.deepEqual(seenNames, ['aps-production-room', 'aps-production-room']);
  assert.equal(stubA.stubFor, 'aps-production-room');
  assert.equal(stubB.stubFor, 'aps-production-room');
});
