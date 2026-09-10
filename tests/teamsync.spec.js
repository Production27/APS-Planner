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

test('isBusyEditing(): an open modal (e.g. the card detail modal) also counts as busy', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await page.goto(APP_URL);
  await expect(page.locator('#loginOverlay')).not.toHaveClass(/show/);

  // The Fix 3 test above covers the Board/Gantt/Calendar drag-state
  // branch of isBusyEditing() — this covers the separate open-modal
  // branch, which wasn't exercised by any existing test before this
  // move (src/sync/connection.ts, Phase 7b).
  const result = await page.evaluate(() => {
    const before = isBusyEditing();
    const modal = document.getElementById('cardModal');
    modal.classList.add('show');
    const whileOpen = isBusyEditing();
    modal.classList.remove('show');
    const afterClose = isBusyEditing();
    return { before, whileOpen, afterClose };
  });

  expect(result.before).toBe(false);
  expect(result.whileOpen).toBe(true);
  expect(result.afterClose).toBe(false);
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

test('calendar month view: a scheduled job task renders as a positioned bar on the correct day', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => switchTabMorphed('calendar'));

  // Same reasoning as the gantt drag test above: a fresh demo job's tasks
  // start unscheduled, so schedule one directly through the data model,
  // then pin calendarViewDate to the same month so the grid it builds
  // actually contains that date, and re-render through the real
  // renderCalendar()/renderMonthCalendar()/buildCalBarHtml() pipeline.
  const info = await page.evaluate(() => {
    const job = jobs[0];
    const phase = getJobPhases(job)[0];
    const sub = getPhaseSubUnits(phase)[0];
    const t = (sub.tasks || [])[0];
    if (!t) return null;
    t.start = '2026-09-10';
    t.finish = '2026-09-12';
    calendarViewDate = new Date('2026-09-15T00:00:00');
    calendarViewMode = 'month';
    renderCalendar();
    return { jobId: job.id };
  });
  expect(info).not.toBeNull();

  await expect(page.locator('.cal-day[data-date="2026-09-10"]')).toBeAttached();
  const bar = page.locator('.cal-event-bar[data-cal-job-id="' + info.jobId + '"]');
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute('data-cal-task-start', '2026-09-10');
  // Position comes from real getCell()/offsetLeft measurements against the
  // rendered grid, not a hardcoded value — a non-empty "left:...px" proves
  // the lane-packing pass actually ran against real layout, not just that
  // some bar element exists in the DOM somewhere.
  await expect(bar).toHaveAttribute('style', /left:\d/);
});

test('calendar week view: a timed calendar event renders in the hourly grid', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => switchTabMorphed('calendar'));

  await page.evaluate(() => {
    calendarViewDate = new Date('2026-09-15T00:00:00');
    calendarEvents.push({
      id: genId(), title: 'Site walkthrough', start: '2026-09-15', time: '10:30', duration: 1,
      repeat: 'none', repeatUntil: null, color: '#7e57c2', exceptions: {}, visibility: 'all', visibleMembers: [],
    });
    // setCalendarView() (not a direct renderWeekCalendar() call) so this
    // also exercises the real Prev/Next/view-toggle entry point, not just
    // the render function in isolation.
    setCalendarView('week');
  });

  const evtEl = page.locator('.week-timed-event', { hasText: 'Site walkthrough' });
  await expect(evtEl).toBeVisible();
  await expect(evtEl).toHaveAttribute('style', /top:\d/);

  // Day view reuses the same renderWeekHourGrid() renderer for a single
  // date — switching there should show the identical timed event without
  // losing it.
  await page.evaluate(() => setCalendarView('day'));
  await expect(page.locator('.week-timed-event', { hasText: 'Site walkthrough' })).toBeVisible();
});

