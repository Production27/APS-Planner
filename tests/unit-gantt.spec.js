const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');

const FIXTURE_URL = pathToFileURL(path.resolve(__dirname, 'unit-fixture.html')).toString();

// Direct unit tests for the Gantt visible-row builder extracted to
// src/views/gantt.ts in Phase 6b of the architecture roadmap — against
// the REAL built bundle (same approach as tests/unit-utils.spec.js and
// tests/unit-models.spec.js). buildVisibleTaskRows() is pure data
// transformation (no DOM reads/writes), which is exactly why it was
// picked as Gantt's second slice after the already-tested drag mechanics.
//
// This fixture has no real index.html app state, so every ambient global
// buildVisibleTaskRows() calls that normally lives in index.html
// (getVisibleJobs/getLinkedReferenceJobs/getHiddenTaskOrders/
// getSubUnitKey/getJobDueMarkerTask/tasksExpandedPhaseIds/
// tasksExpandedSubPhaseIds/ganttFocusedJobId) is stubbed per-test —
// getJobPhases()/getPhaseSubUnits() are NOT stubbed, since those are
// real bundled Phase-3 functions this test wants to exercise for real.

test('buildVisibleTaskRows: an unphased job with an un-expanded sub-unit collapses to one job-span row', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    window.getVisibleJobs = () => jobs;
    window.getLinkedReferenceJobs = () => [];
    window.getHiddenTaskOrders = () => new Set();
    window.getSubUnitKey = (job, phaseId, subPhaseId) => job.id + '::' + (phaseId || 'p0') + '::' + (subPhaseId || 's0');
    window.getJobDueMarkerTask = () => null;
    window.ganttFocusedJobId = null;
    tasksExpandedPhaseIds = new Set();
    tasksExpandedSubPhaseIds = new Set(); // nothing expanded — default collapsed

    jobs = [{
      id: 'job-1', name: 'Test Job', color: '#3949ab', archived: false,
      tasks: [
        { id: 't1', name: 'Bid', start: '2026-09-05', finish: '2026-09-05', order: 0 },
        { id: 't2', name: 'Scheduled', start: '2026-09-01', finish: '2026-09-03', order: 1 },
        { id: 't3', name: 'Active', start: '', finish: '', order: 2 }, // unscheduled — excluded either way
      ],
    }];

    return buildVisibleTaskRows().map((r) => ({ isJobSpan: !!r.task.isJobSpan, start: r.task.start, finish: r.task.finish, collapsible: r.collapsible }));
  });
  // Collapsed into one span covering only the two DATED tasks — 09-01
  // (earliest start) through 09-05 (latest finish), t3 excluded entirely.
  // collapsible is false here (not true) because this row comes from
  // buildSubPhaseRow(), not buildPhaseCollapsedRow() — an unphased job's
  // synthetic default phase has no real sub-phases to fold/unfold, so
  // there's nothing to collapse at the PHASE level; only a job actually
  // split into 2+ sub-phases produces a collapsible: true row.
  expect(result).toEqual([{ isJobSpan: true, start: '2026-09-01', finish: '2026-09-05', collapsible: false }]);
});

test('buildVisibleTaskRows: expanding the sub-unit yields one row per dated task, sorted by start date', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    window.getVisibleJobs = () => jobs;
    window.getLinkedReferenceJobs = () => [];
    window.getHiddenTaskOrders = () => new Set();
    window.getSubUnitKey = (job, phaseId, subPhaseId) => job.id + '::' + (phaseId || 'p0') + '::' + (subPhaseId || 's0');
    window.getJobDueMarkerTask = () => null;
    window.ganttFocusedJobId = null;
    tasksExpandedPhaseIds = new Set();
    // Unphased job's default phase/sub-unit both carry id:null — matches
    // getSubUnitKey('job-1', null, null) above.
    tasksExpandedSubPhaseIds = new Set(['job-1::p0::s0']);

    jobs = [{
      id: 'job-1', name: 'Test Job', color: '#3949ab', archived: false,
      tasks: [
        { id: 't1', name: 'Bid', start: '2026-09-05', finish: '2026-09-05', order: 0 },
        { id: 't2', name: 'Scheduled', start: '2026-09-01', finish: '2026-09-03', order: 1 },
        { id: 't3', name: 'Active', start: '', finish: '', order: 2 },
      ],
    }];

    return buildVisibleTaskRows().map((r) => ({ taskId: r.task.id, start: r.task.start }));
  });
  expect(result).toEqual([
    { taskId: 't2', start: '2026-09-01' },
    { taskId: 't1', start: '2026-09-05' },
  ]);
});

test('buildVisibleTaskRows: a job\'s due-date marker gets its own row on the first sub-unit once expanded', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    window.getVisibleJobs = () => jobs;
    window.getLinkedReferenceJobs = () => [];
    window.getHiddenTaskOrders = () => new Set();
    window.getSubUnitKey = (job, phaseId, subPhaseId) => job.id + '::' + (phaseId || 'p0') + '::' + (subPhaseId || 's0');
    window.getJobDueMarkerTask = (job) => ({ id: '__due__', name: 'Due Date', start: '2026-09-20', finish: '2026-09-20', order: -1, isDueMarker: true });
    window.ganttFocusedJobId = null;
    tasksExpandedPhaseIds = new Set();
    tasksExpandedSubPhaseIds = new Set(['job-1::p0::s0']);

    jobs = [{
      id: 'job-1', name: 'Test Job', color: '#3949ab', archived: false,
      tasks: [{ id: 't1', name: 'Bid', start: '2026-09-05', finish: '2026-09-05', order: 0 }],
    }];

    return buildVisibleTaskRows().map((r) => ({ isDueMarker: !!r.task.isDueMarker, taskId: r.task.id }));
  });
  expect(result).toEqual([
    { isDueMarker: false, taskId: 't1' },
    { isDueMarker: true, taskId: '__due__' },
  ]);
});
