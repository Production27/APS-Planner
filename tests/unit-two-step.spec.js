const { test, expect } = require('@playwright/test');
const { APP_URL, WORKER_ORIGIN, fakeSessionToken, seedSession, mockRoomWebSocket } = require('./helpers');

// Two-step verification in the app: the extra sign-in steps
// (src/auth/login.ts), Settings > Two-step verification
// (src/app/two-step.ts) and the admin controls, against mocked Worker
// endpoints. The server side is tested in worker/src/mfa.test.mjs.

// Routes every Worker call to `routes[path]` (path without the leading
// slash; '' is the sign-in endpoint) and records what was sent.
async function mockWorker(page, routes) {
  const seen = [];
  await page.route(WORKER_ORIGIN + '/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.includes('/room')) return route.abort();
    const path = url.pathname.slice(1);
    let body = null;
    try { body = route.request().postDataJSON(); } catch (e) { /* not JSON */ }
    seen.push({ path, body });
    const handler = routes[path];
    if (!handler) return route.fulfill({ status: 200, contentType: 'application/json', body: path === 'data/delete/status' ? '{"scheduled":null}' : '{}' });
    const out = handler(body);
    return route.fulfill({ status: out.status || 200, contentType: 'application/json', body: JSON.stringify(out.body || {}) });
  });
  return seen;
}

const token = fakeSessionToken({ username: 'realuser', displayName: 'Real User', role: 'admin' });
const URI = 'otpauth://totp/TeamSync%3Arealuser?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=TeamSync&algorithm=SHA1&digits=6&period=30';
const CODES = ['abcde-fghjk', 'mnpqr-stuvw', 'xyz23-45678', 'aaaaa-bbbbb', 'ccccc-ddddd', 'eeeee-fffff', 'ggggg-hhhhh', 'jjjjj-kkkkk', 'mmmmm-nnnnn', 'ppppp-qqqqq'];

async function submitPassword(page) {
  await expect(page.locator('#loginOverlay')).toHaveClass(/show/);
  await page.fill('#loginUsername', 'realuser');
  await page.fill('#loginPassword', 'pw');
  await page.click('#loginSubmit');
}

test('sign-in asks for the code when two-step is on; a wrong code shows the error, the right one signs in', async ({ page }) => {
  const seen = await mockWorker(page, {
    '': () => ({ body: { mfaRequired: true, ticket: 'T1' } }),
    'auth/mfa': (b) => b.code === '123456' ? { body: { token } } : { status: 401, body: { error: 'That code didn\'t work — check your authenticator app and try again.' } },
  });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await submitPassword(page);

  await expect(page.locator('#loginMfaForm')).toBeVisible();
  await expect(page.locator('#loginForm')).toBeHidden();
  await expect(page.locator('#loginForgot')).toBeHidden();
  await page.fill('#loginCode', '000000');
  await page.click('#loginCodeSubmit');
  await expect(page.locator('#loginBannerText')).toContainText('didn\'t work');
  await expect(page.locator('#loginCode')).toHaveValue('');
  await page.fill('#loginCode', '123456');
  await page.click('#loginCodeSubmit');
  await expect(page.locator('#loginOverlay')).not.toHaveClass(/show/);
  expect(await page.evaluate(() => localStorage.getItem('gantt_session_token_v1'))).toBe(token);
  expect(seen.filter((s) => s.path === 'auth/mfa').map((s) => s.body)).toEqual([{ ticket: 'T1', code: '000000' }, { ticket: 'T1', code: '123456' }]);
});

test('"Back to sign in" and an expired ticket both return to the password form', async ({ page }) => {
  let n = 0;
  await mockWorker(page, {
    '': () => { n++; return { body: n < 3 ? { mfaRequired: true, ticket: 'T' + n } : { token } }; },
    'auth/mfa': () => ({ status: 401, body: { error: 'Your sign-in timed out — enter your password again.', restart: true } }),
  });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await submitPassword(page);
  await page.click('#loginMfaBack');
  await expect(page.locator('#loginForm')).toBeVisible();
  await expect(page.locator('#loginPassword')).toHaveValue('');

  await page.fill('#loginPassword', 'pw');
  await page.click('#loginSubmit');
  await page.fill('#loginCode', '123456');
  await page.click('#loginCodeSubmit');
  await expect(page.locator('#loginForm')).toBeVisible();
  await expect(page.locator('#loginBannerText')).toContainText('timed out');

  await page.fill('#loginPassword', 'pw');
  await page.click('#loginSubmit');
  await expect(page.locator('#loginOverlay')).not.toHaveClass(/show/);
});

