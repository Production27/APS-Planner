const { test, expect } = require('@playwright/test');
const { APP_URL, seedSession, mockRoomWebSocket } = require('./helpers');

// Job Manager's list rendering, archive/restore, duplicateJob, and the
// delete-job flow — moved from index.html to src/views/job-list.ts in
// Phase 8 of the extraction plan. None of this had any test coverage
// before, and delete is irreversible, so per the plan these are written
// before/alongside the extraction rather than after.

test('renderJobList: search filters by name, and hides archived jobs from the main list', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const jobId = await page.evaluate(() => jobs[0].id);
  const jobName = await page.evaluate((id) => findJob(id).job.name, jobId);

  await page.evaluate(() => archiveJob(jobs[0].id));
  await expect(page.locator('#jobList')).not.toContainText(jobName);

  await page.evaluate((id) => restoreJob(id), jobId);
  await expect(page.locator('#jobList .job-card').first()).toBeVisible();

  // The job rail's search box is hidden behind toggleJobRail() until opened.
  await page.evaluate(() => toggleJobRail());
  await page.locator('#jobSearch').fill('zzz-no-such-job-zzz');
  await page.waitForTimeout(250); // filterJobList() debounces 150ms
  await expect(page.locator('#jobList .job-card')).toHaveCount(0);

  await page.locator('#jobSearch').fill('');
  await page.waitForTimeout(250);
  await expect(page.locator('#jobList .job-card').first()).toBeVisible();
});

test('archive/restore: archiving via the real UI moves a job into the Archived Jobs modal, and restoring brings it back', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const jobId = await page.evaluate(() => jobs[0].id);
  const jobName = await page.evaluate((id) => findJob(id).job.name, jobId);

  await page.evaluate((id) => editJob(id), jobId);
  await page.click('#archiveBtn');
  const archivedFlag = await page.evaluate((id) => findJob(id).job.archived, jobId);
  expect(archivedFlag).toBe(true);
  await expect(page.locator('#jobList')).not.toContainText(jobName);

  await page.evaluate(() => openArchivedJobsModal());
  await expect(page.locator('#archivedJobsModal')).toHaveClass(/show/);
  await expect(page.locator('#archivedJobsList')).toContainText(jobName);

  await page.click('#archivedJobsList [data-action="restore"]');
  const restoredFlag = await page.evaluate((id) => findJob(id).job.archived, jobId);
  expect(restoredFlag).toBe(false);
  await expect(page.locator('#archivedJobsList')).toContainText('No archived jobs.');
});

test('duplicateJob: copies tasks/color/card fields under a new name, but not comments or archived status', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const jobId = await page.evaluate(() => {
    const job = jobs[0];
    job.comments = [{ id: 'c1', author: 'Someone', text: 'do not copy me', when: Date.now() }];
    const card = getPhaseCard(job, getJobPhases(job)[0].id);
    if (card) card.customFields = Object.assign({}, card.customFields, { jobType: 'Remodel' });
    return job.id;
  });
  const before = await page.evaluate((id) => {
    const job = findJob(id).job;
    return { name: job.name, color: job.color, taskCount: (job.tasks || []).length };
  }, jobId);

  page.once('dialog', (d) => d.accept('Copy of ' + before.name));
  await page.evaluate((id) => duplicateJob(id), jobId);

  const newJobId = await page.evaluate(() => jobs[jobs.length - 1].id);
  const after = await page.evaluate((id) => {
    const job = findJob(id).job;
    const card = getPhaseCard(job, getJobPhases(job)[0].id);
    return {
      name: job.name,
      color: job.color,
      archived: job.archived,
      comments: job.comments,
      taskCount: (job.tasks || []).length,
      cardJobType: card ? card.customFields.jobType : null,
    };
  }, newJobId);

  expect(after.name).toBe('Copy of ' + before.name);
  expect(after.color).toBe(before.color);
  expect(after.taskCount).toBe(before.taskCount);
  expect(after.archived).toBe(false);
  expect(after.comments).toEqual([]);
  expect(after.cardJobType).toBe('Remodel');
  // duplicateJob() opens the new job in the drawer afterward.
  await expect(page.locator('#jobList .job-card.active')).toContainText('Copy of ' + before.name);
});

test('duplicateJob: cancelling the name prompt creates nothing', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const jobId = await page.evaluate(() => jobs[0].id);
  const countBefore = await page.evaluate(() => jobs.length);

  page.once('dialog', (d) => d.dismiss());
  await page.evaluate((id) => duplicateJob(id), jobId);

  const countAfter = await page.evaluate(() => jobs.length);
  expect(countAfter).toBe(countBefore);
});

test('delete flow: promptDeleteJob opens the confirmation modal, Cancel leaves the job untouched, and confirming via executeDelete removes it along with its board card', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const jobId = await page.evaluate(() => jobs[0].id);
  const jobName = await page.evaluate((id) => findJob(id).job.name, jobId);
  const cardId = await page.evaluate((id) => getJobCards(findJob(id).job)[0]?.id, jobId);
  expect(cardId).toBeTruthy();

  await page.evaluate((id) => promptDeleteJob(id), jobId);
  await expect(page.locator('#deleteModal')).toHaveClass(/show/);
  await expect(page.locator('#deleteJobName')).toHaveText(jobName);

  // Cancel — the job must still exist afterward.
  await page.click('#deleteModal button:has-text("Cancel")');
  await expect(page.locator('#deleteModal')).not.toHaveClass(/show/);
  let stillExists = await page.evaluate((id) => !!findJob(id), jobId);
  expect(stillExists).toBe(true);

  // Now actually delete it.
  await page.evaluate((id) => promptDeleteJob(id), jobId);
  await page.click('#deleteModal button:has-text("Delete")');
  await expect(page.locator('#deleteModal')).not.toHaveClass(/show/);

  stillExists = await page.evaluate((id) => !!findJob(id), jobId);
  expect(stillExists).toBe(false);
  await expect(page.locator('#jobList')).not.toContainText(jobName);

  const cardStillExists = await page.evaluate((id) => boardCards.some((c) => c.id === id), cardId);
  expect(cardStillExists).toBe(false);
});

test('delete flow: promptDeleteJob is a no-op for a role below projectAdmin, even called directly', async ({ page }) => {
  await seedSession(page, { role: 'editor' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const jobId = await page.evaluate(() => jobs[0].id);
  await page.evaluate((id) => promptDeleteJob(id), jobId);
  await expect(page.locator('#deleteModal')).not.toHaveClass(/show/);
  const stillExists = await page.evaluate((id) => !!findJob(id), jobId);
  expect(stillExists).toBe(true);
});

test('delete flow: deleting the currently-open job closes its drawer', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const jobId = await page.evaluate(() => jobs[0].id);
  await page.evaluate((id) => editJob(id), jobId);
  await expect(page.locator('#formArea')).toHaveClass(/open/);

  await page.evaluate((id) => promptDeleteJob(id), jobId);
  await page.click('#deleteModal button:has-text("Delete")');

  await expect(page.locator('#formArea')).not.toHaveClass(/open/);
  const editingId = await page.evaluate(() => editingJobId);
  expect(editingId).toBeNull();
});
