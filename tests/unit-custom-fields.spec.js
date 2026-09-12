const { test, expect } = require('@playwright/test');
const { APP_URL, WORKER_ORIGIN, seedSession, mockRoomWebSocket } = require('./helpers');

// Custom fields (renderFieldDefHtml/renderCustomFieldsGrid/renderTeamFieldsGrid/
// collectCustomFieldValues) and attachments (renderAttachmentPanel and
// friends) — moved from index.html to src/views/board.ts in Phase 6 of the
// extraction plan, resolving the Board-modal/Job-Manager shared-infra
// tangle. This generic rendering/upload machinery had no direct test
// coverage before (only the card modal's due-date/title fields were
// tested) despite Job Manager's own mirrored grids and attachment panel
// depending on the exact same functions.

test('renderCustomFieldsGrid: renders a select field\'s real options and a multiselect field from the team roster', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.route(WORKER_ORIGIN + '/users/roster', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ users: [
      { username: 'alice', displayName: 'Alice' },
      { username: 'bob', displayName: 'Bob' },
    ] }) });
  });
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const cardId = await page.evaluate(() => boardCards[0].id);
  await page.evaluate((id) => openEditCard(id), cardId);
  await expect(page.locator('#cardModal')).toHaveClass(/show/);

  // 'jobType' is a real 'select' field seeded with real default options.
  const jobTypeOptions = await page.locator('#customFieldsGrid select[data-field="jobType"] option').allTextContents();
  expect(jobTypeOptions).toEqual(['Select...', 'New Home', 'Remodel', 'Commercial', 'Addition', 'Service Call']);

  // 'members' is a 'multiselect' field — one of TEAM_FIELD_KEYS, so it
  // renders in the separate #teamFieldsGrid, not #customFieldsGrid — and
  // is lazy-loaded from the roster; give the ensureUserRosterLoaded()
  // promise a moment to resolve and re-render.
  await expect(page.locator('#teamFieldsGrid .cf-multiselect-option')).toHaveCount(2);
  await expect(page.locator('#teamFieldsGrid .cf-multiselect-option').first()).toContainText('Alice');
});

test('collectCustomFieldValues: reads a select value and checked multiselect checkboxes back out of the DOM', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.route(WORKER_ORIGIN + '/users/roster', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ users: [
      { username: 'alice', displayName: 'Alice' },
    ] }) });
  });
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const cardId = await page.evaluate(() => boardCards[0].id);
  await page.evaluate((id) => openEditCard(id), cardId);
  await expect(page.locator('#teamFieldsGrid .cf-multiselect-option')).toHaveCount(1);

  await page.locator('#customFieldsGrid select[data-field="jobType"]').selectOption('Remodel');
  // The checkbox sits inside a collapsed ms-dropdown-panel (see
  // toggleMsDropdown()), so drive it directly rather than through a real
  // click — this test only verifies collectCustomFieldValues()'s DOM read,
  // not the dropdown's own open/close UI.
  await page.locator('#teamFieldsGrid .cf-multiselect-option input[type="checkbox"]').evaluate((el) => {
    el.checked = true;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });

  const values = await page.evaluate(() => collectCustomFieldValues());
  expect(values.jobType).toBe('Remodel');
  expect(values.members).toEqual(['alice']);
});

test('attachments: uploading a file adds it to the panel and persists on the card via autosave', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  let uploadedName = null;
  await page.route(WORKER_ORIGIN + '/attachments/upload*', (route) => {
    uploadedName = new URL(route.request().url()).searchParams.get('name');
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ key: 'attachments/fake-key.txt', name: uploadedName }) });
  });
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const cardId = await page.evaluate(() => boardCards[0].id);
  await page.evaluate((id) => openEditCard(id), cardId);
  await expect(page.locator('#cardModal')).toHaveClass(/show/);
  await expect(page.locator('#attachmentItems')).toContainText('No attachments yet.');

  await page.setInputFiles('#c_attachment_input', {
    name: 'photo.png',
    mimeType: 'image/png',
    buffer: Buffer.from('fake-image-bytes'),
  });

  await expect(page.locator('#attachmentItems .attachment-item')).toHaveCount(1);
  await expect(page.locator('#attachmentItems')).toContainText('photo.png');
  expect(uploadedName).toBe('photo.png');

  await page.evaluate(() => flushCardAutosave());
  const savedAttachments = await page.evaluate((id) => boardCards.find((c) => c.id === id).attachments, cardId);
  expect(savedAttachments).toHaveLength(1);
  expect(savedAttachments[0].key).toBe('attachments/fake-key.txt');
  expect(savedAttachments[0].isImage).toBe(true);
});

