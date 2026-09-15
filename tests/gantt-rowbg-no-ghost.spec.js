const { test, expect } = require('@playwright/test');
const { APP_URL, seedSession, mockRoomWebSocket } = require('./helpers');

// Regression test for a real visible "ghost bar" reported via a screenshot:
// during a cascading Gantt reorder (dragging one row displaces several
// others), a light gray rectangle appeared to trail behind rows that were
// moving. .row-bg (src/views/gantt.ts) is the alternating zebra-stripe
// background band — full page width, a full 40px row tall (taller than the
// bar's own shorter, inset pill) and opaque — and it used to animate along
// with everything else sharing its row's key. When several rows swap
// places at once, two of these full-size opaque bands are, for a moment,
// both still animating through the same stretch of screen the other is
// vacating or approaching, which reads as an obvious gray ghost sitting
// behind the real, narrower bars. Fixed by not giving .row-bg a
// dataset.rowKey at all, so it's never part of the animated set and always
// just renders at its own correct final position immediately — unlike
// .task-row (the sidebar label), it carries no identity a viewer needs to
// track across the move.
test('row-bg never animates during a multi-row cascade (no ghosting)', async ({ page }) => {
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

      let sawAnyRowBgTransform = false;
      let sawAnyRealTransform = false;
      const t0 = performance.now();

      function sample() {
        document.querySelectorAll('.row-bg').forEach(function (el) {
          const t = el.style.transform;
          if (t && t !== 'none' && t !== 'translateY(0px)') sawAnyRowBgTransform = true;
        });
        document.querySelectorAll('.task-bar, .task-row').forEach(function (el) {
          const t = el.style.transform;
          if (t && t !== 'none' && t !== 'translateY(0px)') sawAnyRealTransform = true;
        });
        if (performance.now() - t0 < 900) requestAnimationFrame(sample);
        else resolve({ sawAnyRowBgTransform, sawAnyRealTransform });
      }
      requestAnimationFrame(sample);
    });
  }, setup);

  console.log(JSON.stringify(result));
  // The actual bars/labels SHOULD be animating (proves this test scenario
  // triggers a real reorder) — but .row-bg must never get a transform.
  expect(result.sawAnyRealTransform).toBe(true);
  expect(result.sawAnyRowBgTransform).toBe(false);
});
