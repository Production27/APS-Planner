const { test, expect } = require('@playwright/test');
const { APP_URL, seedSession, mockRoomWebSocket } = require('./helpers');

// Job Manager's own comments/replies drawer UI (#jobCommentsPanel) — moved
// from index.html to src/views/job-comments.ts in Phase 7 of the
// extraction plan. postJobComment()/postJobReply()'s underlying logic was
// already indirectly exercised via Home's Job Chat widget tests
// (teamsync.spec.js), but the Job Manager drawer's own surface — opening
// a job, the comment/reply panel, delete buttons, the important flag/
// badge, and the collapse toggle — had no direct coverage before.

test('Job Manager drawer: posting a comment via the real UI renders it and updates the collapsed tab badge', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const jobId = await page.evaluate(() => jobs[0].id);
  await page.evaluate((id) => editJob(id), jobId);
  await expect(page.locator('#jobCommentsList')).toContainText('No comments yet.');

  await page.locator('#newJobCommentText').fill('Delivered the rebar today.');
  await page.locator('#newJobCommentImportant').check();
  await page.click('button[onclick="addJobComment()"]');

  await expect(page.locator('#jobCommentsList')).toContainText('Delivered the rebar today.');
  await expect(page.locator('#jobCommentsList .job-comment-important-badge')).toHaveCount(1);
  await expect(page.locator('#jobCommentsTabCount')).toHaveText('1');
  await expect(page.locator('#newJobCommentText')).toHaveValue('');
  await expect(page.locator('#newJobCommentImportant')).not.toBeChecked();

  const saved = await page.evaluate((id) => findJob(id).job.comments, jobId);
  expect(saved).toHaveLength(1);
  expect(saved[0].important).toBe(true);
});

test('Job Manager drawer: replying to a comment and then deleting the reply and the comment both work via the real UI', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const jobId = await page.evaluate(() => jobs[0].id);
  const commentId = await page.evaluate((id) => postJobComment(id, 'Original comment', false).id, jobId);
  await page.evaluate((id) => editJob(id), jobId);
  await expect(page.locator('#jobCommentsList')).toContainText('Original comment');

  await page.click('#jobCommentsList .job-comment-reply-btn');
  await page.locator('#jobCommentsList textarea[id^="reply-ta-"]').fill('Sounds good, thanks.');
  await page.click('#jobCommentsList button[onclick^="addJobReply"]');
  await expect(page.locator('#jobCommentsList')).toContainText('Sounds good, thanks.');
  await expect(page.locator('#jobCommentsList .job-comment-reply-btn')).toContainText('Reply (1)');

  // Delete the reply first, then the comment — both via their own × buttons.
  await page.click('#jobCommentsList .job-comment-reply-item .job-comment-delete');
  await expect(page.locator('#jobCommentsList')).not.toContainText('Sounds good, thanks.');

  await page.click('#jobCommentsList .job-comment-item > .job-comment-meta .job-comment-delete');
  await expect(page.locator('#jobCommentsList')).toContainText('No comments yet.');

  const saved = await page.evaluate((id) => findJob(id).job.comments, jobId);
  expect(saved.find((c) => c.id === commentId)).toBeUndefined();
});

test('renderJobComments: posting a comment on a DIFFERENT job than the one open in the drawer does not touch the drawer\'s list', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const ids = await page.evaluate(() => jobs.slice(0, 2).map((j) => j.id));
  await page.evaluate((id) => editJob(id), ids[0]);
  await expect(page.locator('#jobCommentsList')).toContainText('No comments yet.');

  // deleteJobComment()/addJobReply() etc. can be reached from the Home Job
  // Chat widget too, which acts on whatever job it's showing regardless of
  // what's open in this drawer — renderJobComments() must no-op unless the
  // job it was called for is the one actually open, verified via
  // break-then-restore (temporarily removed the guard, confirmed the other
  // job's comment leaked into this list, restored it).
  await page.evaluate((id) => postJobComment(id, 'Comment on the other job', false), ids[1]);
  await expect(page.locator('#jobCommentsList')).toContainText('No comments yet.');
});

test('toggleJobCommentsPanel: collapses the panel and shrinks the drawer, and re-expands on a second call', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const jobId = await page.evaluate(() => jobs[0].id);
  await page.evaluate((id) => editJob(id), jobId);
  // editJob() itself defaults the panel to collapsed.
  await expect(page.locator('#jobCommentsPanel')).toHaveClass(/collapsed/);
  await expect(page.locator('#formArea')).toHaveClass(/comments-collapsed/);

  // #jobCommentsTab (the narrow side-tab standing in for the collapsed
  // panel) is a wide-desktop-only affordance — hidden by CSS at this
  // test viewport's width, where the panel stacks above the form instead
  // and .job-comments-collapse-btn (inside the always-visible h4) is the
  // toggle that's actually reachable here.
  await page.click('.job-comments-collapse-btn');
  await expect(page.locator('#jobCommentsPanel')).not.toHaveClass(/collapsed/);
  await expect(page.locator('#formArea')).not.toHaveClass(/comments-collapsed/);

  await page.click('.job-comments-collapse-btn');
  await expect(page.locator('#jobCommentsPanel')).toHaveClass(/collapsed/);
});
