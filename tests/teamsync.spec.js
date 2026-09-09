const { test, expect } = require('@playwright/test');
const { APP_URL, WORKER_ORIGIN, seedSession, mockRoomWebSocket } = require('./helpers');

test('login: a valid seeded session bypasses the login overlay', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await page.goto(APP_URL);

  await expect(page.locator('#loginOverlay')).not.toHaveClass(/show/);
  await expect(page.locator('#jobList')).toBeAttached();
});

test('job CRUD: creating a job via the UI lands in the underlying data model', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#loginOverlay')).not.toHaveClass(/show/);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const jobName = 'Playwright smoke test job ' + Date.now();
  // Driven via addNewJob() directly rather than clicking one of its two
  // trigger buttons (the always-visible rail one, or the dynamically
  // rendered one at the bottom of the job list) — which button is even
  // clickable depends on which tab/panel is active and how wide the job
  // rail is, none of which this test cares about; it's exercising the
  // draft-job -> autosave -> data-model path, same as either button does.
  await page.evaluate(() => addNewJob());
  await page.locator('#f_job').fill(jobName);
  // Force the debounced autosave to flush immediately rather than waiting
  // on its real-world debounce timer — deterministic, not timing-dependent.
  await page.evaluate(() => flushAutoSaveJobForm());

  // Verified against the actual data model, not the DOM — a save that
  // "looks right" on screen isn't proof it stuck (see SESSION_HANDOFF.md).
  const savedJobExists = await page.evaluate((name) => {
    const proj = getActiveProject();
    return !!(proj && Object.values(proj.jobs || {}).some((j) => j.name === name));
  }, jobName);
  expect(savedJobExists).toBe(true);
});

test('model layer read-back: a job created through the real UI comes back from findJob() with the right shape', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#loginOverlay')).not.toHaveClass(/show/);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const jobName = 'Model read-back test job ' + Date.now();
  await page.evaluate(() => addNewJob());
  await page.locator('#f_job').fill(jobName);
  await page.evaluate(() => flushAutoSaveJobForm());

  // findJob() is the bundled Phase 3 extraction (src/core/models.ts) —
  // this confirms the moved function still resolves a job that was just
  // created through the real save path, with the shape everything else
  // in the app expects back from it (job.id === the id it was found by,
  // idx pointing at its real position in the jobs array).
  const result = await page.evaluate((name) => {
    const idx = jobs.findIndex((j) => j.name === name);
    const job = jobs[idx];
    const found = findJob(job.id);
    return { idx, found };
  }, jobName);

  expect(result.found).not.toBeNull();
  expect(result.found.idx).toBe(result.idx);
  expect(result.found.job.name).toBe(jobName);
});

test('regression (Fix 3): isBusyEditing() now covers an in-progress Board drag', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await page.goto(APP_URL);
  await expect(page.locator('#loginOverlay')).not.toHaveClass(/show/);

  const cardDragBusy = await page.evaluate(() => {
    draggedCardId = 'test-card-id';
    const busy = isBusyEditing();
    draggedCardId = null;
    return busy;
  });
  expect(cardDragBusy).toBe(true);

  const colDragBusy = await page.evaluate(() => {
    draggedColId = 'test-col-id';
    const busy = isBusyEditing();
    draggedColId = null;
    return busy;
  });
  expect(colDragBusy).toBe(true);

  const idleBusy = await page.evaluate(() => isBusyEditing());
  expect(idleBusy).toBe(false);
});