test('calendar bar drag: dragging a calendar event bar reschedules it by the dragged number of days', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => switchTabMorphed('calendar'));

  // A job task's own bar in month/week view is always a collapsed
  // "job-span" cluster (see buildCalendarJobRows()), which is deliberately
  // read-only/click-to-open, never drag-reschedulable — dragging is only
  // meaningful here for a standalone calendar event's own bar (or a job's
  // due-date marker, a separate code path), so that's what this test
  // drags.
  const before = await page.evaluate(() => {
    const evt = {
      id: genId(), title: 'Concrete pour', start: '2026-09-10', duration: 2,
      repeat: 'none', repeatUntil: null, color: '#7e57c2', exceptions: {}, visibility: 'all', visibleMembers: [],
    };
    calendarEvents.push(evt);
    calendarViewDate = new Date('2026-09-15T00:00:00');
    calendarViewMode = 'month';
    renderCalendar();
    return { eventId: evt.id, start: evt.start, duration: evt.duration };
  });
  expect(before).not.toBeNull();

  const shiftedDays = 3;
  const result = await page.evaluate(
    ({ eventId, shiftedDays }) => {
      const bar = document.querySelector('.cal-event-bar[data-cal-job-id="calevt-job-' + eventId + '"]');
      if (!bar) return null;
      const cellWidth = document.querySelector('.cal-day').offsetWidth;
      // Same reasoning as the gantt drag test below: exercise the
      // committed handlers directly, bypassing the rAF-coalesced
      // mousemove wrapper (handleCalBarMouseMove) — the exact per-event
      // clientX doesn't matter, only the final delta handleCalBarMouseUp
      // computes from it.
      handleCalBarMouseDown({ preventDefault() {}, target: bar, clientX: 0 });
      applyCalBarMouseMove({ clientX: shiftedDays * cellWidth, clientY: 0 });
      handleCalBarMouseUp({ clientX: shiftedDays * cellWidth });
      const evt = calendarEvents.find((e) => e.id === eventId);
      return evt ? { start: evt.start, duration: evt.duration } : null;
    },
    { eventId: before.eventId, shiftedDays }
  );

  const expectedStart = await page.evaluate(
    ({ start, shiftedDays }) => {
      const d = new Date(start + 'T00:00:00');
      d.setDate(d.getDate() + shiftedDays);
      return toIsoDate(d);
    },
    { start: before.start, shiftedDays }
  );

  expect(result).not.toBeNull();
  expect(result.start).toBe(expectedStart);
  expect(result.duration).toBe(before.duration);
});

test('calendar wheel navigation: a horizontal trackpad scroll pages the month, a vertical one does not', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => switchTabMorphed('calendar'));
  await page.waitForFunction(() => getActiveTab() === 'calendar');
  await page.waitForTimeout(500);

  const before = await page.evaluate(() => {
    calendarViewDate = new Date('2026-09-15T00:00:00');
    calendarViewMode = 'month';
    renderCalendar();
    return toIsoDate(calendarViewDate);
  });

  // A vertical-dominant wheel event (deltaY > deltaX) must be left alone
  // entirely — handleCalWheel()'s own discrimination check — so a normal
  // scroll/zoom wheel over the calendar never accidentally pages it.
  // deltaX (80) alone clears CAL_WHEEL_THRESHOLD (50), so this only stays
  // a no-op because of the deltaX-vs-deltaY discrimination check
  // specifically, not because the accumulated delta was too small.
  const afterVertical = await page.evaluate(() => {
    const el = document.getElementById('calendarDays');
    el.dispatchEvent(new WheelEvent('wheel', { deltaX: 80, deltaY: 200, bubbles: true, cancelable: true }));
    return toIsoDate(calendarViewDate);
  });
  expect(afterVertical).toBe(before);

  // A horizontal-dominant wheel event past CAL_WHEEL_THRESHOLD (50) pages
  // to the next month via animateCalendarWheelChange()/calendarNext().
  const afterHorizontal = await page.evaluate(() => {
    const el = document.getElementById('calendarDays');
    el.dispatchEvent(new WheelEvent('wheel', { deltaX: 80, deltaY: 5, bubbles: true, cancelable: true }));
    return toIsoDate(calendarViewDate);
  });
  expect(afterHorizontal).toBe('2026-10-15');
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

