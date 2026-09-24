const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { APP_URL, seedSession, mockRoomWebSocket } = require('./helpers');

// Accessibility regression checks (roadmap A5). axe runs the WCAG 2.2 A/AA
// rules on every main screen in both themes; any violation fails the test.
//
// Two known, documented exceptions to WCAG 2.5.8 (Target Size) are left out
// of the target-size rule only: the 20px-tall Calendar bars and the 18px
// Gantt due-date circle. Both open or change something that has another,
// full-size way in (the job list, and the job form's Due Date field), which
// 2.5.8's "equivalent" exception allows. Everything else is checked.
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const TARGET_SIZE_EXCEPTIONS = ['.cal-event-bar', '.job-span-due-marker'];

async function openApp(page, { dark } = {}) {
  await seedSession(page, { role: 'admin' });
  await page.addInitScript(() => { try { localStorage.setItem('onboarding_dismissed_v1', '1'); } catch (e) {} });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  if (dark) await page.evaluate(() => { if (!document.body.classList.contains('dark-mode')) toggleDarkMode(); });
}

async function axeViolations(page) {
  const main = await new AxeBuilder({ page }).withTags(TAGS).disableRules(['target-size']).analyze();
  let sized = new AxeBuilder({ page }).withTags(TAGS).withRules(['target-size']);
  for (const sel of TARGET_SIZE_EXCEPTIONS) sized = sized.exclude(sel);
  const size = await sized.analyze();
  return main.violations.concat(size.violations).map((v) => ({
    rule: v.id, help: v.help, nodes: v.nodes.slice(0, 5).map((n) => n.target.join(' ')),
  }));
}

const SCREENS = {
  home: () => switchTabMorphed('home'),
  gantt: () => switchTabMorphed('gantt'),
  board: () => switchTabMorphed('board'),
  calendar: () => switchTabMorphed('calendar'),
  checklist: () => switchTabMorphed('checklist'),
  reports: () => switchTabMorphed('reports'),
  'job form': () => { switchTabMorphed('gantt'); editJob(jobs.find((j) => !j.archived).id); },
  'card dialog': () => { switchTabMorphed('board'); openEditCard(boardCards.find((c) => isCardVisibleToMe(c)).id); },
  'settings menu': () => { switchTabMorphed('home'); toggleSettingsMenu(); },
  'calendar event dialog': () => { switchTabMorphed('calendar'); openAddCalendarEvent('2026-09-24'); },
};

for (const dark of [false, true]) {
  for (const [name, go] of Object.entries(SCREENS)) {
    test('a11y: ' + name + (dark ? ' (dark)' : '') + ' has no WCAG A/AA violations', async ({ page }) => {
      await openApp(page, { dark });
      await page.evaluate(go);
      await page.waitForTimeout(400);
      expect(await axeViolations(page)).toEqual([]);
    });
  }
}

test('a11y: a dialog takes focus, keeps Tab inside, closes on Escape and returns focus', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => switchTabMorphed('home'));
  // Open the Archived Jobs dialog from a known, focused element.
  await page.evaluate(() => { const b = document.getElementById('desktopSettingsBtn'); b.focus(); openArchivedJobsModal(); });
  const box = page.locator('#archivedJobsModal .modal-box');
  await expect(box).toHaveAttribute('role', 'dialog');
  await expect(box).toHaveAttribute('aria-modal', 'true');
  expect(await box.evaluate((el) => el.contains(document.activeElement))).toBe(true);

  for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
  expect(await box.evaluate((el) => el.contains(document.activeElement))).toBe(true);

  await page.keyboard.press('Escape');
  await expect(page.locator('#archivedJobsModal')).not.toHaveClass(/show/);
  await expect(page.locator('#desktopSettingsBtn')).toBeFocused();
});

test('a11y: Escape in the Security dialog closes it and never presses "Cancel deletion"', async ({ page }) => {
  await openApp(page);
  const clicked = await page.evaluate(() => {
    const hits = [];
    document.getElementById('deletionCancelBtn').addEventListener('click', () => hits.push('cancel-deletion'));
    document.getElementById('deletionCancelBtn').style.display = '';
    openModal('securityModal');
    return hits;
  });
  await page.keyboard.press('Escape');
  await expect(page.locator('#securityModal')).not.toHaveClass(/show/);
  expect(clicked).toEqual([]);
});

test('a11y: the Settings menu opened from the keyboard moves focus into it, and Escape returns it', async ({ page }) => {
  await openApp(page);
  await page.locator('#desktopSettingsBtn').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#settingsDropdown')).toHaveClass(/show/);
  await expect(page.locator('#desktopSettingsBtn')).toHaveAttribute('aria-expanded', 'true');
  expect(await page.evaluate(() => document.activeElement.classList.contains('settings-dropdown-item'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('#settingsDropdown')).not.toHaveClass(/show/);
  await expect(page.locator('#desktopSettingsBtn')).toBeFocused();
  await expect(page.locator('#desktopSettingsBtn')).toHaveAttribute('aria-expanded', 'false');
});

test('a11y: job cards and Board cards open from the keyboard through their title button', async ({ page }) => {
  await openApp(page);
  const job = page.locator('#jobList .job-card button.job-card-title').first();
  await job.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#jobList .job-card.active')).toHaveCount(1);

  await page.evaluate(() => { cancelEdit(); switchTabMorphed('board'); });
  const card = page.locator('.board-card button.board-card-title').first();
  await card.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#cardModal')).toHaveClass(/show/);
});
