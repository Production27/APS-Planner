const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');

const FIXTURE_URL = pathToFileURL(path.resolve(__dirname, 'unit-fixture.html')).toString();

// Direct read-back tests for the job/task/phase/card lookup layer
// extracted to src/core/models.ts in Phase 3 of the architecture
// roadmap — against the REAL built bundle (see tests/unit-utils.spec.js
// for the same approach applied to Phase 2's utilities). `jobs`/
// `boardCards` are seeded directly here since these functions read them
// as ambient globals (unchanged call-site contract — see models.ts's own
// comment on why), exactly the way index.html's own loadActiveProjectData()
// populates them at boot.

test('findJob: returns the job and its index, or null when not found', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    jobs = [{ id: 'job-a', name: 'Job A' }, { id: 'job-b', name: 'Job B' }];
    return {
      found: findJob('job-b'),
      missing: findJob('does-not-exist'),
    };
  });
  expect(result.found).toEqual({ job: { id: 'job-b', name: 'Job B' }, idx: 1 });
  expect(result.missing).toBeNull();
});

test('getJobPhases: an unphased job gets a synthetic single-entry wrapper around job.tasks', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    const job = { id: 'job-a', name: 'Job A', tasks: [{ id: 't1', name: 'Task 1' }] };
    return getJobPhases(job);
  });
  expect(result).toEqual([{ id: null, name: 'Job A', order: 0, tasks: [{ id: 't1', name: 'Task 1' }], isDefault: true }]);
});

test('getJobPhases: a phased job returns job.phases directly, not a wrapper', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    const realPhases = [{ id: 'p1', name: 'Phase 1', order: 0, tasks: [], isDefault: false }];
    const job = { id: 'job-a', name: 'Job A', phases: realPhases };
    return getJobPhases(job);
  });
  expect(result).toEqual([{ id: 'p1', name: 'Phase 1', order: 0, tasks: [], isDefault: false }]);
});

test('getPhaseSubUnits: mirrors getJobPhases at the sub-phase level', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    const unphased = getPhaseSubUnits({ id: null, name: 'Phase 1', tasks: [{ id: 't1' }] });
    const withSubPhases = getPhaseSubUnits({
      id: 'p1', name: 'Phase 1',
      subPhases: [{ id: 'sp1', name: 'Sub 1', order: 0, tasks: [], isDefault: false }],
    });
    return { unphased, withSubPhases };
  });
  expect(result.unphased).toEqual([{ id: null, name: 'Phase 1', order: 0, tasks: [{ id: 't1' }], isDefault: true }]);
  expect(result.withSubPhases).toEqual([{ id: 'sp1', name: 'Sub 1', order: 0, tasks: [], isDefault: false }]);
});

test('findTask: locates a task through an unphased job\'s synthetic phase/sub-phase wrapper', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    jobs = [{ id: 'job-a', name: 'Job A', tasks: [{ id: 't1', name: 'Task 1', start: '2026-09-01', finish: '2026-09-05' }] }];
    return findTask('job-a', 't1');
  });
  expect(result).toEqual({
    job: { id: 'job-a', name: 'Job A', tasks: [{ id: 't1', name: 'Task 1', start: '2026-09-01', finish: '2026-09-05' }] },
    jobIdx: 0,
    task: { id: 't1', name: 'Task 1', start: '2026-09-01', finish: '2026-09-05' },
    taskIdx: 0,
    phaseId: null,
    subPhaseId: null,
  });
});

test('findTask: locates a task nested inside a real phase and sub-phase', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    jobs = [{
      id: 'job-a', name: 'Job A',
      phases: [{
        id: 'p1', name: 'Phase 1', order: 0, isDefault: false,
        subPhases: [{ id: 'sp1', name: 'Sub 1', order: 0, isDefault: false, tasks: [{ id: 't1', name: 'Deep Task' }] }],
      }],
    }];
    return findTask('job-a', 't1');
  });
  expect(result.task).toEqual({ id: 't1', name: 'Deep Task' });
  expect(result.phaseId).toBe('p1');
  expect(result.subPhaseId).toBe('sp1');
});

test('findTask: returns null for an unknown job or an unknown task on a real job', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    jobs = [{ id: 'job-a', name: 'Job A', tasks: [{ id: 't1' }] }];
    return { unknownJob: findTask('nope', 't1'), unknownTask: findTask('job-a', 'nope') };
  });
  expect(result.unknownJob).toBeNull();
  expect(result.unknownTask).toBeNull();
});

test('getPhaseCard/getJobCards/getPrimaryPhaseCard: match cards by (jobId, phaseId)', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    boardCards = [
      { id: 'c1', jobId: 'job-a', phaseId: null, column: 'bid' },
      { id: 'c2', jobId: 'job-a', phaseId: 'p2', column: 'active' },
      { id: 'c3', jobId: 'job-b', phaseId: null, column: 'bid' },
    ];
    const job = { id: 'job-a', name: 'Job A', phases: [{ id: 'p1' }, { id: 'p2' }] };
    return {
      legacyCard: getPhaseCard({ id: 'job-a' }, null),
      phaseCard: getPhaseCard({ id: 'job-a' }, 'p2'),
      missing: getPhaseCard({ id: 'job-a' }, 'p1'),
      allJobACards: getJobCards({ id: 'job-a' }).map((c) => c.id),
      // job's first phase is p1, which has no card of its own — the whole
      // point of getPrimaryPhaseCard() is falling back correctly here.
      primary: getPrimaryPhaseCard(job),
    };
  });
  expect(result.legacyCard.id).toBe('c1');
  expect(result.phaseCard.id).toBe('c2');
  expect(result.missing).toBeUndefined();
  expect(result.allJobACards.sort()).toEqual(['c1', 'c2']);
  expect(result.primary).toBeUndefined();
});