test('regression (Fix 4): a first-connection failure escalates the sync indicator instead of hanging on "Connecting…"', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page); // real connection succeeds; the scenario below is simulated directly
  await page.clock.install();
  await page.goto(APP_URL);
  await expect(page.locator('#loginOverlay')).not.toHaveClass(/show/);

  // Simulating this via real WebSocket retry timing means fighting
  // ReconnectingWebSocket's own backoff schedule (unknown/unstable exact
  // values) rather than testing this app's code — same reasoning as the
  // Fix 3 test above calling isBusyEditing() directly instead of
  // simulating a real HTML5 drag. Fix 4 changed exactly one thing:
  // handleRoomClose() now calls scheduleOfflineEscalation() even when
  // roomEverConnected is still false (a first-connection failure) —
  // exercise that directly.
  await page.evaluate(() => {
    roomEverConnected = false;
    handleRoomClose({ code: 1006 });
  });

  // scheduleOfflineEscalation()'s timer is 8s; fast-forward well past it
  // deterministically rather than waiting on a real 8-second clock.
  await page.clock.fastForward(15000);

  const tooltip = await page.evaluate(() => document.getElementById('syncDot')?.title || '');
  expect(tooltip.toLowerCase()).toContain('offline');
});

test('sync: a successful reconnect clears the offline indicator and cancels the pending escalation', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.clock.install();
  await page.goto(APP_URL);
  await expect(page.locator('#loginOverlay')).not.toHaveClass(/show/);

  // Drive the same offline path as the Fix 4 regression test above, then
  // recover from it — handleRoomOpen() is what a real reconnect calls.
  await page.evaluate(() => {
    roomEverConnected = false;
    handleRoomClose({ code: 1006 });
  });
  await page.clock.fastForward(15000);
  const offlineTooltip = await page.evaluate(() => document.getElementById('syncDot')?.title || '');
  expect(offlineTooltip.toLowerCase()).toContain('offline');

  await page.evaluate(() => handleRoomOpen());
  const recoveredTooltip = await page.evaluate(() => document.getElementById('syncDot')?.title || '');
  expect(recoveredTooltip.toLowerCase()).not.toContain('offline');

  // cancelOfflineEscalation() inside handleRoomOpen() must have cleared the
  // timer too — without that, the indicator would silently flip back to
  // "offline" on its own a few seconds later even though the connection is
  // fine, which a snapshot check right after handleRoomOpen() alone
  // wouldn't catch.
  await page.clock.fastForward(15000);
  const stillRecoveredTooltip = await page.evaluate(() => document.getElementById('syncDot')?.title || '');
  expect(stillRecoveredTooltip.toLowerCase()).not.toContain('offline');
});

test('board drag-and-drop: dropping a card on a new column updates its stored column', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const result = await page.evaluate(() => {
    const card = boardCards[0];
    if (!card) return null;
    const originalColumn = card.column;
    const targetColumnId = BOARD_COLUMNS.find((c) => c.id !== originalColumn).id;
    const body = document.getElementById('col-body-' + targetColumnId);
    const cardEl = document.querySelector('.board-card[data-id="' + card.id + '"]');
    if (!body || !cardEl) return null;

    // handleColumnDrop() finishes by calling syncBoardCardsFromDOM(), which
    // rebuilds every card's .column from where its element actually sits
    // in the DOM — a real drag's dragover handler (applyColumnDragOver())
    // is what moves the element there before drop fires. Since this test
    // drives handleColumnDrop() directly (see the reasoning below), it has
    // to do that DOM move itself first, or syncBoardCardsFromDOM() would
    // just read the card's unchanged original position right back.
    body.appendChild(cardEl);
    draggedCardId = card.id;
    // Drives the real drop handler directly rather than simulating native
    // HTML5 dragstart/dragover/drop events — same reasoning as the
    // isBusyEditing() drag-guard regression test: exercise the function
    // that owns the actual state change (setCardColumn via
    // handleColumnDrop), not the browser's own drag machinery.
    handleColumnDrop({ preventDefault() {}, stopPropagation() {}, currentTarget: body });

    return {
      originalColumn,
      targetColumnId,
      newColumn: boardCards.find((c) => c.id === card.id).column,
    };
  });

  expect(result).not.toBeNull();
  expect(result.newColumn).toBe(result.targetColumnId);
  expect(result.newColumn).not.toBe(result.originalColumn);
});

