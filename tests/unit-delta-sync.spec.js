const { test, expect } = require('@playwright/test');
const { APP_URL, seedSession } = require('./helpers');

// Sync protocol 2 (src/sync/outbound.ts syncedJson + src/sync/inbound.ts
// applyRoomDelta()): saves send only changed items, and the server's
// {type:'delta'} messages merge in item by item without clobbering an
// unsaved local edit.

async function openWithFakeServer(page) {
  const server = { ws: null, url: '', sent: [] };
  await seedSession(page, { role: 'admin' });
  await page.routeWebSocket(/\/room\?/, (socket) => {
    server.ws = socket;
    server.url = socket.url();
    socket.send(JSON.stringify({ type: 'snapshot', projects: {} }));
    socket.onMessage((raw) => {
      try {
        const msg = JSON.parse(raw);
        server.sent.push(msg);
        if (msg.msgId) socket.send(JSON.stringify({ type: 'ack', msgId: msg.msgId }));
      } catch (e) {}
    });
  });
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  // Let the first-connect bootstrap push (every item, into the empty room)
  // and the follow-up push of what the app normalized locally finish:
  // wait until no new batch has arrived for a full second.
  await expect.poll(() => server.sent.filter((m) => m.type === 'upsertProjectBatch').length).toBeGreaterThan(0);
  let last = -1;
  await expect.poll(async () => {
    const n = server.sent.length;
    const quiet = n === last && await page.evaluate(() => { let c = 0; pendingWrites.forEach(() => c++); return c === 0; });
    last = n;
    return quiet;
  }, { intervals: [1000], timeout: 15000 }).toBe(true);
  server.sent.length = 0;
  return server;
}

function batches(server) { return server.sent.filter((m) => m.type === 'upsertProjectBatch'); }

test('connects with sync protocol 2', async ({ page }) => {
  const server = await openWithFakeServer(page);
  expect(server.url).toContain('proto=2');
});

test('a save sends only the job that changed — never a stale copy of one someone else just edited', async ({ page }) => {
  const server = await openWithFakeServer(page);
  const ids = await page.evaluate(() => ({ pid: activeProjectId, x: jobs[0].id, y: jobs[1].id }));

  // Someone else edits job X; it arrives as a delta.
  const remoteX = await page.evaluate((id) => Object.assign({}, findJob(id).job, { name: 'Edited by a teammate', updatedAt: Date.now() }), ids.x);
  server.ws.send(JSON.stringify({ type: 'delta', projects: { [ids.pid]: { jobs: { [ids.x]: remoteX }, rev: 5 } } }));
  await expect.poll(() => page.evaluate((id) => findJob(id).job.name, ids.x)).toBe('Edited by a teammate');

  // This browser edits job Y and saves.
  await page.evaluate((id) => { findJob(id).job.name = 'My edit'; saveJobs(); }, ids.y);
  await expect.poll(() => batches(server).length).toBeGreaterThan(0);
  const batch = batches(server)[0];
  expect(batch.jobs.map((j) => j.id)).toEqual([ids.y]);
  expect(batch.jobs[0].name).toBe('My edit');
  expect(batch.boardCards.length + batch.calendarEvents.length).toBeLessThanOrEqual(2);
});

test('nothing changed → nothing sent', async ({ page }) => {
  const server = await openWithFakeServer(page);
  await page.evaluate(() => { pushRoomState(); });
  await page.waitForTimeout(400);
  expect(batches(server).length).toBe(0);
});

