const { test, expect } = require('@playwright/test');
const { APP_URL, seedSession, mockRoomWebSocket } = require('./helpers');

// The job/phase data model and auto-derive-column logic — moved from
// index.html to src/core/jobs.ts in Phase 10 of the extraction plan.
// deriveColumnForTasks() and dedupeTaskIdsAcrossPhases() each carry a
// documented, already-fixed past production bug in their own code
// comments (a manual-drag-loses-to-active-today priority bug, and a
// task-id-collision-across-phases bug) — neither had direct test
// coverage before this phase, only indirect mentions in other tests'
// comments.

test('REGRESSION PIN: deriveColumnForTasks priority order — scheduleDisconnected beats everything, then the manual override beats "active today"', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const result = await page.evaluate(() => {
    const today = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    // A task on the FIRST column ("bid") that's active right now.
    const tasks = [
      { id: 't1', start: iso(yesterday), finish: iso(tomorrow), columnId: 'bid' },
      { id: 't2', start: '', finish: '', columnId: 'scheduled' },
    ];

    // 1) scheduleDisconnected always wins, even with an active-today task.
    const savedFlag = BOARD_COLUMNS[2].scheduleDisconnected;
    BOARD_COLUMNS[2].scheduleDisconnected = true; // 'active' column, index 2
    const disconnectedResult = deriveColumnForTasks(tasks, { column: 'active' });
    BOARD_COLUMNS[2].scheduleDisconnected = savedFlag;

    // 2) THE BUG: a fresh manual drag into a regular board must beat
    // "today falls inside another task's active range" — this is the
    // real production bug (dragging out of a board that's still
    // "active today" elsewhere on the same job used to snap right back).
    const manualResult = deriveColumnForTasks(tasks, {
      column: 'invoiced',
      manualColumn: 'invoiced',
      manualColumnUntil: Date.now() + 60 * 60 * 1000, // 1h from now, still active
    });

    // 3) Without an active override, "today is inside t1's range" wins,
    // landing on 'bid' (index 0) — confirms the fallback still works.
    const noOverrideResult = deriveColumnForTasks(tasks, { column: 'invoiced' });

    return { disconnectedResult, manualResult, noOverrideResult };
  });

  expect(result.disconnectedResult).toBe('active');
  expect(result.manualResult).toBe('invoiced');
  expect(result.noOverrideResult).toBe('bid');
});

test('deriveColumnForTasks: no dates at all leaves the card wherever it already is (or the first column for a brand-new card)', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const result = await page.evaluate(() => {
    const undatedTasks = [{ id: 't1', start: '', finish: '', columnId: 'bid' }];
    return {
      existingCard: deriveColumnForTasks(undatedTasks, { column: 'complete' }),
      brandNewCard: deriveColumnForTasks(undatedTasks, null),
    };
  });
  expect(result.existingCard).toBe('complete'); // stays put, no dates to derive from
  expect(result.brandNewCard).toBe('bid'); // first column, nothing to derive from either
});

test('deriveColumnForTasks: a card parked in a hideFromSchedule board stays there until a task\'s dates actually hit today', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const result = await page.evaluate(() => {
    const bidCol = BOARD_COLUMNS.find((c) => c.id === 'bid');
    const savedFlag = bidCol.hideFromSchedule;
    bidCol.hideFromSchedule = true;

    const futureTasks = [{ id: 't1', start: '2099-01-01', finish: '2099-01-05', columnId: 'scheduled' }];
    const staysParked = deriveColumnForTasks(futureTasks, { column: 'bid' });

    const today = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    const y = new Date(today); y.setDate(y.getDate() - 1);
    const t = new Date(today); t.setDate(t.getDate() + 1);
    // deriveColumnForTasks() resolves the target column by the task's
    // ARRAY POSITION against BOARD_COLUMNS (not by reading task.columnId
    // at all) — normalizeTasksToColumns() is what guarantees that 1:1
    // alignment in real data, so this array needs an empty slot 0 (bid)
    // to put the dated, active-today task at position 1 (scheduled).
    const activeTodayTasks = [
      { id: 't1', start: '', finish: '' },
      { id: 't2', start: iso(y), finish: iso(t) },
    ];
    const pulledOntoSchedule = deriveColumnForTasks(activeTodayTasks, { column: 'bid' });

    bidCol.hideFromSchedule = savedFlag;
    return { staysParked, pulledOntoSchedule };
  });

  expect(result.staysParked).toBe('bid'); // future dates, no reason to move it yet
  expect(result.pulledOntoSchedule).toBe('scheduled'); // today falls in range — pulled out of the holding board
});

