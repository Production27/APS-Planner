const { test, expect } = require('@playwright/test');
const { APP_URL, WORKER_ORIGIN, fakeSessionToken, seedSession, mockRoomWebSocket } = require('./helpers');

// "Sign in with Google" in the app (src/auth/login.ts, src/app/sso-settings.ts)
// against mocked Worker endpoints. The server side, including the Google
// token checks, is tested in worker/src/sso.test.mjs.

async function mockWorker(page, routes) {
  const seen = [];
  await page.route(WORKER_ORIGIN + '/**', (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname.includes('/room')) return route.abort();
    const path = url.pathname.slice(1);
    let body = null;
    try { body = req.postDataJSON(); } catch (e) { /* GET */ }
    seen.push({ path, body, url: req.url() });
    const handler = routes[path];
    if (!handler) return route.fulfill({ status: 200, contentType: 'application/json', body: path === 'data/delete/status' ? '{"scheduled":null}' : '{}' });
    const out = handler(body, url);
    return route.fulfill({ status: out.status || 200, contentType: out.contentType || 'application/json', body: typeof out.body === 'string' ? out.body : JSON.stringify(out.body || {}) });
  });
  return seen;
}
const token = fakeSessionToken({ username: 'bob', displayName: 'Bob', role: 'editor' });

test('the Google button only shows when an admin has turned it on', async ({ page }) => {
  await mockWorker(page, { 'sso/config': () => ({ body: { google: false } }) });
  await page.goto(APP_URL);
  await expect(page.locator('#loginOverlay')).toHaveClass(/show/);
  await expect(page.locator('#loginForm')).toBeVisible();
  await expect(page.locator('#loginSso')).toBeHidden();
});

test('clicking "Sign in with Google" sends the page to the Worker with this page as the return address', async ({ page }) => {
  const seen = await mockWorker(page, {
    'sso/config': () => ({ body: { google: true } }),
    'sso/google/start': () => ({ contentType: 'text/html', body: '<p id="went">at the worker</p>' }),
  });
  await page.goto(APP_URL);
  await expect(page.locator('#loginGoogleBtn')).toBeVisible();
  await page.click('#loginGoogleBtn');
  await expect(page.locator('#went')).toBeVisible();
  const start = new URL(seen.find((s) => s.path === 'sso/google/start').url);
  expect(start.searchParams.get('return')).toBe(APP_URL);
});

test('coming back from Google with a one-time code signs in without showing the sign-in screen, and clears the code from the address', async ({ page }) => {
  const seen = await mockWorker(page, {
    'sso/redeem': (b) => b.code === 'ONE-TIME' ? { body: { token, user: { username: 'bob' } } } : { status: 401, body: { error: 'expired' } },
  });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL + '#sso_code=ONE-TIME');
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await expect(page.locator('#loginOverlay')).not.toHaveClass(/show/);
  expect(await page.evaluate(() => localStorage.getItem('gantt_session_token_v1'))).toBe(token);
  expect(await page.evaluate(() => localStorage.getItem('gantt_username_v1'))).toBe('bob');
  expect(await page.evaluate(() => location.hash)).toBe('');
  expect(seen.filter((s) => s.path === 'sso/redeem').length).toBe(1);
});

test('coming back with an error explains it on the sign-in screen', async ({ page }) => {
  await mockWorker(page, { 'sso/config': () => ({ body: { google: true } }) });
  await page.goto(APP_URL + '#sso_error=no_account');
  await expect(page.locator('#loginOverlay')).toHaveClass(/show/);
  await expect(page.locator('#loginBannerText')).toContainText('isn’t linked to a TeamSync account');
  expect(await page.evaluate(() => location.hash)).toBe('');
});

