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
    // getEffectiveRole()/getStoredUsername() are real src/auth/ imports
    // now — this file's own bundled code holds a resolved reference to
    // them, so reassigning the bare identifier no longer redirects what
    // it calls. Drive the real underlying state instead: currentUserRole/
    // viewAsUsername/viewAsRole (still real index.html globals) and
    // localStorage (getStoredUsername()'s actual backing store).
    currentUserRole = 'member';
    localStorage.setItem('gantt_username_v1', 'alice');
    viewAsUsername = null;
    return isChecklistStageVisibleToMe({}, 'active');
  });
  expect(result).toBe(true);
});

test('isChecklistStageVisibleToMe: a stage restricted to specific usernames hides from everyone else, but is visible to a matching username', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    currentUserRole = 'member';
    viewAsUsername = null;
    const assignees = { active: ['alice', 'bob'] };
    localStorage.setItem('gantt_username_v1', 'carol');
    const carolSees = isChecklistStageVisibleToMe(assignees, 'active');
    localStorage.setItem('gantt_username_v1', 'bob');
    const bobSees = isChecklistStageVisibleToMe(assignees, 'active');
    return { carolSees, bobSees };
  });
  expect(result).toEqual({ carolSees: false, bobSees: true });
});

test('isChecklistStageVisibleToMe: an admin bypasses a restricted stage even when not in the assignee list', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    currentUserRole = 'admin';
    localStorage.setItem('gantt_username_v1', 'zoe');
    viewAsUsername = null;
    return isChecklistStageVisibleToMe({ active: ['alice'] }, 'active');
  });
  expect(result).toBe(true);
});

test('isChecklistStageVisibleToMe: while "viewing as" someone, visibility resolves against the simulated username, not the real admin\'s', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    viewAsRole = 'member'; // simulated account's role, per hasMinTier()'s own View As convention
    localStorage.setItem('gantt_username_v1', 'realadmin');
    viewAsUsername = 'alice';
    return isChecklistStageVisibleToMe({ active: ['alice'] }, 'active');
  });
  expect(result).toBe(true);
});

// Phase CL-b: Board's card-move gate.

test('getOpenChecklistItemsForCard: with no required items, every unfinished item (and sub-item) gates the move', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    currentUserRole = 'member';
    localStorage.setItem('gantt_username_v1', 'alice');
    viewAsUsername = null;
    BOARD_COLUMNS = [{ id: 'active', label: 'Active', defaultChecklist: [{ id: 'tmpl-1', text: 'Template item (not yet stored)' }] }];
    const card = {
      id: 'c1', column: 'active',
      checklists: { active: [
        { id: 'i1', text: 'Pour footing', done: false },
        { id: 'i2', text: 'Frame walls', done: true, subItems: [{ id: 's1', text: 'Order lumber', done: false }] },
      ] },
    };
    return getOpenChecklistItemsForCard(card);
  });
  expect(result).toEqual(['Pour footing', 'Frame walls → Order lumber', 'Template item (not yet stored)']);
});

test('getOpenChecklistItemsForCard: once any item is flagged required, only required items gate the move', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    currentUserRole = 'member';
    localStorage.setItem('gantt_username_v1', 'alice');
    viewAsUsername = null;
    BOARD_COLUMNS = [{ id: 'active', label: 'Active' }];
    const card = {
      id: 'c1', column: 'active',
      checklists: { active: [
        { id: 'i1', text: 'Not required, ignored once anything is required', done: false },
        { id: 'i2', text: 'Required and open', done: false, required: true },
      ] },
    };
    return getOpenChecklistItemsForCard(card);
  });
  expect(result).toEqual(['Required and open']);
});

test('getOpenChecklistItemsForCard: a stage hidden from the current user never gates the move', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    currentUserRole = 'member';
    localStorage.setItem('gantt_username_v1', 'someone-else');
    viewAsUsername = null;
    BOARD_COLUMNS = [{ id: 'active', label: 'Active' }];
    const card = {
      id: 'c1', column: 'active',
      checklistAssignees: { active: ['alice'] },
      checklists: { active: [{ id: 'i1', text: 'Open item', done: false }] },
    };
    return getOpenChecklistItemsForCard(card);
  });
  expect(result).toEqual([]);
});

// Phase CL-d: getChecklistForStageInProject() is a pure function of its
// own arguments (no ambient globals read), so it's tested directly here
// rather than against the real app.

test('getChecklistForStageInProject: materializes a column\'s default-checklist template into a fresh stage on first call', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    const checklists = {};
    const boardCols = [{ id: 'active', label: 'Active', defaultChecklist: [{ id: 'tmpl-1', text: 'Pour footing' }, { id: 'tmpl-2', text: 'Frame walls' }] }];
    return getChecklistForStageInProject(checklists, 'active', boardCols);
  });
  expect(result).toEqual([
    { id: 'tmpl-1', text: 'Pour footing', done: false, assignee: '' },
    { id: 'tmpl-2', text: 'Frame walls', done: false, assignee: '' },
  ]);
});

test('getChecklistForStageInProject: a second call does not duplicate already-materialized template items, and preserves edits made to them', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    const checklists = {};
    const boardCols = [{ id: 'active', label: 'Active', defaultChecklist: [{ id: 'tmpl-1', text: 'Pour footing' }] }];
    const first = getChecklistForStageInProject(checklists, 'active', boardCols);
    first[0].done = true; // simulate the user checking it off between calls
    const second = getChecklistForStageInProject(checklists, 'active', boardCols);
    return { length: second.length, done: second[0].done };
  });
  expect(result).toEqual({ length: 1, done: true });
});

test('getChecklistForStageInProject: a template item that was soft-deleted (removed:true) is not resurrected by a later call', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    const checklists = { active: [{ id: 'tmpl-1', text: 'Pour footing', done: false, removed: true }] };
    const boardCols = [{ id: 'active', label: 'Active', defaultChecklist: [{ id: 'tmpl-1', text: 'Pour footing' }] }];
    return getChecklistForStageInProject(checklists, 'active', boardCols);
  });
  expect(result).toEqual([{ id: 'tmpl-1', text: 'Pour footing', done: false, removed: true }]);
});
