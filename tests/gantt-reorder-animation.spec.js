const { test, expect } = require('@playwright/test');
const { APP_URL, seedSession, mockRoomWebSocket } = require('./helpers');

// Regression test for the Gantt reorder animation (src/views/gantt.ts).
// This app's own sync layer echoes every change back to its sender (see
// room-do.ts's broadcastSnapshot()), so a single user reorder can trigger
// two overlapping renderGantt() calls in quick succession, each starting
// its own connector-line tracking loop. Two real bugs in that path only
// ever showed up under exactly this overlap:
//   1. Both loops kept writing to the same persistent connector <path>
//      elements — fixed with a generation counter that cancels a stale
//      loop the moment a newer render starts one (see
//      ganttReorderGeneration in gantt.ts).
//   2. The winning loop's own first frame mixed a viewport-absolute
//      "old position" with a grid-relative "final position" AND
//      approximated the CSS ease-out curve with the wrong bezier shape —
//      together these made the connector visibly snap backward right at
//      the handoff between the two loops, even with (1) fixed.
test('two overlapping renders do not make the connector jump backward', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => switchTabMorphed('gantt'));
  await page.waitForFunction(() => getActiveTab() === 'gantt');
  await page.waitForTimeout(1500);

  const setup = await page.evaluate(() => {
    const jobA = jobs[0];
    const jobB = jobs[1];
    splitJobIntoPhases(jobA);
    const phase1 = getJobPhases(jobA)[0];
    addJobPhase(jobA);
    const phase2 = getJobPhases(jobA)[1];
    (phase1.tasks || []).forEach(t => { t.start = '2026-09-01'; t.finish = '2026-09-03'; });
    (phase2.tasks || []).forEach(t => { t.start = '2026-09-05'; t.finish = '2026-09-07'; });
    const subB = getPhaseSubUnits(getJobPhases(jobB)[0])[0];
    (subB.tasks || []).forEach(t => { t.start = '2026-09-20'; t.finish = '2026-09-22'; });
    renderGantt();
    return { jobAId: jobA.id, phase2Id: phase2.id };
  });

  const result = await page.evaluate(({ jobAId, phase2Id }) => {
    return new Promise((resolve) => {
      const jobA = jobs.find(j => j.id === jobAId);
      const phase2 = getJobPhases(jobA).find(p => p.id === phase2Id);

      // Render #1 — reorders phase2 past phase1, starting an animation and
      // its own connector-tracking loop.
      (phase2.tasks || []).forEach(t => { t.start = '2026-09-25'; t.finish = '2026-09-27'; });
      renderGantt();

      const samples = [];
      const t0 = performance.now();

      // Render #2 — an "interrupting echo" of the SAME final data, fired
      // partway through render #1's own animation, simulating the sync
      // layer's confirmation snapshot landing mid-flight (see this file's
      // own header comment). This starts a second, independent connector
      // loop unless generation cancellation stops the first one.
      setTimeout(function () { renderGantt(); }, 200);

      function sample() {
        const path = document.querySelector('#ganttConnectorSvg path[data-job-id="' + jobAId + '"][data-pair-index="0"]');
        if (path) {
          const d = path.getAttribute('d');
          // "M x1 y1 L midX y1 L midX y2 L x2 y2" — y2 (index 5) is the
          // moving phase2 endpoint.
          const nums = d.split(/[ML,\s]+/).filter(Boolean).map(Number);
          samples.push({ t: Math.round(performance.now() - t0), y2: nums[5] });
        }
        if (performance.now() - t0 < 1400) requestAnimationFrame(sample);
        else resolve(samples);
      }
      requestAnimationFrame(sample);
    });
  }, setup);

  // The connector should only ever move toward its final value. Two
  // independent requestAnimationFrame loops sampling performance.now()
  // introduce a little unavoidable timing jitter at the exact instant one
  // loop cancels the other, so allow a sub-pixel tolerance rather than
  // demanding a mathematically perfect zero.
  let maxBackwardStep = 0;
  for (let i = 1; i < result.length; i++) {
    maxBackwardStep = Math.min(maxBackwardStep, result[i].y2 - result[i - 1].y2);
  }
  expect(maxBackwardStep).toBeGreaterThan(-2);
});
