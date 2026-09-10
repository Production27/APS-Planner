const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');

const FIXTURE_URL = pathToFileURL(path.resolve(__dirname, 'unit-fixture.html')).toString();

// Direct unit tests for the checklist core primitives extracted to
// src/views/checklist.ts's Phase CL-a (against the REAL built bundle,
// same approach as tests/unit-presence.spec.js).

test('ensureCardChecklists: migrates a legacy flat card.checklist into card.checklists keyed by the card\'s current column', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    const card = { id: 'c1', column: 'active', checklist: [{ id: 'i1', text: 'Pour footing', done: false }] };
    ensureCardChecklists(card);
    return { checklists: card.checklists, hasLegacyField: 'checklist' in card };
  });
  expect(result.checklists).toEqual({ active: [{ id: 'i1', text: 'Pour footing', done: false }] });
  expect(result.hasLegacyField).toBe(false);
});

test('ensureCardChecklists: a card with no legacy checklist just gets an empty checklists map', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    const card = { id: 'c2', column: 'bid' };
    ensureCardChecklists(card);
    return card.checklists;
  });
  expect(result).toEqual({});
});

test('ensureCardChecklists: idempotent — a card that already has checklists is left untouched', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    const card = { id: 'c3', column: 'active', checklists: { bid: [{ id: 'x', text: 'keep me' }] }, checklist: [{ id: 'stray', text: 'should be ignored' }] };
    ensureCardChecklists(card);
    return card.checklists;
  });
  expect(result).toEqual({ bid: [{ id: 'x', text: 'keep me' }] });
});

test('normalizeChecklistAssignees: passes arrays through, wraps a single value, empty/null/undefined become []', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => ({
    array: normalizeChecklistAssignees(['a', 'b']),
    single: normalizeChecklistAssignees('solo'),
    empty: normalizeChecklistAssignees(''),
    nullVal: normalizeChecklistAssignees(null),
    undef: normalizeChecklistAssignees(undefined),
  }));
  expect(result).toEqual({ array: ['a', 'b'], single: ['solo'], empty: [], nullVal: [], undef: [] });
});

test('isChecklistStageVisibleToMe: no assignees on the stage means everyone can see it', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    getEffectiveRole = () => 'member';
    getStoredUsername = () => 'alice';
    viewAsUsername = null;
    return isChecklistStageVisibleToMe({}, 'active');
  });
  expect(result).toBe(true);
});

test('isChecklistStageVisibleToMe: a stage restricted to specific usernames hides from everyone else, but is visible to a matching username', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    getEffectiveRole = () => 'member';
    viewAsUsername = null;
    const assignees = { active: ['alice', 'bob'] };
    getStoredUsername = () => 'carol';
    const carolSees = isChecklistStageVisibleToMe(assignees, 'active');
    getStoredUsername = () => 'bob';
    const bobSees = isChecklistStageVisibleToMe(assignees, 'active');
    return { carolSees, bobSees };
  });
  expect(result).toEqual({ carolSees: false, bobSees: true });
});

test('isChecklistStageVisibleToMe: an admin bypasses a restricted stage even when not in the assignee list', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    getEffectiveRole = () => 'admin';
    getStoredUsername = () => 'zoe';
    viewAsUsername = null;
    return isChecklistStageVisibleToMe({ active: ['alice'] }, 'active');
  });
  expect(result).toBe(true);
});

test('isChecklistStageVisibleToMe: while "viewing as" someone, visibility resolves against the simulated username, not the real admin\'s', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    getEffectiveRole = () => 'member'; // simulated account's role, per hasMinTier()'s own View As convention
    getStoredUsername = () => 'realadmin';
    viewAsUsername = 'alice';
    return isChecklistStageVisibleToMe({ active: ['alice'] }, 'active');
  });
  expect(result).toBe(true);
});
