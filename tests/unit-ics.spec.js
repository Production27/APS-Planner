const { test, expect } = require('@playwright/test');
const fs = require('fs');
const { APP_URL, seedSession, mockRoomWebSocket } = require('./helpers');

// Calendar file download (src/app/ics.ts), through the real menu item.

test('ics: tasks become all-day events, repeating events expand, text is escaped and lines folded', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => {
    const d = (o) => { const x = new Date(); x.setDate(x.getDate() + o); return toIsoDate(x); };
    const j = jobs[0];
    j.name = 'Stolp; Residence, North';
    delete j.phases;
    j.tasks = [{ id: 'k1', name: 'Design', order: 0, start: '2026-09-21', finish: '2026-09-23', notes: 'A very long note that keeps going so that the DESCRIPTION line has to be folded across several lines' }];
    calendarEvents.push({ id: 'evx', title: 'Safety meeting', start: d(1), time: '07:00', duration: 1, repeat: 'weekly', repeatUntil: d(15) });
  });

  await page.evaluate(() => toggleSettingsMenu());
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#downloadIcsBtn').click()]);
  expect(dl.suggestedFilename()).toMatch(/ - Schedule - \d{4}-\d{2}-\d{2}\.ics$/);
  const text = fs.readFileSync(await dl.path(), 'utf8');

  expect(text.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true); // no BOM
  expect(text.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
  expect(text).toContain('SUMMARY:Stolp\\; Residence\\, North — Design');
  expect(text).toContain('DTSTART;VALUE=DATE:20260921');
  expect(text).toContain('DTEND;VALUE=DATE:20260924'); // exclusive end
  expect(text).toMatch(/\r\n [^\r\n]/); // folded continuation line
  expect(text.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
  // weekly repeat over ~2 weeks → 3 occurrences, each a 1-hour timed event
  expect((text.match(/SUMMARY:Safety meeting/g) || []).length).toBe(3);
  expect(text).toMatch(/DTSTART:\d{8}T070000\r\nDTEND:\d{8}T080000/);
});
