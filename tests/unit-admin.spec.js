const { test, expect } = require('@playwright/test');
const { APP_URL, WORKER_ORIGIN, seedSession, mockRoomWebSocket } = require('./helpers');

// Backups, error log, and Manage Users (src/app/backups.ts, errors.ts,
// users-admin.ts) — all previously untested despite covering
// destructive/security-adjacent actions (backup restore, password reset,
// user removal). These tests lock in real behavior before/alongside that
// extraction, per the extraction plan's explicit requirement for this phase.

test('loadBackupsList: renders each backup row with its date, and marks pre-restore-safety snapshots distinctly', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.route(WORKER_ORIGIN + '/list-backups', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      backups: [
        { key: 'backups/2026-09-10T00-00-00.json', date: '2026-09-10 12:00 AM' },
        { key: 'backups/pre-restore-safety-2026-09-09.json', date: '2026-09-09 11:00 PM' },
      ],
    }) });
  });
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  await page.evaluate(() => openBackupsModal());
  await expect(page.locator('#backupsListStatus')).toHaveText('2 backup(s) — most recent first');
  const rows = page.locator('#backupsList > div');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('2026-09-10 12:00 AM');
  await expect(rows.nth(1)).toContainText('Safety snapshot');
});

test('triggerBackupNow: posts to trigger-backup and refreshes the list', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  let triggered = false;
  await page.route(WORKER_ORIGIN + '/trigger-backup', (route) => {
    triggered = true;
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.route(WORKER_ORIGIN + '/list-backups', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ backups: [] }) });
  });
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  await page.evaluate(() => triggerBackupNow());
  await expect.poll(() => triggered).toBe(true);
  await expect(page.locator('#backupsListStatus')).toHaveText('0 backup(s) — most recent first');
});

test('restoreBackupFile: declining the initial confirm cancels without calling the Worker', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  let restoreCalled = false;
  await page.route(WORKER_ORIGIN + '/restore-backup', (route) => {
    restoreCalled = true;
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  page.once('dialog', (d) => d.dismiss());
  await page.evaluate(() => restoreBackupFile('backups/x.json', 'yesterday'));
  await page.waitForTimeout(200);
  expect(restoreCalled).toBe(false);
});

test('restoreBackupFile: accepting the confirm but typing the wrong word into the prompt still cancels', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  let restoreCalled = false;
  await page.route(WORKER_ORIGIN + '/restore-backup', (route) => {
    restoreCalled = true;
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  page.on('dialog', (d) => { d.type() === 'confirm' ? d.accept() : d.accept('restore'); }); // lowercase — must not match
  await page.evaluate(() => restoreBackupFile('backups/x.json', 'yesterday'));
  await page.waitForTimeout(200);
  expect(restoreCalled).toBe(false);
});

test('restoreBackupFile: confirm accepted + RESTORE typed exactly sends the confirmed restore request', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  let capturedBody = null;
  await page.route(WORKER_ORIGIN + '/restore-backup', (route) => {
    capturedBody = route.request().postDataJSON();
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  page.on('dialog', (d) => { d.type() === 'confirm' ? d.accept() : d.accept('RESTORE'); });
  await page.evaluate(() => restoreBackupFile('backups/x.json', 'yesterday'));
  await expect.poll(() => capturedBody).not.toBeNull();
  expect(capturedBody.key).toBe('backups/x.json');
  expect(capturedBody.confirm).toBe('RESTORE');
});

test('loadErrorsList: renders reported errors with who/where, most recent first as returned', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.route(WORKER_ORIGIN + '/errors/list', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      errors: [
        { receivedAt: Date.now(), username: 'alice', role: 'editor', kind: 'error', message: 'Something broke', source: 'app.bundle.js', line: 42 },
      ],
    }) });
  });
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  await page.evaluate(() => openErrorsModal());
  await expect(page.locator('#errorsListStatus')).toHaveText('1 report(s) — most recent first');
  await expect(page.locator('#errorsList')).toContainText('alice (editor)');
  await expect(page.locator('#errorsList')).toContainText('Something broke');
  await expect(page.locator('#errorsList')).toContainText('app.bundle.js:42');
});

