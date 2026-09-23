import test from 'node:test';
import assert from 'node:assert/strict';
import { jsonResponse } from './http.ts';

test('jsonResponse sets status, content-type, and merges in the given headers', async () => {
  const res = jsonResponse({ ok: true }, 201, { 'X-Custom': 'yes' });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('Content-Type'), 'application/json');
  assert.equal(res.headers.get('X-Custom'), 'yes');
  assert.deepEqual(await res.json(), { ok: true });
});

// ── /health (index.ts), used by the public status page ──
import worker from './index.ts';
test('GET /health answers ok when the room responds, 503 when it does not', async () => {
  const env = (roomOk) => ({ APS_ROOM: { idFromName: (n) => ({ n }), get: () => ({ fetch: async () => (roomOk ? new Response('ok') : new Response('x', { status: 500 })) }) } });
  const ok = await worker.fetch(new Request('https://w.example/health'), env(true), {});
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).status, 'ok');
  assert.equal(ok.headers.get('Cache-Control'), 'no-store');
  const down = await worker.fetch(new Request('https://w.example/health'), env(false), {});
  assert.equal(down.status, 503);
});
