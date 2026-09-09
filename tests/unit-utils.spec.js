const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');

const FIXTURE_URL = pathToFileURL(path.resolve(__dirname, 'unit-fixture.html')).toString();

// Direct unit tests for the pure utilities extracted to src/utils/ in
// Phase 2 of the architecture roadmap — loaded against the REAL built
// bundle (tests/unit-fixture.html), not a reimplementation, so these
// exercise exactly what index.html itself ships. Run `npm run build`
// first if dist/app.bundle.js doesn't exist yet.

test('genId: produces a non-empty string, different each call', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const [a, b] = await page.evaluate(() => [genId(), genId()]);
  expect(typeof a).toBe('string');
  expect(a.length).toBeGreaterThan(0);
  expect(a).not.toBe(b);
});

test('safeJsonParse: valid JSON parses, invalid JSON returns the fallback', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => ({
    valid: safeJsonParse('{"a":1}', null),
    invalid: safeJsonParse('not json', 'fallback-value'),
    // JSON.parse(null) coerces to the string "null" and parses fine (to
    // the JS value null) rather than throwing — so this hits the try
    // branch, not the fallback. Existing behavior, unchanged by the move.
    nullInput: safeJsonParse(null, 'fallback-for-null'),
  }));
  expect(result.valid).toEqual({ a: 1 });
  expect(result.invalid).toBe('fallback-value');
  expect(result.nullInput).toBeNull();
});

test('getDaysDiff: whole-day difference between two dates', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const diff = await page.evaluate(() => getDaysDiff(new Date('2026-09-01T00:00:00'), new Date('2026-09-05T00:00:00')));
  expect(diff).toBe(4);
});

// Pins the historical UTC-vs-local bug documented on toIsoDate() itself:
// a UTC-AHEAD timezone is exactly the scenario that used to silently save
// a date one day earlier than what was shown on screen. Uses its own
// browser context (not the shared `page` fixture) so only this test runs
// under the non-default timezone.
test('toIsoDate: formats using local date components, not UTC (regression pin)', async ({ browser }) => {
  const context = await browser.newContext({ timezoneId: 'Australia/Sydney' }); // UTC+10/+11 — historically the broken case
  const page = await context.newPage();
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => toIsoDate(new Date('2026-09-01T00:00:00')));
  await context.close();
  expect(result).toBe('2026-09-01');
});

// Pins the historical month-overflow bug documented on addMonths() itself:
// Aug 31 + 1 month must clamp to Sep 30, not silently overflow into Oct 1.
test('addMonths: clamps to the target month\'s last day instead of overflowing (regression pin)', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    const d = addMonths(new Date('2026-08-31T00:00:00'), 1);
    return toIsoDate(d);
  });
  expect(result).toBe('2026-09-30');
});

test('addMonths: an ordinary month with no overflow just adds normally', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => toIsoDate(addMonths(new Date('2026-06-15T00:00:00'), 2)));
  expect(result).toBe('2026-08-15');
});

test('getBusinessDaysDiff/addBusinessDays: weekends are excluded', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    // Mon Aug 31 2026 -> Fri Sep 4 2026: 5 business days (Mon-Fri), no weekend in between.
    const diff = getBusinessDaysDiff(new Date('2026-08-31T00:00:00'), new Date('2026-09-04T00:00:00'));
    // addBusinessDays() counts the start date itself as day 1: from Fri
    // Sep 4 2026, day 1 = Fri 4th, day 2 = Mon 7th (skipping the
    // weekend), day 3 = Tue 8th.
    const added = toIsoDate(addBusinessDays(new Date('2026-09-04T00:00:00'), 3));
    return { diff, added };
  });
  expect(result.diff).toBe(5);
  expect(result.added).toBe('2026-09-08');
});

test('formatTimeLabel/timeToMinutes: 24h <-> 12h/minutes conversions', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => ({
    noon: formatTimeLabel('12:00'),
    midnight: formatTimeLabel('00:30'),
    afternoon: formatTimeLabel('14:30'),
    empty: formatTimeLabel(''),
    minutes: timeToMinutes('14:30'),
    invalidMinutes: timeToMinutes('not-a-time'),
  }));
  expect(result.noon).toBe('12:00 PM');
  expect(result.midnight).toBe('12:30 AM');
  expect(result.afternoon).toBe('2:30 PM');
  expect(result.empty).toBe('');
  expect(result.minutes).toBe(870);
  expect(result.invalidMinutes).toBeNull();
});

test('darkenColor/softenColor: move toward black/white respectively', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => ({
    darkened: darkenColor('#3949ab', 0.5),
    softened: softenColor('#3949ab', 0.5),
    fullSoften: softenColor('#000000', 1),
  }));
  expect(result.darkened).toBe('rgb(29,37,86)'); // half of 0x39/0x49/0xab, rounded
  expect(result.softened.toLowerCase()).toBe('#9ca4d5'); // halfway toward white
  expect(result.fullSoften.toLowerCase()).toBe('#ffffff'); // amount:1 reaches pure white
});