test('loadUsersList: renders accounts, hides the "View as" button on your own row, and labels tiers/project', async ({ page }) => {
  await seedSession(page, { username: 'testadmin', role: 'admin' });
  await mockRoomWebSocket(page);
  await page.route(WORKER_ORIGIN + '/users/list', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      users: [
        { username: 'testadmin', displayName: 'Test Admin', role: 'admin', assignedProjectId: null, isLead: false },
        { username: 'bob', displayName: 'Bob Builder', role: 'editor', assignedProjectId: null, isLead: true },
      ],
    }) });
  });
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  await page.evaluate(() => openManageUsersModal());
  await expect(page.locator('#usersListStatus')).toHaveText('2 user(s)');
  const rows = page.locator('#usersList > div');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('(you)');
  await expect(rows.nth(0).locator('[data-action="viewas"]')).toHaveCount(0);
  await expect(rows.nth(1)).toContainText('Editor');
  await expect(rows.nth(1)).toContainText('Lead');
  await expect(rows.nth(1).locator('[data-action="viewas"]')).toHaveText('View as');
});

test('submitUserForm: rejects a missing username or a too-short password before calling the Worker', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  let addCalled = false;
  await page.route(WORKER_ORIGIN + '/users/add', (route) => {
    addCalled = true;
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.route(WORKER_ORIGIN + '/users/list', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ users: [] }) });
  });
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  await page.evaluate(() => { openManageUsersModal(); showAddUserForm(); });
  await page.evaluate(() => submitUserForm());
  await expect(page.locator('#userFormHint')).toHaveText('Username is required.');
  expect(addCalled).toBe(false);

  await page.locator('#userFormUsername').fill('newguy');
  await page.locator('#userFormPassword').fill('short');
  await page.evaluate(() => submitUserForm());
  await expect(page.locator('#userFormHint')).toHaveText('Password must be at least 6 characters.');
  expect(addCalled).toBe(false);
});

test('submitUserForm: a valid new-user submission posts to users/add and refreshes the list', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  let capturedBody = null;
  await page.route(WORKER_ORIGIN + '/users/add', (route) => {
    capturedBody = route.request().postDataJSON();
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.route(WORKER_ORIGIN + '/users/list', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ users: [] }) });
  });
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  await page.evaluate(() => { openManageUsersModal(); showAddUserForm(); });
  await page.locator('#userFormUsername').fill('newguy');
  await page.locator('#userFormPassword').fill('longenough');
  await page.locator('#userFormDisplayName').fill('New Guy');
  await page.evaluate(() => submitUserForm());

  await expect.poll(() => capturedBody).not.toBeNull();
  expect(capturedBody.newUsername).toBe('newguy');
  expect(capturedBody.newPassword).toBe('longenough');
  expect(capturedBody.newDisplayName).toBe('New Guy');
  await expect(page.locator('#userFormPanel')).not.toBeVisible();
});

test('resetUserPasswordUI: an empty prompt cancels, a filled one resets the target account\'s password', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  let capturedBody = null;
  await page.route(WORKER_ORIGIN + '/users/reset-password', (route) => {
    capturedBody = route.request().postDataJSON();
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  page.once('dialog', (d) => d.accept('')); // empty string — cancelled
  await page.evaluate(() => resetUserPasswordUI('bob', 'Bob Builder'));
  await page.waitForTimeout(200);
  expect(capturedBody).toBeNull();

  page.once('dialog', (d) => d.accept('newpassword123'));
  await page.evaluate(() => resetUserPasswordUI('bob', 'Bob Builder'));
  await expect.poll(() => capturedBody).not.toBeNull();
  expect(capturedBody.targetUsername).toBe('bob');
  expect(capturedBody.newPassword).toBe('newpassword123');
});

test('removeUserUI: declining the confirm leaves the account intact; accepting removes it and clears the roster cache', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  let removeCalled = false;
  await page.route(WORKER_ORIGIN + '/users/remove', (route) => {
    removeCalled = true;
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.route(WORKER_ORIGIN + '/users/list', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ users: [] }) });
  });
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  page.once('dialog', (d) => d.dismiss());
  await page.evaluate(() => removeUserUI('bob', 'Bob Builder'));
  await page.waitForTimeout(200);
  expect(removeCalled).toBe(false);

  await page.evaluate(() => { cachedUserRoster = [{ username: 'bob', displayName: 'Bob Builder' }]; });
  page.once('dialog', (d) => d.accept());
  await page.evaluate(() => removeUserUI('bob', 'Bob Builder'));
  await expect.poll(() => removeCalled).toBe(true);
  const rosterAfter = await page.evaluate(() => cachedUserRoster);
  expect(rosterAfter).toBeNull();
});
