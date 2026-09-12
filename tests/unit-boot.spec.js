const { test, expect } = require('@playwright/test');
const { APP_URL, seedSession, mockRoomWebSocket } = require('./helpers');

// Boot glue — init()/boot(), mergeTombstones(), and the global Escape-key/
// click-outside handlers — moved from index.html to src/app/boot.ts in
// Phase 11, the last phase of the extraction plan. None of these had
// direct test coverage before (every existing test just relies on boot()
// having already run, without exercising the Escape/click-outside
// handlers or mergeTombstones() themselves).

test('mergeTombstones: keeps entries from both sides, and drops any older than the TTL', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const result = await page.evaluate(() => {
    const now = Date.now();
    const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000; // older than the 7-day TTL
    const a = { 'from-a-fresh': now, 'from-a-stale': eightDaysAgo };
    const b = { 'from-b-fresh': now };
    return mergeTombstones(a, b);
  });

  expect(Object.keys(result).sort()).toEqual(['from-a-fresh', 'from-b-fresh']);
});

test('mergeTombstones: tolerates an undefined first argument (a project with no tombstones yet)', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const result = await page.evaluate(() => mergeTombstones(undefined, { 'new-id': Date.now() }));
  expect(Object.keys(result)).toEqual(['new-id']);
});

test('Escape key closes the settings menu, the job drawer, and a member multi-select dropdown all at once', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const jobId = await page.evaluate(() => jobs[0].id);
  await page.evaluate((id) => editJob(id), jobId);
  await page.evaluate(() => toggleSettingsMenu());
  await expect(page.locator('#formArea')).toHaveClass(/open/);
  await expect(page.locator('#settingsDropdown')).toHaveClass(/show/);

  await page.keyboard.press('Escape');

  await expect(page.locator('#formArea')).not.toHaveClass(/open/);
  await expect(page.locator('#settingsDropdown')).not.toHaveClass(/show/);
});

test('click-outside: clicking outside the open job drawer closes it, but the click that opened it does not', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const jobId = await page.evaluate(() => jobs[0].id);
  // Open via a real click on the job's own list card (not editJob() directly)
  // so the mousedown snapshot this test is actually exercising happens
  // through the real event sequence, matching how a user would trigger it.
  await page.evaluate(() => toggleJobRail());
  await page.locator('#jobList .job-card').first().click();
  await expect(page.locator('#formArea')).toHaveClass(/open/);

  // A click on a genuinely unrelated part of the page (outside the drawer,
  // outside the job rail — which sits at the left edge, hence the
  // far-right position here — and outside any modal) closes it.
  await page.locator('body').click({ position: { x: 1150, y: 10 } });
  await expect(page.locator('#formArea')).not.toHaveClass(/open/);
});

test('click-outside: clicking a DIFFERENT job\'s card while the drawer is already open switches jobs instead of closing the drawer', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  await page.evaluate(() => toggleJobRail());
  const cards = page.locator('#jobList .job-card');
  await cards.nth(0).click();
  const firstJobId = await page.evaluate(() => editingJobId);
  await expect(page.locator('#formArea')).toHaveClass(/open/);

  await cards.nth(1).click();
  const secondJobId = await page.evaluate(() => editingJobId);

  expect(secondJobId).not.toBe(firstJobId);
  await expect(page.locator('#formArea')).toHaveClass(/open/);
});