test('when the company requires it, sign-in walks through setup and shows the recovery codes once', async ({ page }) => {
  const seen = await mockWorker(page, {
    '': () => ({ body: { mfaSetupRequired: true, ticket: 'S1' } }),
    'mfa/setup': () => ({ body: { secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', uri: URI } }),
    'mfa/enable': (b) => b.code === '654321' ? { body: { token, recoveryCodes: CODES } } : { status: 400, body: { error: 'That code didn\'t match' } },
  });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await submitPassword(page);

  await expect(page.locator('#loginMfaSetupForm')).toBeVisible();
  await expect(page.locator('#loginMfaQr svg')).toBeVisible();
  await expect(page.locator('#loginMfaSecret')).toHaveText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP');
  await page.fill('#loginSetupCode', '654 321');
  await page.click('#loginSetupSubmit');

  await expect(page.locator('#loginRecoveryForm')).toBeVisible();
  await expect(page.locator('#loginRecoveryCodes li')).toHaveCount(10);
  await expect(page.locator('#loginOverlay')).toHaveClass(/show/);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#loginRecoveryCodes [data-act="download"]').click()]);
  expect(dl.suggestedFilename()).toBe('teamsync-recovery-codes.txt');
  await page.click('#loginRecoveryDone');
  await expect(page.locator('#loginOverlay')).not.toHaveClass(/show/);
  await expect(page.locator('#loginRecoveryCodes')).toBeEmpty();
  expect(seen.find((s) => s.path === 'mfa/enable').body).toEqual({ ticket: 'S1', code: '654321' });
});

async function openSignedIn(page, routes, role) {
  await seedSession(page, { role: role || 'admin' });
  const seen = await mockWorker(page, routes);
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  return seen;
}

test('Settings > Two-step verification: set up with password and code, then see the recovery codes', async ({ page }) => {
  const seen = await openSignedIn(page, {
    'mfa/status': () => ({ body: { enabled: false, enabledAt: null, recoveryCodesLeft: 0, required: false } }),
    'mfa/setup': (b) => b.password === 'pw' ? { body: { secret: 'JBSWY3DPEHPK3PXP', uri: URI } } : { status: 403, body: { error: 'Incorrect password' } },
    'mfa/enable': () => ({ body: { recoveryCodes: CODES } }),
  }, 'viewer');
  await page.evaluate(() => toggleSettingsMenu());
  await page.locator('#twoStepBtn').click();
  await expect(page.locator('#mfaOff')).toBeVisible();
  await page.fill('#mfaSetupPassword', 'nope');
  await page.click('#mfaStartBtn');
  await expect(page.locator('#mfaOff')).toBeVisible();
  await page.fill('#mfaSetupPassword', 'pw');
  await page.click('#mfaStartBtn');
  await expect(page.locator('#mfaSetup')).toBeVisible();
  await expect(page.locator('#mfaQr svg')).toBeVisible();
  await expect(page.locator('#mfaSetupPassword')).toHaveValue('');
  await page.fill('#mfaSetupCode', '111222');
  await page.click('#mfaEnableBtn');
  await expect(page.locator('#mfaCodes')).toBeVisible();
  await expect(page.locator('#mfaCodesList li')).toHaveCount(10);
  expect(seen.find((s) => s.path === 'mfa/enable').body.code).toBe('111222');
  await page.click('#mfaCloseBtn');
  await expect(page.locator('#mfaCodesList')).toBeEmpty();
});

test('Settings > Two-step verification when on: new recovery codes, and turning it off', async ({ page }) => {
  const seen = await openSignedIn(page, {
    'mfa/status': () => ({ body: { enabled: true, enabledAt: Date.UTC(2026, 8, 1), recoveryCodesLeft: 2, required: false } }),
    'mfa/recovery-codes': () => ({ body: { recoveryCodes: CODES } }),
    'mfa/disable': () => ({ body: { success: true } }),
  });
  await page.evaluate(() => toggleSettingsMenu());
  await page.locator('#twoStepBtn').click();
  await expect(page.locator('#mfaOn')).toBeVisible();
  await expect(page.locator('#mfaCodesLeft')).toHaveText('2');
  await expect(page.locator('#mfaCodesLeftWarn')).toBeVisible();
  await expect(page.locator('#mfaDisableBtn')).toBeVisible();
  await page.fill('#mfaManageCode', '123456');
  await page.click('#mfaNewCodesBtn');
  await expect(page.locator('#mfaCodes')).toBeVisible();

  await page.click('#mfaCloseBtn');
  await page.evaluate(() => toggleSettingsMenu());
  await page.locator('#twoStepBtn').click();
  await page.fill('#mfaManageCode', '654321');
  await page.fill('#mfaDisablePassword', 'pw');
  await page.click('#mfaDisableBtn');
  await expect(page.locator('#mfaOff')).toBeVisible();
  expect(seen.find((s) => s.path === 'mfa/disable').body).toMatchObject({ code: '654321', password: 'pw' });
});

test('when the company requires it, the settings screen has no way to turn it off', async ({ page }) => {
  await openSignedIn(page, { 'mfa/status': () => ({ body: { enabled: true, enabledAt: Date.now(), recoveryCodesLeft: 10, required: true } }) });
  await page.evaluate(() => toggleSettingsMenu());
  await page.locator('#twoStepBtn').click();
  await expect(page.locator('#mfaRequiredNote')).toBeVisible();
  await expect(page.locator('#mfaDisableBtn')).toBeHidden();
  await expect(page.locator('#mfaDisableGroup')).toBeHidden();
  await expect(page.locator('#mfaCodesLeftWarn')).toBeHidden();
});

test('Security & data: an admin can require two-step verification for everyone', async ({ page }) => {
  const seen = await openSignedIn(page, {
    'security/policy': (b) => ({ body: { policy: { requireMfa: b.requireMfa === true, updatedBy: b.requireMfa === undefined ? undefined : 'realuser', updatedAt: Date.now() } } }),
  });
  page.on('dialog', (d) => d.accept());
  await page.evaluate(() => { toggleSettingsMenu(); showSettingsTab('admin'); });
  await page.locator('#securityDataBtn').click();
  await expect(page.locator('#requireMfaToggle')).toBeEnabled();
  await expect(page.locator('#requireMfaToggle')).not.toBeChecked();
  await page.locator('#requireMfaToggle').check();
  await expect(page.locator('#requireMfaNote')).toContainText('Last changed by realuser');
  await expect(page.locator('#requireMfaToggle')).toBeChecked();
  expect(seen.filter((s) => s.path === 'security/policy').map((s) => s.body.requireMfa)).toEqual([undefined, true]);
});

test('Manage Users shows who has two-step on and lets an admin reset it', async ({ page }) => {
  const seen = await openSignedIn(page, {
    'users/list': () => ({ body: { users: [
      { username: 'testadmin', displayName: 'Test Admin', role: 'admin', assignedProjectId: null, isLead: false, mfaEnabled: false },
      { username: 'bob', displayName: 'Bob', role: 'editor', assignedProjectId: null, isLead: false, mfaEnabled: true },
    ] } }),
  });
  page.on('dialog', (d) => d.accept());
  await page.evaluate(() => openManageUsersModal());
  const bobRow = page.locator('#usersList > div', { hasText: '@bob' });
  await expect(bobRow).toContainText('2-step on');
  await expect(page.locator('#usersList [data-action="resetmfa"]')).toHaveCount(1);
  await bobRow.locator('[data-action="resetmfa"]').click();
  await expect.poll(() => seen.filter((s) => s.path === 'users/reset-mfa').length).toBe(1);
  expect(seen.find((s) => s.path === 'users/reset-mfa').body.targetUsername).toBe('bob');
});

test('Change My Password asks for the current password and keeps this session going', async ({ page }) => {
  const fresh = fakeSessionToken({ username: 'testadmin', displayName: 'Test Admin', role: 'admin', ttlMs: 2 * 60 * 60 * 1000 });
  const seen = await openSignedIn(page, { 'users/reset-password': () => ({ body: { success: true, token: fresh } }) });
  const answers = ['old-pw', 'new-password'];
  page.on('dialog', (d) => d.accept(answers.shift()));
  await page.evaluate(() => changeMyPasswordUI());
  await expect.poll(() => page.evaluate(() => localStorage.getItem('gantt_session_token_v1'))).toBe(fresh);
  expect(seen.find((s) => s.path === 'users/reset-password').body).toMatchObject({ targetUsername: 'testadmin', currentPassword: 'old-pw', newPassword: 'new-password' });
});
