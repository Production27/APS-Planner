const { test, expect } = require('@playwright/test');
const fs = require('fs');
const { APP_URL, WORKER_ORIGIN, seedSession, mockRoomWebSocket } = require('./helpers');

// Settings > Security & data and the deletion warning banner
// (src/app/compliance.ts), against mocked Worker endpoints.

async function openApp(page, role, routes) {
  await seedSession(page, { role: role || 'admin' });
  // Registered after seedSession's catch-all, so these take precedence.
  const seen = [];
  await page.route(WORKER_ORIGIN + '/**', (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.slice(1);
    const body = route.request().postDataJSON ? (() => { try { return route.request().postDataJSON(); } catch (e) { return null; } })() : null;
    seen.push({ path, body });
    const handler = routes && routes[path];
    if (url.pathname.includes('/room')) return route.abort();
    if (!handler) return route.fulfill({ status: 200, contentType: 'application/json', body: path === 'data/delete/status' ? '{"scheduled":null}' : '{}' });
    const out = handler(body);
    return route.fulfill({ status: out.status || 200, contentType: out.contentType || 'application/json', body: typeof out.body === 'string' ? out.body : JSON.stringify(out.body) });
  });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  return seen;
}

async function openPanel(page) {
  await page.evaluate(() => toggleAdminMenu());
  await page.locator('#securityDataBtn').click();
  await expect(page.locator('#securityModal')).toHaveClass(/show/);
}

test('the Security & data item is only shown to admins', async ({ page }) => {
  await openApp(page, 'editor');
  await page.evaluate(() => toggleAdminMenu());
  await expect(page.locator('#securityDataBtn')).toBeHidden();
});

test('audit log download: fetches every page for the date range and writes a CSV', async ({ page }) => {
  const e = (at, user, action, extra) => Object.assign({ at, user, role: 'admin', action }, extra || {});
  const seen = await openApp(page, 'admin', {
    'audit/export': (body) => body.after
      ? { body: { entries: [e(Date.UTC(2026, 8, 20, 15, 0, 0), 'boss', 'Deleted job', { projectName: 'Advanced', item: '=cmd()', itemId: 'j9' })], cursor: null } }
      : { body: { entries: [e(Date.UTC(2026, 8, 20, 14, 30, 5), 'eddie', 'Signed in', { ip: '203.0.113.4' })], cursor: 'page2' } },
  });
  await openPanel(page);
  await page.locator('#auditFrom').fill('2026-09-01');
  await page.locator('#auditTo').fill('2026-09-23');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#auditDownloadBtn').click()]);
  expect(dl.suggestedFilename()).toBe('teamsync-audit-log-2026-09-01-to-2026-09-23.csv');
  const lines = fs.readFileSync(await dl.path(), 'utf8').slice(1).split('\r\n');
  expect(lines[0]).toBe('Time (UTC),Time (local),User,Role,Action,Project,Item,Item ID,IP address,Details');
  expect(lines[1]).toMatch(/^2026-09-20 14:30:05,.*,eddie,admin,Signed in,,,,203\.0\.113\.4,$/);
  expect(lines[2]).toContain(",boss,admin,Deleted job,Advanced,'=cmd(),j9,");
  const calls = seen.filter((s) => s.path === 'audit/export');
  expect(calls.length).toBe(2);
  expect(calls[1].body.after).toBe('page2');
  expect(calls[0].body.from).toBe(new Date('2026-09-01T00:00:00').getTime());
});

test('export all data downloads the server\'s JSON as a file', async ({ page }) => {
  await openApp(page, 'admin', { 'data/export': () => ({ body: { format: 'teamsync-export-v1', projects: {}, users: [], attachments: [] } }) });
  await openPanel(page);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#dataExportBtn').click()]);
  expect(dl.suggestedFilename()).toMatch(/^teamsync-export-\d{4}-\d{2}-\d{2}\.json$/);
  expect(JSON.parse(fs.readFileSync(await dl.path(), 'utf8')).format).toBe('teamsync-export-v1');
});

test('scheduling deletion requires the exact phrase, sends the password, and switches to the pending view', async ({ page }) => {
  const executeAt = Date.now() + 7 * 86400000;
  const seen = await openApp(page, 'admin', {
    'data/delete/schedule': (body) => ({ body: { scheduled: { requestedBy: 'testadmin', requestedAt: Date.now(), executeAt } } }),
  });
  await openPanel(page);
  await expect(page.locator('#deletionIdle')).toBeVisible();
  await page.locator('#deletionPassword').fill('pw');
  await page.locator('#deletionPhrase').fill('delete all data');
  await page.locator('#deletionScheduleBtn').click();
  expect(seen.filter((s) => s.path === 'data/delete/schedule').length).toBe(0);
  await page.locator('#deletionPhrase').fill('DELETE ALL DATA');
  await page.locator('#deletionScheduleBtn').click();
  await expect(page.locator('#deletionPending')).toBeVisible();
  const call = seen.find((s) => s.path === 'data/delete/schedule');
  expect(call.body).toMatchObject({ password: 'pw', confirm: 'DELETE ALL DATA' });
  await expect(page.locator('#dataDeletionBanner')).toBeVisible();
  await expect(page.locator('#deletionPassword')).toHaveValue('');
});

test('every user sees the deletion banner while one is pending; cancelling clears it', async ({ page }) => {
  const scheduled = { requestedBy: 'boss', requestedAt: Date.now(), executeAt: Date.now() + 3 * 86400000 };
  await openApp(page, 'admin', {
    'data/delete/status': () => ({ body: { scheduled } }),
    'data/delete/cancel': () => ({ body: { scheduled: null } }),
  });
  await expect(page.locator('#dataDeletionBanner')).toBeVisible();
  await expect(page.locator('#dataDeletionBannerText')).toContainText('requested by boss');
  await openPanel(page);
  await expect(page.locator('#deletionPending')).toBeVisible();
  await page.locator('#deletionCancelBtn').click();
  await expect(page.locator('#dataDeletionBanner')).toBeHidden();
  await expect(page.locator('#deletionIdle')).toBeVisible();
});

test('a non-admin sees the deletion banner too', async ({ page }) => {
  const scheduled = { requestedBy: 'boss', requestedAt: Date.now(), executeAt: Date.now() + 3 * 86400000 };
  await openApp(page, 'viewer', { 'data/delete/status': () => ({ body: { scheduled } }) });
  await expect(page.locator('#dataDeletionBanner')).toBeVisible();
});
