const { test, expect } = require('@playwright/test');
const { APP_URL, seedSession, mockRoomWebSocket } = require('./helpers');

// Screenshot baselines are pixel-specific to the OS/renderer they were
// generated on (font hinting/antialiasing differs) — Playwright already
// namespaces snapshot files by platform for exactly this reason, so these
// only ever compare against a baseline generated in CI (ubuntu-latest),
// never one generated on a dev machine. See SESSION_HANDOFF.md /
// project_architecture_roadmap for how the baseline files here were
// produced.
//
// The clock is frozen so nothing date-relative (a "today" marker, a
// relative activity-log timestamp) drifts the render between the day a
// baseline was captured and the day this test runs.
const FROZEN_NOW = '2026-09-01T12:00:00';

async function prepPage(page) {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.clock.install({ time: new Date(FROZEN_NOW) });
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => document.fonts.ready);
}

test('visual: home dashboard', async ({ page }) => {
  await prepPage(page);
  await page.evaluate(() => switchTabMorphed('home'));
  await expect(page).toHaveScreenshot('home.png', { fullPage: true, animations: 'disabled' });
});

test('visual: gantt chart', async ({ page }) => {
  await prepPage(page);
  await page.evaluate(() => switchTabMorphed('gantt'));
  await expect(page).toHaveScreenshot('gantt.png', { fullPage: true, animations: 'disabled' });
});

test('visual: board', async ({ page }) => {
  await prepPage(page);
  await page.evaluate(() => switchTabMorphed('board'));
  await expect(page).toHaveScreenshot('board.png', { fullPage: true, animations: 'disabled' });
});

test('visual: calendar', async ({ page }) => {
  await prepPage(page);
  await page.evaluate(() => switchTabMorphed('calendar'));
  await expect(page).toHaveScreenshot('calendar.png', { fullPage: true, animations: 'disabled' });
});
