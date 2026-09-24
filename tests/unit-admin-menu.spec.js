const { test, expect } = require('@playwright/test');
const { APP_URL, WORKER_ORIGIN, seedSession, mockRoomWebSocket } = require('./helpers');

// Settings' Admin tab (src/app/settings-menu.ts) and its badge
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

test('admin items sit behind the Admin tab in Settings', async ({ page }) => {
  await openApp(page, 'admin');
  await page.locator('#desktopSettingsBtn').click();
  await expect(page.locator('#settingsTabGeneral')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#manageUsersBtn')).toBeHidden();
  await expect(page.locator('#changePasswordBtn')).toBeVisible();
  await page.locator('#settingsTabAdmin').click();
  await expect(page.locator('#settingsDropdown')).toHaveClass(/show/);
  await expect(page.locator('#manageUsersBtn')).toBeVisible();
  await expect(page.locator('#errorsBtn')).toBeVisible();
  await expect(page.locator('#changePasswordBtn')).toBeHidden();
  // Reopening starts back on the Settings tab.
  await page.keyboard.press('Escape');
  await page.locator('#desktopSettingsBtn').click();
  await expect(page.locator('#changePasswordBtn')).toBeVisible();
});

test('non-admins see no tabs, just their settings', async ({ page }) => {
  await openApp(page, 'editor');
  await page.locator('#desktopSettingsBtn').click();
  await expect(page.locator('#settingsTabAdmin')).toBeHidden();
  await expect(page.locator('#changePasswordBtn')).toBeVisible();
});

test('new account events and errors badge the Settings button, and opening the Admin tab clears it', async ({ page }) => {
  const seen = await openApp(page, 'admin', { 'admin/notices': () => NOTICES, 'admin/notices/seen': () => ({ success: true }) });
  const badge = page.locator('#desktopSettingsBtn .admin-badge');
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText('2');
  await page.locator('#desktopSettingsBtn').click();
  await expect(page.locator('#settingsTabAdmin .admin-badge')).toHaveText('2');
  await page.locator('#settingsTabAdmin').click();
  await expect(page.locator('#errorsNewCount')).toHaveText('1');
  await expect(badge).toBeHidden();
  await expect(page.locator('#settingsTabAdmin .admin-badge')).toBeHidden();
  await expect.poll(() => seen.find((s) => s.path === 'admin/notices/seen')?.body?.at).toBe(NOTICES.items[0].at);
});
