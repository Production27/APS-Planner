const { test, expect } = require('@playwright/test');
const { APP_URL, seedSession, mockRoomWebSocket } = require('./helpers');

// Regression test for a live-drag desync in the Jobs/Leads condensed view
// (src/views/gantt.ts's startBarMove()). A phase collapsed into one row
// that folds several real sub-phases together (collapsedPhaseIds) draws
// one colored .job-span-task-solid segment per sub-phase, all inside one
// shared .job-span-border outline — but the border carries the ROW's own
// subPhaseId (null, standing for "all of them"), while each segment
// carries its OWN task's real, specific subPhaseId. startBarMove() used to
// scope which overlay pieces move together during a drag by matching that
// (phaseId, subPhaseId) tuple, so dragging one specific segment moved it
// (and same-subphase siblings) but left the border behind — a real,
// visible "duplicate bar": the row's own outline sitting apart from its
// own colored segment mid-drag (reported via a screenshot showing exactly
// this — a white-bordered box overlapping a colored segment at a
// different position). Fixed by matching on rowKey instead, which every
// piece of one visual row already shares regardless of which specific
// task or sub-phase it individually represents.
test('dragging one segment of a collapsed multi-subphase row moves its border with it', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => switchTabMorphed('gantt'));
  await page.waitForFunction(() => getActiveTab() === 'gantt');
  await page.waitForTimeout(1500);

  const setup = await page.evaluate(() => {
    const jobA = jobs[0];
    splitJobIntoPhases(jobA);
    const phase = getJobPhases(jobA)[0];
    splitPhaseIntoSubPhases(phase);
    addPhaseSubUnit(phase);
    const subUnits = getPhaseSubUnits(phase);
    (subUnits[0].tasks || []).forEach(t => { t.start = '2026-09-01'; t.finish = '2026-09-05'; t.color = '#e53935'; });
    (subUnits[1].tasks || []).forEach(t => { t.start = '2026-09-08'; t.finish = '2026-09-12'; t.color = '#1e88e5'; });
    collapsedPhaseIds.add(phase.id);
    renderGantt();
    return { jobId: jobA.id, phaseId: phase.id };
  });

  const dragResult = await page.evaluate(({ phaseId }) => {
    return new Promise((resolve) => {
      const solids = Array.from(document.querySelectorAll('.job-span-task-solid')).filter(el => el.dataset.phaseId === phaseId);
      // The SECOND segment specifically — its own dataset.subPhaseId is a
      // real id that differs from the border's own '' (see this file's
      // own header comment), which is exactly the case the old matching
      // logic got wrong.
      const target = solids[1] || solids[0];
      const border = Array.from(document.querySelectorAll('.job-span-border')).filter(el => el.dataset.phaseId === phaseId)[0];
      const rect = target.getBoundingClientRect();
      const borderLeftBefore = parseFloat(border.style.left);
      const solidLeftBefore = parseFloat(target.style.left);

      target.dispatchEvent(new MouseEvent('mousedown', { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, bubbles: true }));
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: rect.left + rect.width / 2 + 60, clientY: rect.top + rect.height / 2, bubbles: true }));

      // applyBarMoveMove() is rAF-coalesced (see onBarMoveMove()'s own
      // comment) — its DOM writes land on the next animation frame, not
      // synchronously on dispatch.
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          const borderLeftDuring = parseFloat(border.style.left);
          const solidLeftDuring = parseFloat(target.style.left);
          document.dispatchEvent(new MouseEvent('mouseup', { clientX: rect.left + rect.width / 2 + 60, clientY: rect.top + rect.height / 2, bubbles: true }));
          resolve({
            solidDelta: solidLeftDuring - solidLeftBefore,
            borderDelta: borderLeftDuring - borderLeftBefore,
          });
        });
      });
    });
  }, setup);

  expect(Math.abs(dragResult.solidDelta)).toBeGreaterThan(10);
  expect(Math.abs(dragResult.borderDelta - dragResult.solidDelta)).toBeLessThan(1);
});
