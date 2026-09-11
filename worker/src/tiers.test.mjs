import test from 'node:test';
import assert from 'node:assert/strict';
import { VALID_TIERS, tierAtLeast } from './tiers.js';

test('tierAtLeast: a higher or equal tier passes, a lower tier fails', () => {
  assert.equal(tierAtLeast('admin', 'editor'), true);
  assert.equal(tierAtLeast('editor', 'editor'), true);
  assert.equal(tierAtLeast('viewer', 'editor'), false);
});

test('tierAtLeast: an unrecognized role or minTier never passes', () => {
  assert.equal(tierAtLeast('bogus', 'editor'), false);
  assert.equal(tierAtLeast('admin', 'bogus'), false);
});

test('VALID_TIERS is ordered lowest to highest, matching the app\'s own PERMISSION_TIERS', () => {
  assert.deepEqual(VALID_TIERS, ['viewer', 'commenter', 'editor', 'projectAdmin', 'admin']);
});