test('attachments: too-large a file is rejected before ever uploading', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  let uploadCalled = false;
  await page.route(WORKER_ORIGIN + '/attachments/upload*', (route) => {
    uploadCalled = true;
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const cardId = await page.evaluate(() => boardCards[0].id);
  await page.evaluate((id) => openEditCard(id), cardId);

  const tooLarge = await page.evaluate((max) => max + 1, await page.evaluate(() => MAX_ATTACHMENT_SIZE));
  await page.evaluate((size) => {
    const fakeEvent = { target: { files: [{ name: 'huge.pdf', size: size, type: 'application/pdf' }], value: '' } };
    handleAttachmentUpload(fakeEvent);
  }, tooLarge);

  await page.waitForTimeout(200);
  expect(uploadCalled).toBe(false);
  await expect(page.locator('#attachmentItems')).toContainText('No attachments yet.');
});

test('attachments: removing one calls the delete-file endpoint and drops it from the saved card', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  let deletedKey = null;
  await page.route(WORKER_ORIGIN + '/attachments/delete', (route) => {
    deletedKey = route.request().postDataJSON().key;
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const cardId = await page.evaluate(() => boardCards[0].id);
  await page.evaluate((id) => {
    const card = boardCards.find((c) => c.id === id);
    card.attachments = [{ id: 1, name: 'old.pdf', size: 100, key: 'attachments/old.pdf' }];
  }, cardId);
  await page.evaluate((id) => openEditCard(id), cardId);
  await expect(page.locator('#attachmentItems .attachment-item')).toHaveCount(1);

  await page.evaluate(() => removeAttachment(1));
  await expect(page.locator('#attachmentItems')).toContainText('No attachments yet.');
  await expect.poll(() => deletedKey).toBe('attachments/old.pdf');

  await page.evaluate(() => flushCardAutosave());
  const savedAttachments = await page.evaluate((id) => boardCards.find((c) => c.id === id).attachments, cardId);
  expect(savedAttachments).toHaveLength(0);
});

test('Manage Fields: adding and removing an option updates fieldOptions and refreshes the open card modal\'s dropdown', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const cardId = await page.evaluate(() => boardCards[0].id);
  await page.evaluate((id) => openEditCard(id), cardId);
  await page.evaluate(() => openManageFields());
  await expect(page.locator('#manageFieldsModal')).toHaveClass(/show/);

  await page.locator('#mf_new_jobType').fill('Custom Deck Build');
  await page.evaluate(() => addFieldOption('jobType'));
  const afterAdd = await page.evaluate(() => fieldOptions.jobType);
  expect(afterAdd).toContain('Custom Deck Build');
  await expect(page.locator('#manageFieldsBody')).toContainText('Custom Deck Build');

  await page.evaluate(() => closeManageFields());
  await expect(page.locator('#manageFieldsModal')).not.toHaveClass(/show/);
  const jobTypeOptionsAfter = await page.locator('#customFieldsGrid select[data-field="jobType"] option').allTextContents();
  expect(jobTypeOptionsAfter).toContain('Custom Deck Build');

  await page.evaluate(() => removeFieldOption('jobType', 'Custom Deck Build'));
  const afterRemove = await page.evaluate(() => fieldOptions.jobType);
  expect(afterRemove).not.toContain('Custom Deck Build');
});