test('"Google only": a password sign-in is refused with a message pointing at the Google button', async ({ page }) => {
  await mockWorker(page, {
    'sso/config': () => ({ body: { google: true, requireGoogle: true } }),
    '': () => ({ status: 403, body: { error: 'Your company signs in with Google — use "Sign in with Google".', useSso: true } }),
  });
  await page.goto(APP_URL);
  await page.fill('#loginUsername', 'bob');
  await page.fill('#loginPassword', 'pw');
  await page.click('#loginSubmit');
  await expect(page.locator('#loginBannerText')).toContainText('signs in with Google');
  await expect(page.locator('#loginUsername')).toHaveValue('bob');
  await expect(page.locator('#loginPassword')).toHaveValue('');
  await expect(page.locator('#loginGoogleBtn')).toBeVisible();
});

async function openAdmin(page, routes) {
  await seedSession(page, { role: 'admin' });
  const seen = await mockWorker(page, routes);
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  return seen;
}

test('Security & data: before the server has a Google key, it shows the redirect address to register', async ({ page }) => {
  await openAdmin(page, {
    'sso/settings': () => ({ body: { settings: { googleEnabled: false, allowedDomains: [], requireGoogle: false }, configured: false, redirectUri: WORKER_ORIGIN + '/sso/google/callback' } }),
  });
  await page.evaluate(() => toggleSettingsMenu());
  await page.locator('#securityDataBtn').click();
  await expect(page.locator('#ssoNotConfigured')).toBeVisible();
  await expect(page.locator('#ssoRedirectUri')).toHaveText(WORKER_ORIGIN + '/sso/google/callback');
  await expect(page.locator('#ssoConfigured')).toBeHidden();
});

test('Security & data: an admin turns Google sign-in on with a domain and "Google only"', async ({ page }) => {
  const seen = await openAdmin(page, {
    'sso/settings': (b) => ({ body: {
      settings: { googleEnabled: !!(b && b.googleEnabled), allowedDomains: (b && b.allowedDomains) || [], requireGoogle: !!(b && b.requireGoogle), updatedBy: 'testadmin', updatedAt: Date.now() },
      configured: true, redirectUri: WORKER_ORIGIN + '/sso/google/callback' } }),
  });
  page.on('dialog', (d) => d.accept());
  await page.evaluate(() => toggleSettingsMenu());
  await page.locator('#securityDataBtn').click();
  await expect(page.locator('#ssoConfigured')).toBeVisible();
  await page.locator('#ssoEnabledToggle').check();
  await page.fill('#ssoDomains', 'aps-cut.com, example.org');
  await page.locator('#ssoRequireToggle').check();
  await page.click('#ssoSaveBtn');
  await expect(page.locator('#ssoNote')).toContainText('Last changed by testadmin');
  const saved = seen.filter((s) => s.path === 'sso/settings').pop().body;
  expect(saved).toMatchObject({ googleEnabled: true, requireGoogle: true, allowedDomains: ['aps-cut.com', 'example.org'] });
});

test('Manage Users: the Google email is shown, edited and saved', async ({ page }) => {
  const seen = await openAdmin(page, {
    'users/list': () => ({ body: { users: [
      { username: 'testadmin', displayName: 'Test Admin', role: 'admin', assignedProjectId: null, isLead: false, mfaEnabled: false, googleEmail: '' },
      { username: 'bob', displayName: 'Bob', role: 'editor', assignedProjectId: null, isLead: false, mfaEnabled: false, googleEmail: 'bob@aps-cut.com' },
    ] } }),
    'users/update': () => ({ body: { success: true } }),
  });
  await page.evaluate(() => openManageUsersModal());
  const bobRow = page.locator('#usersList > div', { hasText: '@bob' });
  await expect(bobRow).toContainText('Google: bob@aps-cut.com');
  await bobRow.locator('[data-action="edit"]').click();
  await expect(page.locator('#userFormGoogleEmail')).toHaveValue('bob@aps-cut.com');
  await page.fill('#userFormGoogleEmail', 'robert@aps-cut.com');
  await page.click('#userFormSaveBtn');
  await expect.poll(() => seen.filter((s) => s.path === 'users/update').length).toBe(1);
  expect(seen.find((s) => s.path === 'users/update').body).toMatchObject({ targetUsername: 'bob', newGoogleEmail: 'robert@aps-cut.com' });
});
