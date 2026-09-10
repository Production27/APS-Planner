const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');

const FIXTURE_URL = pathToFileURL(path.resolve(__dirname, 'unit-fixture.html')).toString();

// Direct unit tests for the Home dashboard's widget DATA BUILDERS,
// extracted to src/views/home.ts's Phase HD-c — against the REAL built
// bundle (same approach as tests/unit-calendar.spec.js). These are pure
// functions (jobs/boardCards in, row arrays out), so isJobVisibleToMe()/
// isFinishedColumnId() (still ambient — real implementations stay in
// index.html) are stubbed directly in each test rather than needing the
// full app boot, same pattern as tests/unit-checklist.spec.js's
// getEffectiveRole()/getStoredUsername() stubs.
//
// All date math below is relative to the REAL current date (these
// functions call `new Date()` internally, not a passed-in "today") so
// the tests stay correct regardless of which day they actually run on.

function isoDaysFromNow(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

test('buildHomeOverdueRows: separates overdue from due-soon, excludes finished columns and archived/invisible jobs, sorts overdue first then by date', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate((dates) => {
    isJobVisibleToMe = (job) => job.id !== 'hidden-job';
    isFinishedColumnId = (colId) => colId === 'complete';
    jobs = [
      { id: 'j1', name: 'Overdue Job', archived: false, tasks: [] },
      { id: 'j2', name: 'Due Soon Job', archived: false, tasks: [] },
      { id: 'j3', name: 'Archived Job', archived: true, tasks: [] },
      { id: 'hidden-job', name: 'Hidden Job', archived: false, tasks: [] },
      { id: 'j5', name: 'Not Due Job', archived: false, tasks: [] },
    ];
    boardCards = [
      { id: 'c1', jobId: 'j1', column: 'active', due: dates.overdue },
      { id: 'c2', jobId: 'j2', column: 'active', due: dates.dueSoon },
      { id: 'c3', jobId: 'j3', column: 'active', due: dates.overdue },
      { id: 'c4', jobId: 'hidden-job', column: 'active', due: dates.overdue },
      { id: 'c5', jobId: 'j5', column: 'active', due: dates.farFuture },
      { id: 'c6', jobId: 'j1', column: 'complete', due: dates.overdue }, // finished column, excluded
    ];
    return buildHomeOverdueRows().map((r) => ({ job: r.job.name, isOverdue: r.isOverdue }));
  }, { overdue: isoDaysFromNow(-2), dueSoon: isoDaysFromNow(3), farFuture: isoDaysFromNow(30) });

  expect(result).toEqual([
    { job: 'Overdue Job', isOverdue: true },
    { job: 'Due Soon Job', isOverdue: false },
  ]);
});

test('buildHomeStalledRows: uses a column\'s own stalledAfterDays, falling back to DEFAULT_STALLED_AFTER_DAYS, sorted longest-stalled first', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    isJobVisibleToMe = () => true;
    isFinishedColumnId = (colId) => colId === 'complete';
    DEFAULT_STALLED_AFTER_DAYS = 14;
    BOARD_COLUMNS = [
      { id: 'bid', label: 'Bid', stalledAfterDays: 5 },
      { id: 'active', label: 'Active' }, // no override — uses the 14-day default
      { id: 'complete', label: 'Complete' },
    ];
    jobs = [
      { id: 'j1', name: 'Stalled Bid', archived: false, tasks: [] },
      { id: 'j2', name: 'Fresh Bid', archived: false, tasks: [] },
      { id: 'j3', name: 'Stalled Active', archived: false, tasks: [] },
    ];
    const now = Date.now();
    boardCards = [
      { id: 'c1', jobId: 'j1', column: 'bid', columnEnteredAt: now - 6 * 86400000 }, // 6 days > 5-day threshold
      { id: 'c2', jobId: 'j2', column: 'bid', columnEnteredAt: now - 2 * 86400000 }, // 2 days, not stalled
      { id: 'c3', jobId: 'j3', column: 'active', columnEnteredAt: now - 20 * 86400000 }, // 20 days > 14-day default
    ];
    return buildHomeStalledRows().map((r) => r.job.name);
  });

  expect(result).toEqual(['Stalled Active', 'Stalled Bid']);
});

