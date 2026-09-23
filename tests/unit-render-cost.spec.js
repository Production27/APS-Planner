const { test, expect } = require('@playwright/test');
const { APP_URL, seedSession, mockRoomWebSocket } = require('./helpers');

// A7 step 3 (redraw less): the batched local copy (saveProjects /
// flushProjectsToLocalCache in src/app/project.ts), the Home Job Chat page
// size, the validated lookup indexes behind findJob()/getPhaseCard()
// (src/core/models.ts) and the shared date formatter (src/utils/date.ts).

async function open(page) {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
}

test('saves to the local copy are batched, and written at once when the page is hidden', async ({ page }) => {
  await open(page);
  const r = await page.evaluate(() => {
    flushProjectsToLocalCache();
    const before = localStorage.getItem('aps-planner:projects-v2');
    jobs[0].name = 'Batched Save Check';
    saveActiveProject();
    const rightAway = localStorage.getItem('aps-planner:projects-v2');
    window.dispatchEvent(new Event('pagehide'));
    const afterHide = localStorage.getItem('aps-planner:projects-v2');
    return { unchangedRightAway: rightAway === before, written: afterHide.includes('Batched Save Check') };
  });
  expect(r).toEqual({ unchangedRightAway: true, written: true });
  // And the timer writes it on its own too.
  await page.evaluate(() => { jobs[0].name = 'Timer Save Check'; saveActiveProject(); });
  await expect.poll(() => page.evaluate(() => localStorage.getItem('aps-planner:projects-v2').includes('Timer Save Check'))).toBe(true);
});

test('a local copy too big for browser storage is dropped instead of breaking the save', async ({ page }) => {
  await open(page);
  const r = await page.evaluate(() => {
    flushProjectsToLocalCache();
    const realSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (k === 'aps-planner:projects-v2') throw new DOMException('full', 'QuotaExceededError');
      return realSet.call(this, k, v);
    };
    let threw = false;
    try { jobs[0].name = 'Too Big'; saveJobs(); flushProjectsToLocalCache(); } catch (e) { threw = true; }
    Storage.prototype.setItem = realSet;
    return { threw, keyGone: localStorage.getItem('aps-planner:projects-v2') === null, inMemory: jobs[0].name };
  });
  expect(r).toEqual({ threw: false, keyGone: true, inMemory: 'Too Big' });
});

test('Home Job Chat shows the newest 100 messages, with a button for older ones', async ({ page }) => {
  await open(page);
  // Every other job's comments are cleared so the feed holds exactly these 130.
  await page.evaluate(() => {
    jobs.forEach((j) => { j.comments = []; });
    const job = jobs.find((j) => !j.archived && isJobVisibleToMe(j));
    job.comments = Array.from({ length: 130 }, (_, i) => ({ id: 'feed-' + i, author: 'A', text: 'Message ' + i, when: Date.now() - i * 60000, replies: [] }));
    switchTab('home');
    renderHomeDashboard();
  });
  const items = page.locator('#homeJobChatList .job-comment-item');
  await expect(items).toHaveCount(100);
  await expect(page.locator('#homeJobChatList')).toContainText('Message 0');
  await expect(page.locator('#homeJobChatList')).not.toContainText('Message 129');
  const more = page.locator('#homeJobChatList .job-chat-show-older');
  await expect(more).toHaveText('Show older messages (30)');
  await more.click();
  await expect(items).toHaveCount(130);
  await expect(more).toHaveCount(0);
});

test('findJob/getPhaseCard stay correct as the arrays change underneath them', async ({ page }) => {
  await open(page);
  const r = await page.evaluate(() => {
    const out = {};
    const job = jobs.find((j) => getPhaseCard(j, null));
    const card = getPhaseCard(job, null);
    const idx = boardCards.indexOf(card);
    // Replaced in place (what an incoming teammate change does).
    const replacement = Object.assign({}, card, { title: 'replacement' });
    boardCards[idx] = replacement;
    out.replaced = getPhaseCard(job, null) === replacement;
    // Removed.
    boardCards.splice(idx, 1);
    out.removed = getPhaseCard(job, null) === undefined;
    // Re-added at the end, then an earlier card re-pointed at this job in place.
    boardCards.push(replacement);
    out.readded = getPhaseCard(job, null) === replacement;
    // An orphaned card (no jobId) sitting EARLIER in the list gets adopted
    // by this job in place: a scan would now find it first, so must we.
    const orphan = { id: 'orphan-card', title: job.name, column: replacement.column, phaseId: null };
    boardCards.unshift(orphan);
    getPhaseCard(job, null); // re-cache with the orphan still unlinked
    migrateOrphanedCards();
    out.firstMatchKept = getPhaseCard(job, null) === orphan;
    boardCards.shift();
    // Whole array swapped (project switch / reload).
    const copy = boardCards.map((c) => Object.assign({}, c));
    boardCards = copy;
    out.swapped = copy.indexOf(getPhaseCard(job, null)) !== -1;
    // findJob: moved, removed, missing.
    const j = jobs[2];
    jobs.splice(2, 1); jobs.unshift(j);
    const found = findJob(j.id);
    out.jobMoved = found.job === j && found.idx === 0;
    jobs.shift();
    out.jobRemoved = findJob(j.id) === null;
    out.missing = findJob('no-such-job') === null;
    return out;
  });
  expect(r).toEqual({ replaced: true, removed: true, readded: true, firstMatchKept: true, swapped: true, jobMoved: true, jobRemoved: true, missing: true });
});

test('formatDate matches toLocaleDateString exactly', async ({ page }) => {
  await open(page);
  const r = await page.evaluate(() => {
    const opts = [{ month: 'short' }, { month: 'short', day: 'numeric' }, { month: 'short', day: 'numeric', year: 'numeric' }, { weekday: 'short' }, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }];
    const mismatches = [];
    for (let m = 0; m < 12; m++) {
      const d = new Date(2026, m, 3 + m, 9 + m, 5);
      opts.forEach((o) => {
        const want = o.hour ? d.toLocaleString('en-US', o) : d.toLocaleDateString('en-US', o);
        if (formatDate(d, o) !== want) mismatches.push([d.toISOString(), JSON.stringify(o), formatDate(d, o), want]);
      });
    }
    return mismatches;
  });
  expect(r).toEqual([]);
});
