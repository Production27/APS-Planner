const { test, expect } = require('@playwright/test');
const fs = require('fs');
const { APP_URL, seedSession, mockRoomWebSocket } = require('./helpers');

// Export to spreadsheet (src/app/export.ts), driven through the real
// settings menu → dialog → download, then the file itself is read back.

async function openApp(page) {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
}

async function exportCsv(page, kind, includeArchived) {
  await page.evaluate(() => toggleSettingsMenu());
  await page.locator('#exportSpreadsheetBtn').click();
  await page.locator(kind === 'tasks' ? '#exportKindTasks' : '#exportKindJobs').check();
  await page.locator('#exportIncludeArchived').setChecked(!!includeArchived);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#exportRunBtn').click()]);
  const text = fs.readFileSync(await dl.path(), 'utf8');
  return { name: dl.suggestedFilename(), text };
}

test('export jobs: CSV has a BOM, quotes commas/quotes, neutralizes formulas, and skips archived jobs by default', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    jobs[0].name = 'Stolp Residence, "North" addition';
    jobs[1].name = '=HYPERLINK("http://example.com")';
    jobs[2].name = 'Archived Barn';
    jobs[2].archived = true;
  });

  const { name, text } = await exportCsv(page, 'jobs', false);
  expect(name).toMatch(/ - Jobs - \d{4}-\d{2}-\d{2}\.csv$/);
  expect(text.charCodeAt(0)).toBe(0xFEFF);
  const body = text.slice(1);
  expect(body.split('\r\n')[0]).toBe('Job,Stage,Start,Finish,Days,Due date,Customer,Job / P.O. number,Location,Job type,Timeframe,Project manager,Foreman,Members,Comments,Archived');
  expect(body).toContain('"Stolp Residence, ""North"" addition"');
  expect(body).toContain('"\'=HYPERLINK(""http://example.com"")"');
  expect(body).not.toContain('Archived Barn');

  const withArchived = await exportCsv(page, 'jobs', true);
  expect(withArchived.text).toContain('Archived Barn');
});

test('export tasks: one row per dated task with inclusive day counts; unscheduled task slots are skipped', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    const j = jobs[0];
    j.name = 'Export Test Job';
    delete j.phases;
    j.tasks = [
      { id: 'x1', name: 'Design', order: 0, start: '2026-09-20', finish: '2026-09-24', notes: 'Line 1\nLine 2' },
      { id: 'x2', name: 'Panel', order: 1, start: '2026-09-25', finish: '2026-09-25' },
      { id: 'x3', name: 'Cut', order: 2, start: '', finish: '' },
    ];
  });

  const { text } = await exportCsv(page, 'tasks', false);
  const body = text.slice(1);
  expect(body).toContain('Export Test Job,,,Design,2026-09-20,2026-09-24,5,');
  expect(body).toContain('"Line 1\nLine 2"');
  expect(body).toContain('Export Test Job,,,Panel,2026-09-25,2026-09-25,1,');
  expect(body).not.toMatch(/Export Test Job,,,Cut,/);
});
