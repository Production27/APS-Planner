const { test, expect } = require('@playwright/test');
const { APP_URL, seedSession, mockRoomWebSocket } = require('./helpers');

test('login: a valid seeded session bypasses the login overlay', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await page.goto(APP_URL);

  await expect(page.locator('#loginOverlay')).not.toHaveClass(/show/);
  await expect(page.locator('#jobList')).toBeAttached();
});

test('job CRUD: creating a job via the UI lands in the underlying data model', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#loginOverlay')).not.toHaveClass(/show/);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const jobName = 'Playwright smoke test job ' + Date.now();
  // Driven via addNewJob() directly rather than clicking one of its two
  // trigger buttons (the always-visible rail one, or the dynamically
  // rendered one at the bottom of the job list) — which button is even
  // clickable depends on which tab/panel is active and how wide the job
  // rail is, none of which this test cares about; it's exercising the
  // draft-job -> autosave -> data-model path, same as either button does.
  await page.evaluate(() => addNewJob());
  await page.locator('#f_job').fill(jobName);
  // Force the debounced autosave to flush immediately rather than waiting
  // on its real-world debounce timer — deterministic, not timing-dependent.
  await page.evaluate(() => flushAutoSaveJobForm());

  // Verified against the actual data model, not the DOM — a save that
  // "looks right" on screen isn't proof it stuck (see SESSION_HANDOFF.md).
  const savedJobExists = await page.evaluate((name) => {
    const proj = getActiveProject();
    return !!(proj && Object.values(proj.jobs || {}).some((j) => j.name === name));
  }, jobName);
  expect(savedJobExists).toBe(true);
});

test('regression (Fix 3): isBusyEditing() now covers an in-progress Board drag', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await page.goto(APP_URL);
  await expect(page.locator('#loginOverlay')).not.toHaveClass(/show/);

  const cardDragBusy = await page.evaluate(() => {
    draggedCardId = 'test-card-id';
    const busy = isBusyEditing();
    draggedCardId = null;
    return busy;
  });
  expect(cardDragBusy).toBe(true);

  const colDragBusy = await page.evaluate(() => {
    draggedColId = 'test-col-id';
    const busy = isBusyEditing();
    draggedColId = null;
    return busy;
  });
  expect(colDragBusy).toBe(true);

  const idleBusy = await page.evaluate(() => isBusyEditing());
  expect(idleBusy).toBe(false);
});

test('regression (Fix 4): a first-connection failure escalates the sync indicator instead of hanging on "Connecting…"', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page); // real connection succeeds; the scenario below is simulated directly
  await page.clock.install();
  await page.goto(APP_URL);
  await expect(page.locator('#loginOverlay')).not.toHaveClass(/show/);

  // Simulating this via real WebSocket retry timing means fighting
  // ReconnectingWebSocket's own backoff schedule (unknown/unstable exact
  // values) rather than testing this app's code — same reasoning as the
  // Fix 3 test above calling isBusyEditing() directly instead of
  // simulating a real HTML5 drag. Fix 4 changed exactly one thing:
  // handleRoomClose() now calls scheduleOfflineEscalation() even when
  // roomEverConnected is still false (a first-connection failure) —
  // exercise that directly.
  await page.evaluate(() => {
    roomEverConnected = false;
    handleRoomClose({ code: 1006 });
  });

  // scheduleOfflineEscalation()'s timer is 8s; fast-forward well past it
  // deterministically rather than waiting on a real 8-second clock.
  await page.clock.fastForward(15000);

  const tooltip = await page.evaluate(() => document.getElementById('syncDot')?.title || '');
  expect(tooltip.toLowerCase()).toContain('offline');
});