test('gantt bar resize: dragging the right edge extends a task and cascades every later task in the sub-unit', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => switchTabMorphed('gantt'));

  // Same setup reasoning as the plain bar-move test above, but scheduling
  // the first TWO tasks in the sub-unit (not just one) so extending the
  // first one's finish date has a later task to cascade onto.
  const before = await page.evaluate(() => {
    const job = jobs[0];
    const phase = getJobPhases(job)[0];
    const sub = getPhaseSubUnits(phase)[0];
    const tasks = (sub.tasks || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    const t0 = tasks[0];
    const t1 = tasks[1];
    if (!t0 || !t1) return null;
    t0.start = '2026-09-01';
    t0.finish = '2026-09-05';
    t1.start = '2026-09-06';
    t1.finish = '2026-09-10';
    renderGantt();
    return { jobId: job.id, taskId: t0.id, laterTaskId: t1.id };
  });
  expect(before).not.toBeNull();

  const extendDays = 3;
  const result = await page.evaluate(
    ({ jobId, taskId, laterTaskId, extendDays }) => {
      const bar = document.querySelector('.task-bar:not(.due-marker-bar)');
      if (!bar) return null;
      // Same reasoning as the plain bar-move test above: drive the
      // committed state change directly, bypassing the rAF-coalesced
      // mousemove pipeline (applyBarResizeMove) entirely.
      startBarResizeRight({ preventDefault() {}, stopPropagation() {}, clientX: 0 }, jobId, taskId, bar);
      barResizeState.currentDuration = barResizeState.initialDuration + extendDays;
      onBarResizeEnd({});
      const found = findTask(jobId, taskId);
      const laterFound = findTask(jobId, laterTaskId);
      return {
        finish: found ? found.task.finish : null,
        laterStart: laterFound ? laterFound.task.start : null,
        laterFinish: laterFound ? laterFound.task.finish : null,
      };
    },
    { jobId: before.jobId, taskId: before.taskId, laterTaskId: before.laterTaskId, extendDays }
  );

  expect(result).not.toBeNull();
  expect(result.finish).toBe('2026-09-08'); // 09-05 extended by 3 days
  expect(result.laterStart).toBe('2026-09-09'); // 09-06 cascaded by the same 3 days
  expect(result.laterFinish).toBe('2026-09-13'); // 09-10 cascaded by the same 3 days
});

test('gantt bar drag (real mouse events): dragging a bar body moves its dates, exercising renderTimelineBars()\'s own mousedown wiring', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => switchTabMorphed('gantt'));
  // switchTabMorphed() finishes its morph transition asynchronously (see
  // its own note in the calendar Phase 5d work) — the panel isn't
  // reliably laid out with real pixel dimensions until it settles, which
  // this test's real page.mouse coordinates depend on (unlike the other
  // Gantt tests here, which drive handlers directly and never need real
  // on-screen positions). getActiveTab() flips before the CSS morph
  // transition actually finishes settling the panel's layout, and under
  // full-suite parallel load (6 workers contending for the CPU) that
  // transition's wall-clock time stretches well past its nominal CSS
  // duration — waiting on the tab-state condition alone still flaked, so
  // this also gives the transition itself real room to finish.
  await page.waitForFunction(() => getActiveTab() === 'gantt');
  await page.waitForTimeout(1500);

  // Every other Gantt drag test in this file drives startBarMove()/
  // onBarMoveEnd() directly, bypassing the browser's real mousedown/
  // mousemove/mouseup chain entirely — that's deliberate (see their own
  // comments) to isolate the committed-state logic from rAF/event timing.
  // This test instead exercises the actual DOM wiring renderTimelineBars()
  // creates (bar.addEventListener('mousedown', ...)) via Playwright's real
  // mouse API, the one thing none of those other tests can catch if it
  // broke. A wide (multi-week) bar is used deliberately — the bar's own
  // job-name tag (<span class="task-bar-job-tag collapsible">) is
  // pointer-events:auto and stopPropagation()s its own mousedown so
  // clicking THAT toggles job-focus instead of starting a drag (see its
  // own comment in gantt.ts); a wide bar leaves clear space near its right
  // end, past the tag, to grab the bar body itself instead.
  const before = await page.evaluate(() => {
    const job = jobs[0];
    const phase = getJobPhases(job)[0];
    const sub = getPhaseSubUnits(phase)[0];
    const t = (sub.tasks || [])[0];
    if (!t) return null;
    t.start = '2026-09-01';
    t.finish = '2026-09-20';
    renderGantt();
    return { jobId: job.id, taskId: t.id };
  });
  expect(before).not.toBeNull();

  const bar = page.locator('.task-bar:not(.due-marker-bar)').first();
  const box = await bar.boundingBox();
  await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 20 - 68, box.y + box.height / 2, { steps: 5 }); // ~2 cells left at dayWidth 34
  await page.mouse.up();

  const result = await page.evaluate(
    ({ jobId, taskId }) => {
      const found = findTask(jobId, taskId);
      return found ? { start: found.task.start, finish: found.task.finish } : null;
    },
    before
  );

  expect(result).not.toBeNull();
  expect(result.start).toBe('2026-08-30'); // 09-01 shifted 2 days earlier
  expect(result.finish).toBe('2026-09-18'); // 09-20 shifted the same 2 days
});