test('calendar CRUD: add, edit, and delete an event via the modal all land in the underlying data model', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const eventTitle = 'Playwright calendar event ' + Date.now();

  // Add — driven via the real modal open/fill/save path, then verified
  // against calendarEvents directly rather than the DOM (see the job CRUD
  // test above for why: a save that "looks right" on screen isn't proof
  // it stuck).
  await page.evaluate(() => openAddCalendarEvent('2026-09-15', '09:00'));
  await page.locator('#ce_title').fill(eventTitle);
  await page.evaluate(() => saveCalendarEventFromModal());

  const added = await page.evaluate((title) => {
    const evt = calendarEvents.find((e) => e.title === title);
    return evt ? { id: evt.id, start: evt.start } : null;
  }, eventTitle);
  expect(added).not.toBeNull();
  expect(added.start).toBe('2026-09-15');

  // Edit — reopen the same event through openEditCalendarEvent() (the real
  // entry point a click on the rendered bar uses) and change its date.
  const updatedTitle = eventTitle + ' (edited)';
  await page.evaluate((id) => openEditCalendarEvent(id), added.id);
  await page.locator('#ce_title').fill(updatedTitle);
  await page.locator('#ce_date').fill('2026-09-16');
  await page.evaluate(() => saveCalendarEventFromModal());

  const edited = await page.evaluate((id) => calendarEvents.find((e) => e.id === id), added.id);
  expect(edited.title).toBe(updatedTitle);
  expect(edited.start).toBe('2026-09-16');

  // Delete
  await page.evaluate((id) => openEditCalendarEvent(id), added.id);
  await page.evaluate(() => deleteCalendarEventFromModal());
  const stillExists = await page.evaluate((id) => calendarEvents.some((e) => e.id === id), added.id);
  expect(stillExists).toBe(false);
});

test('gantt drag: moving a task bar shifts its dates by the dragged number of days', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => switchTabMorphed('gantt'));

  // A fresh demo job's tasks start unscheduled (empty start/finish, one per
  // board stage — see ensureJobHasCards()) until manually scheduled, so
  // there's nothing to drag yet. Schedule the first job's first task
  // directly through the data model, then re-render so a real .task-bar
  // exists for it, the same way saving dates in the Job Manager form would.
  const before = await page.evaluate(() => {
    const job = jobs[0];
    const phase = getJobPhases(job)[0];
    const sub = getPhaseSubUnits(phase)[0];
    const t = (sub.tasks || [])[0];
    if (!t) return null;
    t.start = '2026-09-01';
    t.finish = '2026-09-05';
    renderGantt();
    return { jobId: job.id, taskId: t.id, start: t.start, finish: t.finish };
  });
  expect(before).not.toBeNull();

  const shiftedDays = 3;
  const result = await page.evaluate(
    ({ jobId, taskId, shiftedDays }) => {
      const bar = document.querySelector('.task-bar:not(.due-marker-bar)');
      if (!bar) return null;
      // startBarMove() reads e.clientX only to compute a live delta on
      // mousemove — since the rAF-coalesced move pipeline is bypassed
      // below (same reasoning as the Fix 3/Fix 4 tests: exercise the
      // committed state change directly, not the timing-sensitive
      // machinery around it), the exact clientX here doesn't matter.
      startBarMove({ clientX: 0 }, jobId, taskId, bar);
      barMoveState.deltaDays = shiftedDays;
      barMoveState.moved = true;
      onBarMoveEnd({});
      const found = findTask(jobId, taskId);
      return found ? { start: found.task.start, finish: found.task.finish } : null;
    },
    { jobId: before.jobId, taskId: before.taskId, shiftedDays }
  );

  const expected = await page.evaluate(
    ({ start, finish, shiftedDays }) => {
      const shift = (iso) => {
        const d = new Date(iso + 'T00:00:00');
        d.setDate(d.getDate() + shiftedDays);
        return toIsoDate(d);
      };
      return { start: shift(start), finish: shift(finish) };
    },
    { start: before.start, finish: before.finish, shiftedDays }
  );

  expect(result).not.toBeNull();
  expect(result.start).toBe(expected.start);
  expect(result.finish).toBe(expected.finish);
});

