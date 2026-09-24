const { test, expect } = require('@playwright/test');
const { APP_URL, seedSession, mockRoomWebSocket } = require('./helpers');

// Reports tab (src/views/reports.tsx): period stepping, the headline
// figures, insights, drill-down lists and filters, against seeded jobs.

async function openApp(page) {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
}

// Two jobs finished inside LAST month (so the test never depends on what
// day of the month it runs), one still open. Customers Acme and Globex.
async function seedHistory(page) {
  await page.evaluate(() => {
    localStorage.removeItem('teamsync_reports_v2');
    const now = new Date();
    const pm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const at = (o) => { const x = new Date(pm); x.setDate(x.getDate() + o); return toIsoDate(x); };
    const fromToday = (o) => { const x = new Date(); x.setDate(x.getDate() + o); return toIsoDate(x); };
    const col = BOARD_COLUMNS[0];
    jobs.length = 0; boardCards.length = 0;
    const mk = (id, name, start, finish, customer, due) => {
      const job = { id, name, color: '#3949ab', archived: false, order: 0, comments: [],
        tasks: [{ id: id + 't', name: col.label, columnId: col.id, order: 0, start, finish }] };
      jobs.push(job);
      ensureJobHasCards(job);
      const card = getPrimaryPhaseCard(job);
      card.customFields = { customer };
      card.due = due;
    };
    mk('h1', 'Done On Time', at(0), at(9), 'Acme', at(10));    // 10 days, a day early
    mk('h2', 'Done Late', at(5), at(14), 'Acme', at(10));      // 10 days, 4 days late
    mk('h3', 'Still Open', fromToday(0), fromToday(10), 'Globex', fromToday(20));
    renderAll();
    switchTab('reports');
  });
}

const stat = (page, label) => page.locator('.rep-stat').filter({ has: page.locator('.rep-stat-label', { hasText: new RegExp('^' + label + '$') }) }).locator('.rep-stat-value');
const openSub = (page) => page.locator('.rep-card', { hasText: 'Where open jobs are' }).locator('header p');

test('reports: stepping back a month shows what finished, on time and how long it took', async ({ page }) => {
  await openApp(page);
  await seedHistory(page);
  await page.locator('.rep-step[aria-label="Previous period"]').click();
  await expect(stat(page, 'Finished')).toHaveText('2');
  await expect(stat(page, 'On time')).toHaveText('50%');
  await expect(stat(page, 'Avg job length')).toHaveText('10 days');
  await expect(page.locator('.rep-headline')).toContainText('2 jobs finished in');
  const finished = page.locator('.rep-card', { hasText: 'Finished in' });
  await expect(finished.locator('.rep-job', { hasText: 'Done Late' })).toContainText('4 days late');
  await expect(finished.locator('.rep-job', { hasText: 'Done On Time' })).toContainText('On time');
  // The same month is selected in the headline chart; clicking the last bar goes back to now.
  await expect(page.locator('.rep-hero .rep-bar-col.selected')).toHaveCount(1);
  await page.locator('.rep-hero .rep-bar-col').last().click();
  await expect(page.locator('.rep-headline')).toContainText('So far in');
});

test('reports: an overdue job shows as an insight, updates live, and opens from its link', async ({ page }) => {
  await openApp(page);
  await seedHistory(page);
  await page.evaluate(() => {
    const x = new Date(); x.setDate(x.getDate() - 2);
    getPrimaryPhaseCard(jobs.find((j) => j.id === 'h3')).due = toIsoDate(x);
    renderAll();
  });
  const insight = page.locator('.rep-insight.critical');
  await expect(insight).toContainText('1 job past due');
  await expect(insight).toContainText('Still Open');
  await insight.locator('a', { hasText: 'Still Open' }).click();
  await expect.poll(() => page.evaluate(() => editingJobId)).toBe('h3');
  await page.evaluate(() => {
    cancelEdit();
    const x = new Date(); x.setDate(x.getDate() + 30);
    getPrimaryPhaseCard(jobs.find((j) => j.id === 'h3')).due = toIsoDate(x);
    renderAll();
  });
  await expect(page.locator('.rep-insight.critical')).toHaveCount(0);
});

test('reports: open stages and weeks expand into their jobs', async ({ page }) => {
  await openApp(page);
  await seedHistory(page);
  await expect(openSub(page)).toContainText('1 open job');
  await page.locator('.rep-stage-row').first().click();
  await expect(page.locator('.rep-stage-list .rep-job')).toContainText('Still Open');
  await expect(page.locator('.rep-week-detail')).toContainText('Still Open');
  await page.locator('.rep-lookahead .rep-bar-col').last().click();
  await expect(page.locator('.rep-week-detail')).toContainText('Nothing scheduled that week');
});

test('reports: a customer filter scopes every figure, and the breakdown sets it', async ({ page }) => {
  await openApp(page);
  await seedHistory(page);
  await page.locator('.rep-card', { hasText: 'Breakdown' }).locator('.rep-seg button', { hasText: 'Customer' }).click();
  await page.locator('.rep-rank a', { hasText: 'Globex' }).click();
  await expect(page.locator('.rep-chip')).toContainText('Globex');
  await page.locator('.rep-step[aria-label="Previous period"]').click();
  await expect(stat(page, 'Finished')).toHaveText('0');
  await page.locator('.rep-chip button').click();
  await expect(stat(page, 'Finished')).toHaveText('2');
  // The filter menu sets the same thing.
  await page.locator('.rep-filter-btn').click();
  await page.locator('.rep-filter-menu select').first().selectOption('Acme');
  await expect(page.locator('.rep-chip')).toContainText('Acme');
  await expect(openSub(page)).toContainText('0 open jobs');
});
