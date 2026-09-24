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
  await expect(page.locator('#loginBannerText')).toContainText('isn’t on a TeamSync account');
  expect(await page.evaluate(() => location.hash)).toBe('');
});

test('password sign-in with an email address still works next to the Google button, and remembers the real username', async ({ page }) => {
  const seen = await mockWorker(page, {
    'sso/config': () => ({ body: { google: true } }),
    '': () => ({ body: { token } }),
  });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('label[for="loginUsername"]')).toHaveText('Username or email');
  await expect(page.locator('#loginGoogleBtn')).toBeVisible();
  await page.fill('#loginUsername', 'bob@outlook.com');
  await page.fill('#loginPassword', 'pw');
  await page.click('#loginSubmit');
  await expect(page.locator('#loginOverlay')).not.toHaveClass(/show/);
  expect(seen.find((s) => s.path === '').body.username).toBe('bob@outlook.com');
  expect(await page.evaluate(() => localStorage.getItem('gantt_username_v1'))).toBe('bob');
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
    'sso/settings': () => ({ body: { settings: { googleEnabled: false, allowedDomains: [] }, configured: false, redirectUri: WORKER_ORIGIN + '/sso/google/callback' } }),
  });
  await page.evaluate(() => { toggleSettingsMenu(); showSettingsTab('admin'); });
  await page.locator('#securityDataBtn').click();
  await expect(page.locator('#ssoNotConfigured')).toBeVisible();
  await expect(page.locator('#ssoRedirectUri')).toHaveText(WORKER_ORIGIN + '/sso/google/callback');
  await expect(page.locator('#ssoConfigured')).toBeHidden();
});

test('Security & data: an admin turns Google sign-in on with a domain', async ({ page }) => {
  const seen = await openAdmin(page, {
    'sso/settings': (b) => ({ body: {
      settings: { googleEnabled: !!(b && b.googleEnabled), allowedDomains: (b && b.allowedDomains) || [], updatedBy: 'testadmin', updatedAt: Date.now() },
      configured: true, redirectUri: WORKER_ORIGIN + '/sso/google/callback' } }),
  });
  await page.evaluate(() => { toggleSettingsMenu(); showSettingsTab('admin'); });
  await page.locator('#securityDataBtn').click();
  await expect(page.locator('#ssoConfigured')).toBeVisible();
  await expect(page.locator('#ssoRequireToggle')).toHaveCount(0);
  await page.locator('#ssoEnabledToggle').check();
  await page.fill('#ssoDomains', 'aps-cut.com, example.org');
  await page.click('#ssoSaveBtn');
  await expect(page.locator('#ssoNote')).toContainText('Last changed by testadmin');
  const saved = seen.filter((s) => s.path === 'sso/settings').pop().body;
  expect(saved).toEqual({ token: expect.any(String), googleEnabled: true, allowedDomains: ['aps-cut.com', 'example.org'] });
});

test('Manage Users: the account email is shown, edited and saved', async ({ page }) => {
  const seen = await openAdmin(page, {
    'users/list': () => ({ body: { users: [
      { username: 'testadmin', displayName: 'Test Admin', role: 'admin', assignedProjectId: null, isLead: false, mfaEnabled: false, email: '' },
      { username: 'bob', displayName: 'Bob', role: 'editor', assignedProjectId: null, isLead: false, mfaEnabled: false, email: 'bob@aps-cut.com' },
    ] } }),
    'users/update': () => ({ body: { success: true } }),
  });
  await page.evaluate(() => openManageUsersModal());
  const bobRow = page.locator('#usersList > div', { hasText: '@bob' });
  await expect(bobRow).toContainText('bob@aps-cut.com');
  await bobRow.locator('[data-action="edit"]').click();
  await expect(page.locator('#userFormEmail')).toHaveValue('bob@aps-cut.com');
  await page.fill('#userFormEmail', 'robert@aps-cut.com');
  await page.click('#userFormSaveBtn');
  await expect.poll(() => seen.filter((s) => s.path === 'users/update').length).toBe(1);
  expect(seen.find((s) => s.path === 'users/update').body).toMatchObject({ targetUsername: 'bob', newEmail: 'robert@aps-cut.com' });
});

// ---- Settings > My email (src/app/account-email.ts) ----

async function openMyEmail(page) {
  await page.evaluate(() => toggleSettingsMenu());
  await page.locator('#myEmailBtn').click();
  await expect(page.locator('#accountEmailModal')).toHaveClass(/show/);
}

