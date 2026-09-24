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
  // The "New here?" tour prompt fades in after a delay; a scan that lands
  // mid-fade reads its text at partial opacity. Same flag "Don't ask again" sets.
  await page.addInitScript(() => { try { localStorage.setItem('gantt_tutorial_state_v1_testadmin', JSON.stringify({ neverShow: true })); } catch (e) {} });
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
  'tour prompt': () => { switchTabMorphed('home'); tutorialNotifShow(); },
  'board column menu': () => { switchTabMorphed('board'); document.querySelector('.board-col-settings-btn').click(); },
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

test('a11y: a Board column menu works from the keyboard, and Move right reorders boards without dragging', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => switchTabMorphed('board'));
  const first = await page.evaluate(() => BOARD_COLUMNS.map((c) => c.id));
  const btn = page.locator('.board-column[data-column="' + first[0] + '"] .board-col-settings-btn');
  await btn.focus();
  await page.keyboard.press('Enter');
  await expect(btn).toHaveAttribute('aria-expanded', 'true');
  expect(await page.evaluate((id) => document.getElementById('col-settings-' + id).contains(document.activeElement), first[0])).toBe(true);
  await page.keyboard.press('Escape');
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
  await expect(btn).toBeFocused();

  await btn.click();
  await page.locator('#col-settings-' + first[0] + ' button', { hasText: 'Move right' }).click();
  const after = await page.evaluate(() => BOARD_COLUMNS.map((c) => c.id));
  expect(after).toEqual([first[1], first[0]].concat(first.slice(2)));
  await expect(page.locator('.board-column[data-column="' + first[0] + '"] .board-col-settings-btn')).toBeFocused();
  // The first board has no "Move left"; the last has no "Move right".
  expect(await page.locator('#col-settings-' + first[1] + ' button', { hasText: 'Move left' }).count()).toBe(0);
});

test('a11y: the card dialog\'s Board dropdown moves a card without dragging', async ({ page }) => {
  await openApp(page);
  page.on('dialog', (d) => d.accept());
  const { cardId, target } = await page.evaluate(() => {
    switchTabMorphed('board');
    const card = boardCards.find((c) => isCardVisibleToMe(c));
    const target = BOARD_COLUMNS.find((c) => c.id !== card.column).id;
    openEditCard(card.id);
    return { cardId: card.id, target };
  });
  await expect(page.locator('#c_column')).toHaveValue(await page.evaluate((id) => boardCards.find((c) => c.id === id).column, cardId));
  await page.locator('#c_column').selectOption(target);
  expect(await page.evaluate((id) => boardCards.find((c) => c.id === id).column, cardId)).toBe(target);
});

test('a11y: the first Tab reaches "Skip to main content", which jumps focus to the current tab', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
  await page.keyboard.press('Tab');
  await expect(page.locator('.skip-link')).toBeFocused();
  await expect(page.locator('.skip-link')).toBeInViewport();
  await page.keyboard.press('Enter');
  await expect(page.locator('#panelsContainer')).toBeFocused();
  await expect(page.locator('.rail-tab[aria-current="page"], .rail-tab.active')).toHaveCount(await page.locator('.rail-tab.active').count());
});
