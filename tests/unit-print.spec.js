const { test, expect } = require('@playwright/test');
const { APP_URL, seedSession, mockRoomWebSocket } = require('./helpers');

// Print / Save as PDF (src/app/print.ts): the dialog builds a print-only
// document in a hidden iframe and calls print() on it. print() is stubbed
// in every frame so the test can assert it ran without a real dialog.

async function openApp(page) {
  await page.addInitScript(() => {
    window.print = function () { window.top.__printCalls = (window.top.__printCalls || 0) + 1; };
  });
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => {
    const j = jobs[0];
    j.name = 'Print <Test> Job';
    delete j.phases;
    j.tasks = [
      { id: 'p1', name: 'Design', color: '#6dd5e8', order: 0, start: '2026-09-21', finish: '2026-09-23' },
      { id: 'p2', name: 'Panel', color: '#ffbe6b', order: 1, start: '2026-09-24', finish: '2026-09-29' },
    ];
  });
}

async function printFrameText(page) {
  await expect.poll(() => page.evaluate(() => window.__printCalls || 0)).toBeGreaterThan(0);
  return page.evaluate(() => document.getElementById('printFrame').contentDocument.body.innerText);
}

test('print Gantt: prints the chosen window with job rows, task labels and a color key', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => toggleSettingsMenu());
  await page.locator('#printBtn').click();
  await page.locator('#printGanttStart').fill('2026-09-21');
  await page.locator('#printGanttWeeks').selectOption('4');
  await page.locator('#printRunBtn').click();

  const text = await printFrameText(page);
  expect(text).toContain('Gantt chart');
  expect(text).toContain('Sep 21, 2026 – Oct 18, 2026');
  expect(text).toContain('Print <Test> Job'); // escaped, not parsed as a tag
  expect(text).toContain('Design');
  expect(text).toContain('Panel');
  await expect(page.locator('#printModal')).not.toHaveClass(/show/);
});

test('print Calendar: month grid lists each day\'s scheduled work', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => toggleSettingsMenu());
  await page.locator('#printBtn').click();
  await page.locator('#printKindCalendar').check();
  await expect(page.locator('#printGanttOpts')).toBeHidden();
  await page.locator('#printCalMonth').fill('2026-09');
  await page.locator('#printRunBtn').click();

  const text = await printFrameText(page);
  expect(text).toContain('September 2026');
  expect(text).toContain('Print <Test> Job · Design');
  expect(text).toContain('Print <Test> Job · Panel');
});
