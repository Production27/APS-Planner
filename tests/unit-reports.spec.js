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

// History, date range and filters: three jobs with known dates, two
// customers. Completion is the last task's finish once it has passed.
async function seedHistory(page) {
  await page.evaluate(() => {
    localStorage.removeItem('teamsync_reports_filters_v1');
    const d = (o) => { const x = new Date(); x.setDate(x.getDate() + o); return toIsoDate(x); };
    const col = BOARD_COLUMNS[0];
    jobs.length = 0; boardCards.length = 0;
    const mk = (id, name, start, finish, customer, due) => {
      const job = { id, name, color: '#3949ab', archived: false, order: 0, comments: [],
        tasks: [{ id: id + 't', name: col.label, columnId: col.id, order: 0, start: d(start), finish: d(finish) }] };
      jobs.push(job);
      ensureJobHasCards(job);
      const card = getPrimaryPhaseCard(job);
      card.customFields = { customer };
      card.due = d(due);
    };
    mk('h1', 'Done On Time', -40, -31, 'Acme', -30);      // 10 days, finished before due
    mk('h2', 'Done Late', -20, -11, 'Acme', -15);         // 10 days, finished after due
    mk('h3', 'Still Open', -5, 10, 'Globex', 20);
    renderAll();
    switchTab('reports');
  });
}

test('reports: completed, average length and due-date figures come from the schedule', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await seedHistory(page);
  const tile = (label) => page.locator('.rep-tile').filter({ has: page.locator('.rep-tile-label', { hasText: new RegExp('^' + label + '$') }) }).locator('.rep-tile-value');
  await expect(tile('Open jobs')).toHaveText('1');
  await expect(tile('Completed')).toHaveText('2');
  await expect(tile('Avg job length')).toHaveText('10 days');
  await expect(tile('Finished by due date')).toHaveText('50%');

  // 30 days drops the job that finished 31 days ago.
  await page.locator('.rep-seg button', { hasText: '30 days' }).click();
  await expect(tile('Completed')).toHaveText('1');
  await expect(tile('Finished by due date')).toHaveText('0%');

  // Hovering a column shows its tooltip.
  await page.locator('.rep-seg button', { hasText: '90 days' }).click();
  await page.locator('.rep-cols').first().locator('.rep-col').last().hover();
  await expect(page.locator('.rep-tip')).toContainText('Started');
});

test('reports: a customer filter scopes every figure, and the breakdown sets it', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await seedHistory(page);
  await page.locator('.rep-breakdown').scrollIntoViewIfNeeded();
  await page.locator('.rep-panel', { hasText: 'Breakdown' }).locator('.rep-seg button', { hasText: 'Customer' }).click();
  await expect(page.locator('.rep-breakdown tbody tr')).toHaveCount(2);
  await page.locator('.rep-breakdown a', { hasText: 'Globex' }).click();
  await expect(page.locator('.rep-select', { hasText: 'Customer' }).locator('select')).toHaveValue('Globex');
  await expect(page.locator('.rep-tile').filter({ has: page.locator('.rep-tile-label', { hasText: /^Completed$/ }) }).locator('.rep-tile-value')).toHaveText('0');
  await expect(page.locator('.rep-tile').filter({ has: page.locator('.rep-tile-label', { hasText: /^Open jobs$/ }) }).locator('.rep-tile-value')).toHaveText('1');
  await page.locator('.rep-clear').click();
  await expect(page.locator('.rep-tile').filter({ has: page.locator('.rep-tile-label', { hasText: /^Completed$/ }) }).locator('.rep-tile-value')).toHaveText('2');
});
