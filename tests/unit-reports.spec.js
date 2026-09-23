const { test, expect } = require('@playwright/test');
const { APP_URL, seedSession, mockRoomWebSocket } = require('./helpers');

// Reports tab (src/views/reports.tsx): opened from the rail, figures match
// the same builders Home uses, and it stays live as data changes.

test('reports: tiles, needs-attention and workload reflect the data, and update on change', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  await page.evaluate(() => {
    const d = (o) => { const x = new Date(); x.setDate(x.getDate() + o); return toIsoDate(x); };
    const j = jobs[0];
    j.name = 'Report Test Job';
    delete j.phases;
    j.tasks = [{ id: 'r1', name: BOARD_COLUMNS[0].label, columnId: BOARD_COLUMNS[0].id, order: 0, start: d(0), finish: d(3) }];
    getPrimaryPhaseCard(j).due = d(-2); // overdue
    renderAll();
  });

  await page.locator('#tab-reports').click();
  await expect(page.locator('#panel-reports')).toHaveClass(/active/);

  const overdueTile = page.locator('.rep-tile', { hasText: 'Overdue' });
  const overdueBefore = Number(await overdueTile.locator('.rep-tile-value').textContent());
  expect(overdueBefore).toBeGreaterThanOrEqual(1);
  await expect(page.locator('.rep-list')).toContainText('Report Test Job');
  await expect(page.locator('.rep-vbar-seg').first()).toBeVisible();

  // Moving the due date into the future drops it from Overdue live.
  await page.evaluate(() => {
    const x = new Date(); x.setDate(x.getDate() + 30);
    getPrimaryPhaseCard(jobs[0]).due = toIsoDate(x);
    renderAll();
  });
  await expect(overdueTile.locator('.rep-tile-value')).toHaveText(String(overdueBefore - 1));

  // A job link opens that job's editor.
  await page.locator('.rep-table a', { hasText: 'Report Test Job' }).first().click();
  await expect.poll(() => page.evaluate(() => editingJobId)).toBe(await page.evaluate(() => jobs[0].id));
});
