const { test, expect } = require('@playwright/test');
const { APP_URL, seedSession } = require('./helpers');

// Undo for high-impact actions (src/app/undo.ts): deleting a job, deleting
// a phase, archiving a job, deleting a board. Every room message the page
// sends is captured so the held-back job delete can be checked on the wire.
async function setup(page, { clock } = {}) {
  await seedSession(page, { role: 'admin' });
  const sent = [];
  await page.routeWebSocket(/\/room\?/, (ws) => {
    ws.send(JSON.stringify({ type: 'snapshot', projects: {} }));
    ws.onMessage((raw) => { try { sent.push(JSON.parse(raw)); } catch (e) {} });
  });
  if (clock) await page.clock.install();
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  return sent;
}

function deletesFor(sent, id) {
  return sent.filter((m) => m.type === 'deleteFromMap' && String(m.id) === String(id));
}

async function deleteFirstJob(page) {
  return page.evaluate(() => {
    const job = jobs.find((j) => !j.archived);
    const cardIds = getJobCards(job).map((c) => c.id);
    promptDeleteJob(job.id);
    executeDelete();
    return { jobId: job.id, cardIds, name: job.name };
  });
}

test('undo: deleting a job holds the server delete back, and Undo brings the job and its cards back', async ({ page }) => {
  const sent = await setup(page);
  const { jobId, cardIds } = await deleteFirstJob(page);

  expect(await page.evaluate((id) => !!findJob(id), jobId)).toBe(false);
  await expect(page.locator('.undo-toast')).toContainText('Job deleted');
  expect(await page.evaluate(() => localStorage.getItem('teamsync_pending_deletes_v1'))).toContain(jobId);
  await page.waitForTimeout(300);
  expect(deletesFor(sent, jobId)).toHaveLength(0);

  await page.locator('.undo-toast-btn').click();
  await expect(page.locator('.undo-toast')).toHaveCount(0);
  const after = await page.evaluate(({ id, cards }) => ({
    job: !!findJob(id),
    cards: cards.every((cid) => boardCards.some((c) => c.id === cid)),
    tombstoned: !!getActiveProject().deletedIds[id],
    pending: localStorage.getItem('teamsync_pending_deletes_v1'),
  }), { id: jobId, cards: cardIds });
  expect(after).toEqual({ job: true, cards: true, tombstoned: false, pending: null });
  await page.waitForTimeout(300);
  expect(deletesFor(sent, jobId)).toHaveLength(0);
});

test('undo: a deleted job is sent to the server once the 10-second window ends', async ({ page }) => {
  const sent = await setup(page, { clock: true });
  const { jobId, cardIds } = await deleteFirstJob(page);
  expect(deletesFor(sent, jobId)).toHaveLength(0);

  await page.clock.runFor(10500);
  await expect.poll(() => deletesFor(sent, jobId).length).toBe(1);
  for (const cid of cardIds) await expect.poll(() => deletesFor(sent, cid).length).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem('teamsync_pending_deletes_v1'))).toBeNull();
  await expect(page.locator('.undo-toast')).toHaveCount(0);
});

test('undo: a job delete left pending by a closed page is sent on the next load', async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('seededPending')) {
      sessionStorage.setItem('seededPending', '1');
      localStorage.setItem('teamsync_pending_deletes_v1', JSON.stringify([{ projectId: 'p-left', jobId: 'job-left', cardIds: ['card-left'] }]));
    }
  });
  const sent = await setup(page);
  await expect.poll(() => deletesFor(sent, 'job-left').length).toBe(1);
  await expect.poll(() => deletesFor(sent, 'card-left').length).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem('teamsync_pending_deletes_v1'))).toBeNull();
});

test('undo: archiving a job can be undone', async ({ page }) => {
  await setup(page);
  const jobId = await page.evaluate(() => { const j = jobs.find((x) => !x.archived); archiveJob(j.id); return j.id; });
  expect(await page.evaluate((id) => findJob(id).job.archived, jobId)).toBe(true);
  await expect(page.locator('.undo-toast')).toContainText('Job archived');
  await page.locator('.undo-toast-btn').click();
  expect(await page.evaluate((id) => findJob(id).job.archived, jobId)).toBe(false);
});