test('regression: hovering two different Gantt date headers shows each one\'s own date, not always the last', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => switchTabMorphed('gantt'));
  await page.waitForFunction(() => getActiveTab() === 'gantt');
  await page.waitForTimeout(1500);

  // Real bug found while porting buildDateHeader() to src/views/gantt.ts
  // (Phase 6c): the loop's `current` Date is one object mutated in place
  // across every iteration, so every day-header's click/mouseenter
  // closure captured the SAME object — by the time a user actually
  // hovered one, `current` already held the loop's final date, so every
  // header showed the same (wrong, last-in-range) popover date. Fixed by
  // snapshotting a fresh Date per iteration before wiring the listeners.
  const todayHeader = page.locator('.day-header.today-header');
  const todayDate = await todayHeader.getAttribute('data-date');
  await todayHeader.hover();
  const popoverToday = await page.locator('#datePopover h5').textContent();

  // Three cells over — still a header rendered by the SAME loop, so this
  // is exactly the scenario the shared-mutable-object bug broke.
  const laterHeader = todayHeader.locator('xpath=following-sibling::div[@class="day-header"][3]');
  const laterDate = await laterHeader.getAttribute('data-date');
  await laterHeader.hover();
  const popoverLater = await page.locator('#datePopover h5').textContent();

  expect(todayDate).not.toBe(laterDate);
  const expectedToday = await page.evaluate((iso) => new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }), todayDate);
  const expectedLater = await page.evaluate((iso) => new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }), laterDate);
  expect(popoverToday).toBe(expectedToday);
  expect(popoverLater).toBe(expectedLater);
});

test('gantt zoom: zoomIn/zoomOut/resetZoom step dayWidth and clamp to [14, 80]', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => switchTabMorphed('gantt'));
  await page.waitForFunction(() => getActiveTab() === 'gantt');
  await page.waitForTimeout(1500);

  const result = await page.evaluate(() => {
    dayWidth = 34;
    zoomIn();
    const afterIn = dayWidth;
    zoomOut();
    zoomOut();
    const afterOut = dayWidth;
    resetZoom();
    const afterReset = dayWidth;
    // Clamping: pushing zoomOut far past the floor should settle at
    // GANTT_ZOOM_MIN (14), not keep going negative or hit 0.
    for (let i = 0; i < 15; i++) zoomOut();
    const clampedLow = dayWidth;
    for (let i = 0; i < 20; i++) zoomIn();
    const clampedHigh = dayWidth;
    return { afterIn, afterOut, afterReset, clampedLow, clampedHigh };
  });

  expect(result.afterIn).toBe(40); // 34 + 6
  expect(result.afterOut).toBe(28); // 40 - 6 - 6
  expect(result.afterReset).toBe(34);
  expect(result.clampedLow).toBe(14);
  expect(result.clampedHigh).toBe(80);
});

test('gantt zoom: fitToView computes a dayWidth that fits the whole visible date range in the container', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => switchTabMorphed('gantt'));
  await page.waitForFunction(() => getActiveTab() === 'gantt');
  await page.waitForTimeout(1500);

  const result = await page.evaluate(() => {
    const job = jobs[0];
    const phase = getJobPhases(job)[0];
    const sub = getPhaseSubUnits(phase)[0];
    const t = (sub.tasks || [])[0];
    t.start = '2026-09-01';
    t.finish = '2026-09-10';
    renderGantt();
    fitToView();
    computeDateRange();
    const totalDays = getDaysDiff(startDate, endDate) + 1;
    const containerWidth = document.getElementById('timelineBody').clientWidth - 20;
    const expectedFitted = Math.max(Math.floor(containerWidth / totalDays), 14);
    return { dayWidth, expectedFitted };
  });

  expect(result.dayWidth).toBe(result.expectedFitted);
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