test('an incoming delta never overwrites an edit this browser has not saved yet', async ({ page }) => {
  const server = await openWithFakeServer(page);
  const ids = await page.evaluate(() => ({ pid: activeProjectId, z: jobs[2].id }));
  // Local edit, still inside the 300 ms save debounce.
  await page.evaluate((id) => { findJob(id).job.name = 'Typing here'; queueSharedSync(); }, ids.z);
  const remote = await page.evaluate((id) => Object.assign({}, findJob(id).job, { name: 'Remote version', updatedAt: Date.now() }), ids.z);
  server.ws.send(JSON.stringify({ type: 'delta', projects: { [ids.pid]: { jobs: { [ids.z]: remote } } } }));
  await page.waitForTimeout(150);
  expect(await page.evaluate((id) => findJob(id).job.name, ids.z)).toBe('Typing here');
  // And the local edit is what gets sent.
  await expect.poll(() => batches(server).length).toBeGreaterThan(0);
  expect(batches(server)[0].jobs.find((j) => j.id === ids.z).name).toBe('Typing here');
});

test('a delta removal deletes the job locally and records the tombstone', async ({ page }) => {
  const server = await openWithFakeServer(page);
  const ids = await page.evaluate(() => ({ pid: activeProjectId, gone: jobs[3].id, name: jobs[3].name }));
  server.ws.send(JSON.stringify({ type: 'delta', projects: { [ids.pid]: { removedIds: { jobs: [ids.gone] }, deletedIds: { [ids.gone]: Date.now() } } } }));
  await expect.poll(() => page.evaluate((id) => !!findJob(id), ids.gone)).toBe(false);
  expect(await page.evaluate((a) => !!projects[a.pid].deletedIds[a.gone], ids)).toBe(true);
  // The Jobs rail starts closed, so its list catches up when opened.
  await page.evaluate(() => toggleJobRail());
  await expect(page.locator('#jobList')).not.toContainText(ids.name);
});

test('a delta with a new job adds it and shows it in the job list', async ({ page }) => {
  const server = await openWithFakeServer(page);
  const pid = await page.evaluate(() => activeProjectId);
  const job = { id: 'remote-new-job', name: 'Brand New Remote Job', color: '#1e88e5', archived: false, order: 999, tasks: [], comments: [], updatedAt: Date.now() };
  server.ws.send(JSON.stringify({ type: 'delta', projects: { [pid]: { jobs: { [job.id]: job } } } }));
  await expect.poll(() => page.evaluate(() => !!findJob('remote-new-job'))).toBe(true);
  await page.evaluate(() => toggleJobRail());
  await expect(page.locator('#jobList')).toContainText('Brand New Remote Job');
});

// A7 step 3: a teammate's change skips redrawing the hidden Jobs rail
// (marked stale, redrawn when shown) but updates it live when it's open.
test('the Jobs list skips redraws while hidden and updates live while open', async ({ page }) => {
  const server = await openWithFakeServer(page);
  const pid = await page.evaluate(() => activeProjectId);
  const send = (id, name) => server.ws.send(JSON.stringify({ type: 'delta', projects: { [pid]: { jobs: { [id]: { id, name, color: '#1e88e5', archived: false, order: 999, tasks: [], comments: [], updatedAt: Date.now() } } } } }));
  send('hidden-rail-job', 'Added While Closed');
  await expect.poll(() => page.evaluate(() => !!findJob('hidden-rail-job'))).toBe(true);
  await expect(page.locator('#jobList')).not.toContainText('Added While Closed');
  await page.evaluate(() => toggleJobRail());
  await expect(page.locator('#jobList')).toContainText('Added While Closed');
  send('open-rail-job', 'Added While Open');
  await expect(page.locator('#jobList')).toContainText('Added While Open');
});

test('a teammate edit refreshes an open Reports tab', async ({ page }) => {
  const server = await openWithFakeServer(page);
  const a = await page.evaluate(() => ({ pid: activeProjectId, job: JSON.parse(JSON.stringify(jobs.find((j) => !j.archived && !isJobFinished(j)))) }));
  await page.evaluate(() => switchTab('reports'));
  const activeCount = () => page.locator('#panel-reports .rep-tile').first().innerText().then((t) => Number(t.match(/\d+/)[0]));
  const before = await activeCount();
  a.job.archived = true;
  server.ws.send(JSON.stringify({ type: 'delta', projects: { [a.pid]: { jobs: { [a.job.id]: a.job } } } }));
  await expect.poll(activeCount).toBe(before - 1);
});