test('board column CRUD: add, rename, and delete a column via the real modal/prompt flow', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  // Add
  const columnLabel = 'Playwright Test Board ' + Date.now();
  const addedId = await page.evaluate((label) => {
    addBoardColumn(label);
    return BOARD_COLUMNS.find((c) => c.label === label).id;
  }, columnLabel);
  expect(addedId).toBeTruthy();

  // Rename — deleteBoardColumn()/renameBoardColumn() use the native
  // confirm()/prompt() dialogs; Playwright auto-dismisses dialogs unless
  // a handler accepts them first.
  const renamedLabel = columnLabel + ' (renamed)';
  page.once('dialog', (d) => d.accept(renamedLabel));
  await page.evaluate((id) => renameBoardColumn(id), addedId);
  const afterRename = await page.evaluate((id) => BOARD_COLUMNS.find((c) => c.id === id).label, addedId);
  expect(afterRename).toBe(renamedLabel);

  // Delete — accepting the confirm() dialog
  page.once('dialog', (d) => d.accept());
  await page.evaluate((id) => deleteBoardColumn(id), addedId);
  const stillExists = await page.evaluate((id) => BOARD_COLUMNS.some((c) => c.id === id), addedId);
  expect(stillExists).toBe(false);
});

test('board column CRUD: the Complete and Invoiced columns cannot be deleted', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const before = await page.evaluate(() => BOARD_COLUMNS.length);
  // Accept the confirm() dialog so this test actually isolates the
  // complete/invoiced special-case guard — without this, Playwright's
  // default dialog auto-dismiss (confirm() returning false) would make
  // the assertion below pass for the WRONG reason even if that guard
  // were removed, since the later confirm() check would still block the
  // delete on its own. Confirmed this the hard way: the guard was
  // temporarily removed and this test still passed until this handler
  // was added.
  page.on('dialog', (d) => d.accept());
  await page.evaluate(() => deleteBoardColumn('complete'));
  const after = await page.evaluate(() => BOARD_COLUMNS.length);
  expect(after).toBe(before);
});

test('board card visibility: isCardFromArchivedJob/isCardVisibleToMe reflect the linked job\'s real state', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const result = await page.evaluate(() => {
    const job = jobs[0];
    const originalArchived = job.archived;
    job.archived = true;
    const archivedResult = isCardFromArchivedJob({ jobId: job.id });
    job.archived = originalArchived;
    const restoredResult = isCardFromArchivedJob({ jobId: job.id });
    // A card with no jobId at all (not linked to any job) fails open —
    // stays visible/not-archived rather than erroring.
    const noJobId = { jobId: null };
    return {
      archivedResult,
      restoredResult,
      noJobIdArchived: isCardFromArchivedJob(noJobId),
      noJobIdVisible: isCardVisibleToMe(noJobId),
    };
  });
  expect(result.archivedResult).toBe(true);
  expect(result.restoredResult).toBe(false);
  expect(result.noJobIdArchived).toBe(false);
  expect(result.noJobIdVisible).toBe(true);
});

