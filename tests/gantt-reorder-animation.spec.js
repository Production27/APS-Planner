const { test, expect } = require('@playwright/test');
const { APP_URL, seedSession, mockRoomWebSocket } = require('./helpers');

// Regression tests for the Gantt reorder animation (src/views/gantt.ts).
// This app's own sync layer echoes every change back to its sender (see
// room-do.ts's broadcastSnapshot()), so a single user reorder routinely
// triggers two (or more) overlapping renderGantt() calls in quick
// succession. Several real bugs only ever showed up under exactly that
// overlap, fixed across a few rounds:
//   1. Two overlapping renders each started their own connector-line
//      tracking loop, both writing to the same persistent <path>
//      elements with their own independently-timed progress — whichever
//      loop's rAF callback landed last on a given frame "won" it, which
//      read as smooth motion interrupted by small backward jumps.
//   2. Once only one loop's writes could land, that loop's own first
//      frame still mixed a viewport-absolute "old position" with a
//      grid-relative "final position", and approximated the CSS ease-out
//      curve with the wrong bezier shape — together still enough to
//      visibly snap the connector at the handoff.
//   3. The bars themselves had a separate version of (1)/(2)'s root
//      cause: each render restarted the bar's CSS transition from
//      scratch, resetting its deceleration clock to zero — a bar that
//      was already most of the way there would suddenly crawl its last
//      few pixels out over another FULL animation duration, reading as a
//      stutter right at the handoff.
// The actual fix: bars and the connector both now read their live
// position out of one shared, persisted-across-renders map
// (barAnimOrigins) keyed by row, storing each row's ORIGINAL start time
// and position rather than a new one per render — an overlapping render
// only ever updates where a row is headed, never when its motion began,
// so two overlapping renders' loops compute the exact same value for the
// same row at the same instant instead of fighting over it.
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

test('two overlapping renders do not make a bar jump backward', async ({ page }) => {
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

      (phase2.tasks || []).forEach(t => { t.start = '2026-09-25'; t.finish = '2026-09-27'; });
      renderGantt();

      const rowKey = document.querySelector('[data-row-key*="' + phase2Id + '"]').dataset.rowKey;
      const samples = [];
      const t0 = performance.now();

      // Same overlap as the connector test above — an echo of the same
      // final data landing mid-flight.
      setTimeout(function () { renderGantt(); }, 200);

      function sample() {
        const el = document.querySelector('[data-row-key="' + rowKey + '"]');
        if (el) samples.push({ t: Math.round(performance.now() - t0), top: el.getBoundingClientRect().top });
        if (performance.now() - t0 < 1400) requestAnimationFrame(sample);
        else resolve(samples);
      }
      requestAnimationFrame(sample);
    });
  }, setup);

  let maxBackwardStep = 0;
  for (let i = 1; i < result.length; i++) {
    maxBackwardStep = Math.min(maxBackwardStep, result[i].top - result[i - 1].top);
  }
  expect(maxBackwardStep).toBeGreaterThan(-1);
});

// Regression test for a real "duplicate ghost bar" reported via a
// screenshot: during a Gantt reorder, a nearly-invisible shape appeared to
// trail behind the real, moving bars. A job-span row's actual .task-bar
// (its transparent, invisible-fill click-target underneath the colored
// border/segments — see renderTimelineBars()'s own comment) has its own
// base CSS rule (`.task-bar { transition: transform 0.15s, ... }`, meant
// for ordinary hover/drag feedback) that every OTHER piece of the row
// (.job-span-border, -solid, -hash, -tick) doesn't share. Without
// explicitly overriding that with `transition: none` before writing a
// fresh style.transform every animation frame, the browser's own 150ms
// transition took over each write instead of applying it immediately, so
// .task-bar spent the whole animation perpetually behind wherever it was
// actually supposed to be — chasing a target that kept moving out from
// under it a frame later. Its own faint 1px border and box-shadow (see its
// own CSS) made that lag just barely visible: "basically transparent...
// but I can tell when it moves" (Karl's own description).
test('a job-span bar\'s invisible click-target does not lag behind its own border during a reorder', async ({ page }) => {
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
      (phase2.tasks || []).forEach(t => { t.start = '2026-09-25'; t.finish = '2026-09-27'; });
      renderGantt();

      const rowKey = document.querySelector('.task-bar[data-row-key*="' + phase2Id + '"]').dataset.rowKey;
      const samples = [];
      const t0 = performance.now();

      function sample() {
        const bar = document.querySelector('.task-bar[data-row-key="' + rowKey + '"]');
        const border = document.querySelector('.job-span-border[data-row-key="' + rowKey + '"]');
        if (bar && border) {
          samples.push({ barTop: bar.getBoundingClientRect().top, borderTop: border.getBoundingClientRect().top });
        }
        if (performance.now() - t0 < 1400) requestAnimationFrame(sample);
        else resolve(samples);
      }
      requestAnimationFrame(sample);
    });
  }, setup);

  let maxDesync = 0;
  result.forEach(function (s) { maxDesync = Math.max(maxDesync, Math.abs(s.barTop - s.borderTop)); });
  expect(maxDesync).toBeLessThan(1);
});