test('My email: anyone can add their own email with their password; it shows as not confirmed', async ({ page }) => {
  await seedSession(page, { role: 'viewer', username: 'eve' });
  const seen = await mockWorker(page, {
    'account/me': () => ({ body: { username: 'eve', displayName: 'Eve', email: '', emailConfirmed: false } }),
    'account/email': (b) => b.password === 'pw' ? { body: { email: b.email.toLowerCase(), emailConfirmed: false } } : { status: 403, body: { error: 'Your password is incorrect' } },
    'sso/config': () => ({ body: { google: false } }),
  });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await openMyEmail(page);
  await expect(page.locator('#myEmailStatus')).toHaveText('No email on your account yet.');
  await expect(page.locator('#myEmailGoogle')).toBeHidden();
  await page.fill('#myEmailInput', 'Eve@Yahoo.com');
  await page.fill('#myEmailPassword', 'nope');
  await page.click('#myEmailSaveBtn');
  await expect(page.locator('#myEmailStatus')).toHaveText('No email on your account yet.');
  await page.fill('#myEmailPassword', 'pw');
  await page.click('#myEmailSaveBtn');
  await expect(page.locator('#myEmailStatus')).toContainText('eve@yahoo.com');
  await expect(page.locator('#myEmailStatus .my-email-badge')).toHaveText('Not confirmed');
  await expect(page.locator('#myEmailUnconfirmedNote')).toBeVisible();
  await expect(page.locator('#myEmailPassword')).toHaveValue('');
  expect(seen.filter((s) => s.path === 'account/email').pop().body).toMatchObject({ email: 'Eve@Yahoo.com', password: 'pw' });
});

test('My email: "Connect Google account" gets a ticket and sends the page through the Worker with it', async ({ page }) => {
  await seedSession(page, { role: 'viewer', username: 'eve' });
  const seen = await mockWorker(page, {
    'account/me': () => ({ body: { username: 'eve', displayName: 'Eve', email: 'eve@gmail.com', emailConfirmed: true } }),
    'sso/config': () => ({ body: { google: true } }),
    'sso/link-ticket': () => ({ body: { ticket: 'LINK-1' } }),
    'sso/google/start': () => ({ contentType: 'text/html', body: '<p id="went">at the worker</p>' }),
  });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await openMyEmail(page);
  await expect(page.locator('#myEmailStatus .my-email-badge')).toHaveText('Confirmed');
  await expect(page.locator('#myEmailUnconfirmedNote')).toBeHidden();
  await expect(page.locator('#myEmailGoogleBtn')).toBeVisible();
  await page.click('#myEmailGoogleBtn');
  await expect(page.locator('#went')).toBeVisible();
  const start = new URL(seen.find((s) => s.path === 'sso/google/start').url);
  expect(start.searchParams.get('link')).toBe('LINK-1');
  expect(start.searchParams.get('return')).toBe(APP_URL);
});

test('coming back from "Connect Google account" while signed in shows how it went, without the sign-in screen', async ({ page }) => {
  await seedSession(page, { role: 'viewer', username: 'eve' });
  await mockWorker(page, {});
  await mockRoomWebSocket(page);
  await page.goto(APP_URL + '#sso_linked=eve%40gmail.com');
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await expect(page.locator('#loginOverlay')).not.toHaveClass(/show/);
  await expect(page.locator('.toast', { hasText: 'eve@gmail.com is confirmed' })).toBeVisible();
  expect(await page.evaluate(() => location.hash)).toBe('');

  // Only the #fragment differs, which wouldn't reload the page by itself.
  await page.evaluate(() => { location.hash = 'sso_error=email_taken'; location.reload(); });
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await expect(page.locator('.toast', { hasText: 'already confirmed on another' })).toBeVisible();
  await expect(page.locator('#loginOverlay')).not.toHaveClass(/show/);
});

test('Google sign-in with an unconfirmed email explains how to confirm it', async ({ page }) => {
  await mockWorker(page, { 'sso/config': () => ({ body: { google: true } }) });
  await page.goto(APP_URL + '#sso_error=unconfirmed');
  await expect(page.locator('#loginBannerText')).toContainText('Settings → My email → Connect Google account');
});

test('Manage Users marks self-added emails as not confirmed', async ({ page }) => {
  await openAdmin(page, {
    'users/list': () => ({ body: { users: [
      { username: 'testadmin', displayName: 'Test Admin', role: 'admin', assignedProjectId: null, isLead: false, mfaEnabled: false, email: 'admin@aps-cut.com', emailConfirmed: true },
      { username: 'eve', displayName: 'Eve', role: 'editor', assignedProjectId: null, isLead: false, mfaEnabled: false, email: 'eve@yahoo.com', emailConfirmed: false },
    ] } }),
  });
  await page.evaluate(() => openManageUsersModal());
  await expect(page.locator('#usersList > div', { hasText: '@eve' })).toContainText('eve@yahoo.com (not confirmed)');
  await expect(page.locator('#usersList > div', { hasText: '@testadmin' })).not.toContainText('not confirmed');
});