test('workflow items: add, recolor, and remove via the real modal', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  await page.evaluate(() => openWorkflowItemsModal());
  await expect(page.locator('#workflowItemsModal')).toHaveClass(/show/);

  const itemLabel = 'Playwright Workflow Item ' + Date.now();
  await page.locator('#wfi_new_item').fill(itemLabel);
  await page.locator('#workflowItemsBody button', { hasText: 'Add' }).click();

  const added = await page.evaluate((label) => WORKFLOW_ITEMS.find((i) => i.label === label), itemLabel);
  expect(added).toBeTruthy();
  expect(added.color).toBeTruthy();

  // Recolor — picking a swatch that isn't already selected, so the test
  // doesn't accidentally "pass" by picking the color it already had.
  const newColor = await page.evaluate((id) => {
    const item = WORKFLOW_ITEMS.find((i) => i.id === id);
    const target = COLOR_PRESETS.find((c) => c !== item.color);
    changeWorkflowItemColor(id, target, { stopPropagation() {} });
    return target;
  }, added.id);
  const afterRecolor = await page.evaluate((id) => WORKFLOW_ITEMS.find((i) => i.id === id).color, added.id);
  expect(afterRecolor).toBe(newColor);

  // Remove, and confirm a board that was grouped under it falls back to
  // showing no workflowItemId rather than a dangling reference.
  await page.evaluate((id) => {
    BOARD_COLUMNS[0].workflowItemId = id;
    removeWorkflowItem(id);
  }, added.id);
  const result = await page.evaluate((id) => ({
    stillExists: WORKFLOW_ITEMS.some((i) => i.id === id),
    columnStillLinked: BOARD_COLUMNS[0].workflowItemId === id,
  }), added.id);
  expect(result.stillExists).toBe(false);
  expect(result.columnStillLinked).toBe(false);
});

test('error reporting: an uncaught error and an unhandled rejection both POST a report to the Worker', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);

  const reported = [];
  await page.route(WORKER_ORIGIN + '/report-error', async (route) => {
    reported.push(JSON.parse(route.request().postData()));
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' });
  });

  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  await page.evaluate(() => {
    setTimeout(() => { throw new Error('Playwright synthetic uncaught error'); }, 0);
  });
  await page.waitForTimeout(100);

  await page.evaluate(() => {
    Promise.reject(new Error('Playwright synthetic unhandled rejection'));
  });
  await page.waitForTimeout(100);

  expect(reported.length).toBe(2);
  const errorReport = reported.find((r) => r.kind === 'error');
  const rejectionReport = reported.find((r) => r.kind === 'unhandledrejection');
  expect(errorReport.message).toContain('Playwright synthetic uncaught error');
  expect(rejectionReport.message).toContain('Playwright synthetic unhandled rejection');
  // A verified identity should ride along on the report — this session
  // was seeded as an admin — rather than trusting a client-claimed name.
  expect(errorReport.token).toBeTruthy();
});

test('error reporting: a tight error loop is capped rather than flooding the Worker', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);

  let reportCount = 0;
  await page.route(WORKER_ORIGIN + '/report-error', async (route) => {
    reportCount++;
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' });
  });

  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  await page.evaluate(() => {
    for (let i = 0; i < 30; i++) reportClientError('error', 'loop ' + i, {});
  });
  await page.waitForTimeout(100);

  expect(reportCount).toBe(20); // MAX_CLIENT_ERROR_REPORTS_PER_LOAD
});

test('cross-project isolation: a project-restricted account cannot switch to the other project', async ({ page }) => {
  // A single admin load to get the two real (locally-fabricated, see
  // enforceFixedProjectSet()) project ids — these are generated at
  // runtime, not fixed strings, and a second page.goto() would just talk
  // to the same always-empty mocked room again and fabricate a fresh,
  // different pair instead of reloading the first pair. Simulating the
  // restricted account by mutating currentUserRole/currentAssignedProjectId
  // and calling enforceProjectScopeForRole()/switchProject() directly
  // avoids that entirely, and matches how a real role/assignment change
  // actually reaches this app: over the existing session, not a reload
  // (see applyIdentityFromTokenPayload()).
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  const projectIds = await page.evaluate(() => Object.keys(projects));
  expect(projectIds.length).toBe(2);
  const [assignedId, otherId] = projectIds;

  const result = await page.evaluate(
    ({ assignedId, otherId }) => {
      currentUserRole = 'projectAdmin';
      currentAssignedProjectId = assignedId;
      enforceProjectScopeForRole();
      const afterEnforce = activeProjectId;

      switchProject(otherId);
      return { afterEnforce, afterSwitchAttempt: activeProjectId };
    },
    { assignedId, otherId }
  );

  expect(result.afterEnforce).toBe(assignedId);
  expect(result.afterSwitchAttempt).toBe(assignedId);
});
