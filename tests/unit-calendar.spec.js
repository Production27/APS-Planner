const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');

const FIXTURE_URL = pathToFileURL(path.resolve(__dirname, 'unit-fixture.html')).toString();

// Direct unit tests for the calendar-event recurrence/visibility layer
// extracted to src/views/calendar.ts in Phase 5 of the architecture
// roadmap — against the REAL built bundle (same approach as
// tests/unit-utils.spec.js and tests/unit-models.spec.js).

test('getCalendarEventOccurrences: a non-repeating event yields exactly one occurrence', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    const evt = { id: 'e1', title: 'One-off', start: '2026-09-15', duration: 1 };
    return getCalendarEventOccurrences(evt, null, null).map((o) => ({ start: toIsoDate(o.start), finish: toIsoDate(o.finish) }));
  });
  expect(result).toEqual([{ start: '2026-09-15', finish: '2026-09-15' }]);
});

test('getCalendarEventOccurrences: weekly repeat expands within range and stops at repeatUntil', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    const evt = { id: 'e2', title: 'Weekly', start: '2026-09-01', repeat: 'weekly', repeatUntil: '2026-09-22', duration: 1 };
    return getCalendarEventOccurrences(evt, new Date('2026-09-01T00:00:00'), new Date('2026-12-31T00:00:00')).map((o) => toIsoDate(o.start));
  });
  // Sep 1, 8, 15, 22 — stops at repeatUntil, doesn't overshoot into Sep 29.
  expect(result).toEqual(['2026-09-01', '2026-09-08', '2026-09-15', '2026-09-22']);
});

test('getCalendarEventOccurrences: monthly repeat clamps at short months, and stays clamped (reuses addMonths)', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    const evt = { id: 'e3', title: 'Monthly on the 31st', start: '2026-08-31', repeat: 'monthly', repeatUntil: '2026-10-31', duration: 1 };
    return getCalendarEventOccurrences(evt, null, null).map((o) => toIsoDate(o.start));
  });
  // Aug 31 -> Sep 30 (clamped, Sep has 30 days) -> Oct 30, NOT Oct 31: each
  // step's own addMonths() call uses the PREVIOUS (already-clamped) date as
  // its anchor, so once the series clamps down to the 30th it stays there
  // for every later month, even one (October) that itself has 31 days —
  // real, verified behavior of the iterative cursor = addMonths(cursor, 1)
  // pattern below, not a bug.
  expect(result).toEqual(['2026-08-31', '2026-09-30', '2026-10-30']);
});

test('getCalendarEventOccurrences: a per-occurrence exception can skip, move, or resize one instance without affecting the series', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    const evt = {
      id: 'e4', title: 'Daily', start: '2026-09-01', repeat: 'daily', repeatUntil: '2026-09-04', duration: 1,
      exceptions: {
        '2026-09-02': { skip: true },
        '2026-09-03': { start: '2026-09-10', duration: 2 },
      },
    };
    return getCalendarEventOccurrences(evt, null, null).map((o) => ({ sourceDate: o.sourceDate, start: toIsoDate(o.start), finish: toIsoDate(o.finish) }));
  });
  expect(result).toEqual([
    { sourceDate: '2026-09-01', start: '2026-09-01', finish: '2026-09-01' },
    // 09-02 skipped entirely
    { sourceDate: '2026-09-03', start: '2026-09-10', finish: '2026-09-11' }, // moved + extended to 2 days
    { sourceDate: '2026-09-04', start: '2026-09-04', finish: '2026-09-04' },
  ]);
});

test('isCalendarEventVisibleToMe: private and members-only visibility gate correctly, all/projectAdmin bypass', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    // Stub the ambient globals isCalendarEventVisibleToMe() depends on —
    // this fixture has no real app/session state, only the bundle.
    window.getEffectiveRole = () => window.__role || 'member';
    window.getStoredUsername = () => 'alice';
    viewAsUsername = null;

    const privateEvt = { visibility: 'private', createdBy: 'bob' };
    const membersEvt = { visibility: 'members', visibleMembers: ['alice', 'carol'] };
    const allEvt = { visibility: 'all' };

    window.__role = 'member';
    const aliceSeesBobsPrivate = isCalendarEventVisibleToMe(privateEvt);
    const aliceSeesOwnMembersList = isCalendarEventVisibleToMe(membersEvt);

    window.__role = 'projectAdmin';
    const projectAdminBypassesPrivate = isCalendarEventVisibleToMe(privateEvt);

    return {
      aliceSeesBobsPrivate,
      aliceSeesOwnMembersList,
      projectAdminBypassesPrivate,
      allAlwaysVisible: isCalendarEventVisibleToMe(allEvt),
      nullEventNotVisible: isCalendarEventVisibleToMe(null),
    };
  });
  expect(result.aliceSeesBobsPrivate).toBe(false);
  expect(result.aliceSeesOwnMembersList).toBe(true);
  expect(result.projectAdminBypassesPrivate).toBe(true);
  expect(result.allAlwaysVisible).toBe(true);
  expect(result.nullEventNotVisible).toBe(false);
});

test('ensureCalendarEventIds: backfills id/repeat/duration/exceptions/color defaults without touching existing values', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    const events = [
      { title: 'Blank slate' },
      { title: 'Already set', id: 'keep-me', repeat: 'weekly', duration: 3, color: '#123456' },
    ];
    ensureCalendarEventIds(events);
    return events;
  });
  expect(result[0].id).toBeTruthy();
  expect(result[0].repeat).toBe('none');
  expect(result[0].duration).toBe(1);
  expect(result[0].exceptions).toEqual({});
  expect(result[0].color).toBe('#7e57c2');
  // Existing values on the second event are untouched.
  expect(result[1].id).toBe('keep-me');
  expect(result[1].repeat).toBe('weekly');
  expect(result[1].duration).toBe(3);
  expect(result[1].color).toBe('#123456');
});
