const { test, expect } = require('@playwright/test');
const { APP_URL, WORKER_ORIGIN, seedSession, mockRoomWebSocket } = require('./helpers');

// The Admin menu (src/app/settings-menu.ts) and its "What's new" badge
// (src/app/admin-notices.ts), against mocked Worker endpoints.

async function openApp(page, role, routes) {
  await seedSession(page, { role: role || 'admin' });
  const seen = [];
  await page.route(WORKER_ORIGIN + '/**', (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.slice(1);
    const body = (() => { try { return route.request().postDataJSON(); } catch (e) { return null; } })();
    seen.push({ path, body });
    if (url.pathname.includes('/room')) return route.abort();
    const handler = routes && routes[path];
    if (!handler) return route.fulfill({ status: 200, contentType: 'application/json', body: path === 'data/delete/status' ? '{"scheduled":null}' : '{}' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(handler(body)) });
  });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  return seen;
}

const NOTICES = {
  items: [
    { at: Date.now() - 60000, kind: 'account', user: 'bob', action: 'Changed own email', details: 'none -> bob@example.com' },
    { at: Date.now() - 120000, kind: 'error', user: 'carl', action: 'App error', details: 'boom' },
    { at: Date.now() - 86400000 * 3, kind: 'account', user: 'dana', action: 'Added user account', item: 'erin' },
  ],
  unread: 2,
  seenAt: Date.now() - 86400000,
};

test('admin items live in the Admin menu, not Settings', async ({ page }) => {
  await openApp(page, 'admin');
  await page.evaluate(() => toggleSettingsMenu());
  await expect(page.locator('#settingsDropdown #manageUsersBtn')).toHaveCount(0);
  await expect(page.locator('#settingsDropdown #errorsBtn')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.locator('#desktopAdminBtn').click();
  await expect(page.locator('#adminDropdown')).toHaveClass(/show/);
  await expect(page.locator('#adminDropdown #errorsBtn')).toBeVisible();
  await expect(page.locator('#adminDropdown #manageUsersBtn')).toBeVisible();
  // Only one of the two menus is open at a time.
  await page.evaluate(() => toggleSettingsMenu());
  await expect(page.locator('#settingsDropdown')).toHaveClass(/show/);
  await expect(page.locator('#adminDropdown')).not.toHaveClass(/show/);
});

test('the Admin button is hidden from non-admins', async ({ page }) => {
  await openApp(page, 'editor');
  await expect(page.locator('#desktopAdminBtn')).toBeHidden();
});

test('new account events and errors show a badge, which clears when the menu is opened', async ({ page }) => {
  const seen = await openApp(page, 'admin', { 'admin/notices': () => NOTICES, 'admin/notices/seen': () => ({ success: true }) });
  const badge = page.locator('#desktopAdminBtn .admin-badge');
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText('2');
  await page.locator('#desktopAdminBtn').click();
  await expect(page.locator('#adminNoticesList .admin-notice')).toHaveCount(3);
  await expect(page.locator('#adminNoticesList .admin-notice.is-new')).toHaveCount(2);
  await expect(page.locator('#adminNoticesList')).toContainText('bob changed their email');
  await expect(page.locator('#adminNoticesList')).toContainText('bob@example.com');
  await expect(badge).toBeHidden();
  await expect.poll(() => seen.find((s) => s.path === 'admin/notices/seen')?.body?.at).toBe(NOTICES.items[0].at);
});
