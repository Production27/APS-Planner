import test from 'node:test';
import assert from 'node:assert/strict';
import { jsonResponse } from './http.js';

test('jsonResponse sets status, content-type, and merges in the given headers', async () => {
  const res = jsonResponse({ ok: true }, 201, { 'X-Custom': 'yes' });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('Content-Type'), 'application/json');
  assert.equal(res.headers.get('X-Custom'), 'yes');
  assert.deepEqual(await res.json(), { ok: true });
});