test('buildHomeStageSummary: counts visible cards per column, including zero-count columns, in board order', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    isJobVisibleToMe = (job) => job.id !== 'hidden-job';
    BOARD_COLUMNS = [{ id: 'bid', label: 'Bid' }, { id: 'active', label: 'Active' }, { id: 'complete', label: 'Complete' }];
    jobs = [
      { id: 'j1', name: 'Job 1', archived: false, tasks: [] },
      { id: 'hidden-job', name: 'Hidden', archived: false, tasks: [] },
    ];
    boardCards = [
      { id: 'c1', jobId: 'j1', column: 'bid' },
      { id: 'c2', jobId: 'j1', column: 'bid' },
      { id: 'c3', jobId: 'hidden-job', column: 'active' }, // invisible job — doesn't count
    ];
    return buildHomeStageSummary();
  });

  expect(result).toEqual([
    { id: 'bid', label: 'Bid', count: 2 },
    { id: 'active', label: 'Active', count: 0 },
    { id: 'complete', label: 'Complete', count: 0 },
  ]);
});

test('buildHomeTodayScheduleRows: includes only tasks whose start/finish window covers today', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate((dates) => {
    isJobVisibleToMe = () => true;
    jobs = [
      {
        id: 'j1', name: 'In Progress Job', archived: false, color: '#111',
        tasks: [
          { id: 't1', name: 'Spanning today', start: dates.yesterday, finish: dates.tomorrow, order: 0 },
          { id: 't2', name: 'Already finished', start: dates.farPast, finish: dates.yesterday, order: 1 },
          { id: 't3', name: 'Not started yet', start: dates.tomorrow, finish: dates.farFuture, order: 2 },
        ],
      },
    ];
    return buildHomeTodayScheduleRows().map((r) => r.taskName);
  }, { yesterday: isoDaysFromNow(-1), tomorrow: isoDaysFromNow(1), farPast: isoDaysFromNow(-10), farFuture: isoDaysFromNow(10) });

  expect(result).toEqual(['Spanning today']);
});

test('buildHomeUpcomingScheduleRows: includes any task overlapping the given window at all, sorted by start date', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate((dates) => {
    isJobVisibleToMe = () => true;
    jobs = [
      {
        id: 'j1', name: 'Job', archived: false, color: '#111',
        tasks: [
          { id: 't1', name: 'Starts inside window', start: dates.day2, finish: dates.day4, order: 0 },
          { id: 't2', name: 'Ends inside window (starts before)', start: dates.day0, finish: dates.day1, order: 1 },
          { id: 't3', name: 'Entirely after window', start: dates.day10, finish: dates.day12, order: 2 },
        ],
      },
    ];
    const windowStart = new Date(dates.windowStart + 'T00:00:00');
    const windowEnd = new Date(dates.windowEnd + 'T00:00:00');
    return buildHomeUpcomingScheduleRows(windowStart, windowEnd).map((r) => r.taskName);
  }, { day0: isoDaysFromNow(0), day1: isoDaysFromNow(1), day2: isoDaysFromNow(2), day4: isoDaysFromNow(4), day10: isoDaysFromNow(10), day12: isoDaysFromNow(12), windowStart: isoDaysFromNow(1), windowEnd: isoDaysFromNow(7) });

  expect(result).toEqual(['Ends inside window (starts before)', 'Starts inside window']);
});

test('buildHomeGanttUnclosedRows: flags a phase whose schedule is fully done but whose board card hasn\'t moved to a finished column', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate((dates) => {
    isJobVisibleToMe = () => true;
    isFinishedColumnId = (colId) => colId === 'complete';
    jobs = [
      {
        id: 'j1', name: 'Finished Schedule, Card Not Moved', archived: false,
        tasks: [{ id: 't1', name: 'Task', start: dates.farPast, finish: dates.yesterday, order: 0 }],
      },
      {
        id: 'j2', name: 'Still In Progress', archived: false,
        tasks: [{ id: 't2', name: 'Task', start: dates.yesterday, finish: dates.tomorrow, order: 0 }],
      },
    ];
    boardCards = [
      { id: 'c1', jobId: 'j1', column: 'active' }, // schedule done, card still active — should flag
      { id: 'c2', jobId: 'j2', column: 'active' }, // schedule not done yet — should NOT flag
    ];
    return buildHomeGanttUnclosedRows().map((r) => r.job.name);
  }, { yesterday: isoDaysFromNow(-1), tomorrow: isoDaysFromNow(1), farPast: isoDaysFromNow(-10) });

  expect(result).toEqual(['Finished Schedule, Card Not Moved']);
});