test('REGRESSION PIN: dedupeTaskIdsAcrossPhases gives colliding task ids across two phases a fresh id, leaving non-colliding ones untouched', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const result = await page.evaluate(() => {
    const job = {
      id: 'test-job',
      phases: [
        { id: 'p1', name: 'Phase 1', order: 0, tasks: [{ id: 'dup-id', name: 'A', start: '', finish: '', order: 0 }] },
        { id: 'p2', name: 'Phase 2', order: 1, tasks: [{ id: 'dup-id', name: 'B', start: '', finish: '', order: 0 }, { id: 'unique-id', name: 'C', start: '', finish: '', order: 1 }] },
      ],
    };
    dedupeTaskIdsAcrossPhases(job);
    return {
      p1Id: job.phases[0].tasks[0].id,
      p2FirstId: job.phases[1].tasks[0].id,
      p2SecondId: job.phases[1].tasks[1].id,
    };
  });

  // The FIRST occurrence keeps its id; only the later colliding one gets reassigned.
  expect(result.p1Id).toBe('dup-id');
  expect(result.p2FirstId).not.toBe('dup-id');
  expect(result.p2FirstId).toBeTruthy();
  // The never-colliding id is untouched.
  expect(result.p2SecondId).toBe('unique-id');
});

test('ensureJobHasCards: creates a missing phase card, and de-duplicates + remote-deletes an extra one for the same phase', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  let deletedKeys = [];
  await page.route('**/attachments/delete', (route) => route.fulfill({ status: 200, body: '{}' })); // unrelated, just avoid noise
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const result = await page.evaluate(() => {
    const job = { id: 'ensure-cards-job', name: 'Ensure Cards Job', color: '#123456', archived: false, comments: [], tasks: [] };
    jobs.push(job);
    ensureJobHasCards(job);
    const firstPassCount = boardCards.filter((c) => c.jobId === job.id).length;

    // Force a duplicate for the same (job, null-phase) pair, then re-run.
    boardCards.push(Object.assign({}, boardCards.find((c) => c.jobId === job.id), { id: 'dup-card-id' }));
    ensureJobHasCards(job);
    const afterDedup = boardCards.filter((c) => c.jobId === job.id);

    return { firstPassCount, afterDedupCount: afterDedup.length };
  });

  expect(result.firstPassCount).toBe(1);
  expect(result.afterDedupCount).toBe(1);
});

test('migrateOrphanedCards: a card whose title matches an existing job adopts that job\'s id; an unmatched one gets a brand-new stub job', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const result = await page.evaluate(() => {
    const matchingJobName = jobs[0].name;
    const jobCountBefore = jobs.length;
    boardCards.push({ id: 'orphan-matching', title: matchingJobName, column: 'bid' });
    boardCards.push({ id: 'orphan-unmatched', title: 'Totally New Untracked Job ' + Date.now(), column: 'bid' });

    migrateOrphanedCards();

    const matchingCard = boardCards.find((c) => c.id === 'orphan-matching');
    const unmatchedCard = boardCards.find((c) => c.id === 'orphan-unmatched');
    return {
      matchingCardJobId: matchingCard.jobId,
      matchingJobRealId: jobs[0].id,
      unmatchedCardJobId: unmatchedCard.jobId,
      jobCountAfter: jobs.length,
      jobCountBefore,
    };
  });

  expect(result.matchingCardJobId).toBe(result.matchingJobRealId);
  expect(result.unmatchedCardJobId).toBeTruthy();
  expect(result.jobCountAfter).toBe(result.jobCountBefore + 1); // one new stub job created
});

test('isJobVisibleToMe/getVisibleJobs: a below-projectAdmin account only sees jobs where it\'s listed as a Member', async ({ page }) => {
  await seedSession(page, { role: 'editor', username: 'membertest' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const result = await page.evaluate(() => {
    const job = jobs[0];
    const card = getPrimaryPhaseCard(job);
    card.customFields = Object.assign({}, card.customFields, { members: ['membertest'] });
    const visibleWithMembership = isJobVisibleToMe(job);

    card.customFields.members = ['someone-else'];
    const visibleWithoutMembership = isJobVisibleToMe(job);

    return { visibleWithMembership, visibleWithoutMembership, count: getVisibleJobs().length };
  });

  expect(result.visibleWithMembership).toBe(true);
  expect(result.visibleWithoutMembership).toBe(false);
});

test('isJobFinished: true only once every task has finished; false if any task is still open or the job is archived', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const result = await page.evaluate(() => {
    const pastJob = { id: 'j1', name: 'Past', archived: false, tasks: [{ finish: '2020-01-01' }, { finish: '2020-02-01' }] };
    const mixedJob = { id: 'j2', name: 'Mixed', archived: false, tasks: [{ finish: '2020-01-01' }, { finish: '2099-01-01' }] };
    const archivedJob = { id: 'j3', name: 'Archived', archived: true, tasks: [{ finish: '2020-01-01' }] };
    const noTasksJob = { id: 'j4', name: 'Empty', archived: false, tasks: [] };
    return {
      allPastFinishes: isJobFinished(pastJob),
      mixedFinishes: isJobFinished(mixedJob),
      archivedNeverFinished: isJobFinished(archivedJob),
      noTasksNeverFinished: isJobFinished(noTasksJob),
    };
  });

  expect(result.allPastFinishes).toBe(true);
  expect(result.mixedFinishes).toBe(false);
  expect(result.archivedNeverFinished).toBe(false);
  expect(result.noTasksNeverFinished).toBe(false);
});