test('card modal: editing the title of a job-linked card renames the job, not just the card', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const jobLinkedCardId = await page.evaluate(() => boardCards.find((c) => c.jobId)?.id);
  expect(jobLinkedCardId).toBeTruthy();

  const newTitle = 'Renamed via card modal ' + Date.now();
  await page.evaluate((id) => openEditCard(id), jobLinkedCardId);
  await expect(page.locator('#cardModal')).toHaveClass(/show/);
  await page.locator('#c_title').fill(newTitle);
  await page.evaluate(() => flushCardAutosave());

  const result = await page.evaluate((id) => {
    const card = boardCards.find((c) => c.id === id);
    const job = findJob(card.jobId).job;
    return { jobName: job.name, cardTitle: card.title };
  }, jobLinkedCardId);
  // The rename writes through to the job; the card's own .title is
  // re-derived from that (ensureJobHasCards()), not set directly here.
  expect(result.jobName).toBe(newTitle);
  expect(result.cardTitle).toBe(newTitle);
});

test('card modal: editing the due date and custom fields saves through autosave, and delete removes the card', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const cardId = await page.evaluate(() => boardCards[0].id);
  await page.evaluate((id) => openEditCard(id), cardId);
  await expect(page.locator('#cardModal')).toHaveClass(/show/);

  await page.locator('#c_due').fill('2026-12-25');
  await page.evaluate(() => flushCardAutosave());
  const dueAfterSave = await page.evaluate((id) => boardCards.find((c) => c.id === id).due, cardId);
  expect(dueAfterSave).toBe('2026-12-25');

  await page.evaluate(() => closeCardModal());
  await expect(page.locator('#cardModal')).not.toHaveClass(/show/);

  // Re-open and delete
  await page.evaluate((id) => openEditCard(id), cardId);
  await page.evaluate(() => deleteCardFromModal());
  const stillExists = await page.evaluate((id) => boardCards.some((c) => c.id === id), cardId);
  expect(stillExists).toBe(false);
});

test('buildCardEl: an overdue card gets the overdue badge, a finished-column card does not', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const result = await page.evaluate(() => {
    const overdueCard = { id: 'test-1', column: 'bid', due: '2020-01-01' };
    const finishedColCard = { id: 'test-2', column: 'complete', due: '2020-01-01' };
    const notDueYetCard = { id: 'test-3', column: 'bid', due: '2099-01-01' };
    return {
      overdue: buildCardEl(overdueCard).querySelector('.board-card-due.overdue') !== null,
      finishedColNotOverdue: buildCardEl(finishedColCard).querySelector('.board-card-due.overdue') === null,
      notYetDue: buildCardEl(notDueYetCard).querySelector('.board-card-due.overdue') === null,
    };
  });
  expect(result.overdue).toBe(true);
  expect(result.finishedColNotOverdue).toBe(true);
  expect(result.notYetDue).toBe(true);
});

test('buildCardEl: checklist progress badge reflects done/total counts, including sub-items', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const badgeText = await page.evaluate(() => {
    const card = {
      id: 'test-checklist', column: 'bid',
      checklists: { bid: [{ id: 'i1', text: 'Item 1', done: true }, { id: 'i2', text: 'Item 2', done: false, subItems: [{ done: true }, { done: false }] }] },
    };
    const badge = buildCardEl(card).querySelector('.mini-badge');
    return badge ? badge.textContent.trim() : null;
  });
  // 2 of 4 flags done: item1 (done), item2 (not done), sub1 (done), sub2 (not done)
  expect(badgeText).toContain('2/4');
});

test('buildCardEl: the attachment count badge only appears when attachments exist', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const result = await page.evaluate(() => {
    const withAttachments = { id: 'a1', column: 'bid', attachments: [{ name: 'a.pdf' }, { name: 'b.pdf' }] };
    const withoutAttachments = { id: 'a2', column: 'bid' };
    const badges = [...buildCardEl(withAttachments).querySelectorAll('.mini-badge')].map((b) => b.textContent.trim());
    return {
      withCount: badges.some((t) => t.includes('2')),
      withoutBadge: buildCardEl(withoutAttachments).querySelector('.board-card-badges') === null,
    };
  });
  expect(result.withCount).toBe(true);
  expect(result.withoutBadge).toBe(true);
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