test('undo: a newer undoable action finalizes the previous one', async ({ page }) => {
  const sent = await setup(page);
  const { jobId } = await deleteFirstJob(page);
  await page.evaluate(() => { const j = jobs.find((x) => !x.archived); archiveJob(j.id); });
  await expect.poll(() => deletesFor(sent, jobId).length).toBe(1);
  await expect(page.locator('.undo-toast')).toHaveCount(1);
  await expect(page.locator('.undo-toast')).toContainText('Job archived');
});

test('undo: deleting a phase can be undone — same name, tasks and card, under a fresh id', async ({ page }) => {
  await setup(page);
  page.on('dialog', (d) => d.accept());
  const before = await page.evaluate(() => {
    const job = jobs.find((j) => !j.archived && !(j.phases && j.phases.length));
    splitJobIntoPhases(job);
    const second = addJobPhase(job);
    second.name = 'Second floor';
    ensureJobHasCards(job);
    saveJobs();
    editJob(job.id);
    const card = getPhaseCard(job, second.id);
    return { jobId: job.id, phaseId: second.id, tasks: JSON.stringify(second.tasks), cardTitle: card && card.title, cardColumn: card && card.column };
  });

  await page.evaluate((b) => deleteJobPhaseUI(b.phaseId), before);
  expect(await page.evaluate((b) => findJob(b.jobId).job.phases.length, before)).toBe(1);
  await expect(page.locator('.undo-toast')).toContainText('Phase deleted');

  await page.locator('.undo-toast-btn').click();
  const after = await page.evaluate((b) => {
    const job = findJob(b.jobId).job;
    const restored = job.phases.find((p) => p.name === 'Second floor');
    const card = restored && getPhaseCard(job, restored.id);
    return { count: job.phases.length, sameId: restored && restored.id === b.phaseId, tasks: restored && JSON.stringify(restored.tasks), cardColumn: card && card.column };
  }, before);
  expect(after.count).toBe(2);
  expect(after.sameId).toBe(false);
  expect(after.tasks).toBe(before.tasks);
  expect(after.cardColumn).toBe(before.cardColumn);
});

test('undo: deleting a board can be undone — the board, its cards and the jobs\' dates for it come back', async ({ page }) => {
  await setup(page);
  page.on('dialog', (d) => d.accept());
  const before = await page.evaluate(() => {
    const col = BOARD_COLUMNS.find((c) => c.id !== 'complete' && c.id !== 'invoiced' && BOARD_COLUMNS.indexOf(c) > 0);
    const job = jobs.find((j) => !j.archived && !(j.phases && j.phases.length));
    const task = job.tasks.find((t) => t.columnId === col.id);
    task.start = '2026-10-05'; task.finish = '2026-10-09';
    const card = getJobCards(job)[0];
    setCardColumn(card, col.id);
    saveJobs(); saveBoardCards();
    return { colId: col.id, order: BOARD_COLUMNS.map((c) => c.id), jobId: job.id, cardId: card.id };
  });

  await page.evaluate((b) => {
    deleteBoardColumn(b.colId);
    // What the next load/sync does to every job once the column is gone.
    jobs.forEach((j) => ensureJobTasksMatchColumns(j));
    saveJobs();
  }, before);
  const mid = await page.evaluate((b) => ({
    hasCol: BOARD_COLUMNS.some((c) => c.id === b.colId),
    task: !!findJob(b.jobId).job.tasks.find((t) => t.columnId === b.colId),
  }), before);
  expect(mid).toEqual({ hasCol: false, task: false });

  await page.locator('.undo-toast-btn').click();
  const after = await page.evaluate((b) => {
    const task = findJob(b.jobId).job.tasks.find((t) => t.columnId === b.colId);
    return {
      order: BOARD_COLUMNS.map((c) => c.id),
      dates: task && task.start + '..' + task.finish,
      cardColumn: boardCards.find((c) => c.id === b.cardId).column,
    };
  }, before);
  expect(after).toEqual({ order: before.order, dates: '2026-10-05..2026-10-09', cardColumn: before.colId });
});
