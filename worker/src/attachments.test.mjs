import test from 'node:test';
import assert from 'node:assert/strict';
import { isSafeInlineImageType } from './attachments.js';

test('isSafeInlineImageType accepts ordinary image types', () => {
  assert.equal(isSafeInlineImageType('image/png'), true);
  assert.equal(isSafeInlineImageType('image/jpeg'), true);
});

test('isSafeInlineImageType rejects image/svg+xml (the stored-XSS vector)', () => {
  assert.equal(isSafeInlineImageType('image/svg+xml'), false);
});

test('isSafeInlineImageType rejects non-image types and malformed input', () => {
  assert.equal(isSafeInlineImageType('text/html'), false);
  assert.equal(isSafeInlineImageType('application/octet-stream'), false);
  assert.equal(isSafeInlineImageType(''), false);
  assert.equal(isSafeInlineImageType(null), false);
  assert.equal(isSafeInlineImageType(undefined), false);
});
