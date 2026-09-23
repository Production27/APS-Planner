const { test, expect } = require('@playwright/test');
const { APP_URL, seedSession } = require('./helpers');

// A7 steps 3-4: the batched local copy in IndexedDB (saveProjects /
// flushProjectsToLocalCache in src/app/project.ts, src/app/local-store.ts),
// the Home Job Chat page size, the validated lookup indexes behind
// findJob()/getPhaseCard() (src/core/models.ts) and the shared date
// formatter (src/utils/date.ts).

// Like tests/helpers.js's mockRoomWebSocket(), plus an offline switch.
async function open(page) {
  await seedSession(page, { role: 'admin' });
  page.__room = { offline: false };
  await page.routeWebSocket(/\/room\?/, (ws) => {
    if (!page.__room.offline) ws.send(JSON.stringify({ type: 'snapshot', projects: {} }));
  });
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
}

// Reloads with the server not answering, so the app runs on its local copy
// alone (the offline case the copy exists for). With a server answering,
// the sample data these tests use is recognized as untouched starter
// content and replaced by the server's, whatever the local copy held.
async function reloadOffline(page) {
  page.__room.offline = true;
  await page.reload();
  await page.waitForFunction(() => typeof findJob === 'function' && typeof jobs !== 'undefined' && jobs.length > 0);
}

// Reads the IndexedDB copy directly (src/app/local-store.ts's record).
function idbGet(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const q = indexedDB.open('teamsync-local');
    q.onsuccess = () => { const g = q.result.transaction('kv').objectStore('kv').get('projects'); g.onsuccess = () => resolve(g.result || null); g.onerror = () => resolve(null); };
    q.onerror = () => resolve(null);
  }));
}
const LS_KEY = 'aps-planner:projects-v2';
const LS_AT_KEY = 'aps-planner:projects-v2-saved-at';

test('saves to the local copy are batched into IndexedDB, with a localStorage copy on page close', async ({ page }) => {
  await open(page);
  await page.evaluate(() => flushProjectsToLocalCache());
  await expect.poll(async () => !!(await idbGet(page))).toBe(true);
  await page.evaluate(() => { jobs[0].name = 'Batched Save Check'; saveActiveProject(); });
  expect((await idbGet(page)).text.includes('Batched Save Check')).toBe(false); // not written yet
  // The timer writes it shortly after, and clears any localStorage copy.
  await expect.poll(async () => (await idbGet(page)).text.includes('Batched Save Check')).toBe(true);
  expect(await page.evaluate((k) => localStorage.getItem(k), LS_KEY)).toBeNull();
  // A page close writes both right away.
  const closeWrite = await page.evaluate((k) => { jobs[0].name = 'Close Save Check'; saveActiveProject(); window.dispatchEvent(new Event('pagehide')); return (localStorage.getItem(k) || '').includes('Close Save Check'); }, LS_KEY);
  expect(closeWrite).toBe(true);
  await expect.poll(async () => (await idbGet(page)).text.includes('Close Save Check')).toBe(true);
});

test('an edit survives a reload through the IndexedDB copy', async ({ page }) => {
  await open(page);
  const id = await page.evaluate(() => { jobs[0].name = 'Survives Reload'; saveActiveProject(); flushProjectsToLocalCache(); return jobs[0].id; });
  await expect.poll(async () => (await idbGet(page)).text.includes('Survives Reload')).toBe(true);
  await reloadOffline(page);
  await expect.poll(() => page.evaluate((id) => { const f = typeof findJob === 'function' && findJob(id); return f ? f.job.name : null; }, id)).toBe('Survives Reload');
});

// The page's current projects with one job renamed, as JSON text.
function renamedProjectsText(page, id, name) {
  return page.evaluate(([id, name]) => {
    const p = JSON.parse(JSON.stringify(projects));
    Object.keys(p).forEach((pid) => (p[pid].jobs || []).forEach((j) => { if (j.id === id) j.name = name; }));
    return JSON.stringify(p);
  }, [id, name]);
}

// Plants local-copy state at the START of the next load, before the app
// boots. Planting it from the running page doesn't work: the reload is a
// page close, and the app's close-time save overwrites what was planted.
async function reloadOfflineWith(page, plant) {
  const tag = 'plant-' + Math.random();
  await page.addInitScript(([tag, plant, k, atK]) => {
    if (sessionStorage.getItem(tag)) return; // once
    sessionStorage.setItem(tag, '1');
    if (plant.lsText !== undefined) localStorage.setItem(k, plant.lsText);
    if (plant.lsAt === null) localStorage.removeItem(atK);
    else if (plant.lsAt !== undefined) localStorage.setItem(atK, String(plant.lsAt));
    if (plant.dropIdb) indexedDB.deleteDatabase('teamsync-local'); // queued ahead of the app's own open
  }, [tag, plant, LS_KEY, LS_AT_KEY]);
  await reloadOffline(page);
}

const nameOf = (page, id) => page.evaluate((id) => { const f = typeof findJob === 'function' && findJob(id); return f ? f.job.name : null; }, id);

test('a localStorage copy newer than the IndexedDB one wins at startup', async ({ page }) => {
  await open(page);
  const id = await page.evaluate(() => { flushProjectsToLocalCache(); return jobs[0].id; });
  await expect.poll(async () => !!(await idbGet(page))).toBe(true);
  // A page close whose IndexedDB write didn't finish.
  await reloadOfflineWith(page, { lsText: await renamedProjectsText(page, id, 'From Newer localStorage'), lsAt: Date.now() + 60000 });
  await expect.poll(() => nameOf(page, id)).toBe('From Newer localStorage');
});

test('an older localStorage copy loses to IndexedDB and is then cleared', async ({ page }) => {
  await open(page);
  const id = await page.evaluate(() => { jobs[0].name = 'In IndexedDB'; saveActiveProject(); flushProjectsToLocalCache(); return jobs[0].id; });
  await expect.poll(async () => (await idbGet(page)).text.includes('In IndexedDB')).toBe(true);
  // Left over from before this change: no saved-at stamp at all.
  await reloadOfflineWith(page, { lsText: await renamedProjectsText(page, id, 'Stale Old Copy'), lsAt: null });
  await expect.poll(() => nameOf(page, id)).toBe('In IndexedDB');
  await page.evaluate(() => flushProjectsToLocalCache());
  await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), LS_KEY)).toBeNull();
});

test('an existing user with only a localStorage copy keeps their data, which then moves to IndexedDB', async ({ page }) => {
  await open(page);
  const id = await page.evaluate(() => jobs[0].id);
  // A browser from before this change: no IndexedDB copy yet.
  await reloadOfflineWith(page, { lsText: await renamedProjectsText(page, id, 'Only In localStorage'), lsAt: null, dropIdb: true });
  await expect.poll(() => nameOf(page, id)).toBe('Only In localStorage');
  await page.evaluate(() => flushProjectsToLocalCache());
  await expect.poll(async () => { const c = await idbGet(page); return !!c && c.text.includes('Only In localStorage'); }).toBe(true);
  await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), LS_KEY)).toBeNull();
});

test('a localStorage copy too big to fit on page close is dropped instead of breaking the save', async ({ page }) => {
  await open(page);
  const r = await page.evaluate((k) => {
    const realSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, v) {
      if (key === k) throw new DOMException('full', 'QuotaExceededError');
      return realSet.call(this, key, v);
    };
    let threw = false;
    try { jobs[0].name = 'Too Big'; saveJobs(); flushProjectsToLocalCache({ closing: true }); } catch (e) { threw = true; }
    Storage.prototype.setItem = realSet;
    return { threw, keyGone: localStorage.getItem(k) === null, inMemory: jobs[0].name };
  }, LS_KEY);
  expect(r).toEqual({ threw: false, keyGone: true, inMemory: 'Too Big' });
  // The IndexedDB copy is unaffected.
  await expect.poll(async () => (await idbGet(page)).text.includes('Too Big')).toBe(true);
});

test('Home Job Chat shows the newest 100 messages, with a button for older ones', async ({ page }) => {
  await open(page);
  // Every other job's comments are cleared so the feed holds exactly these 130.
  await page.evaluate(() => {
    jobs.forEach((j) => { j.comments = []; });
    const job = jobs.find((j) => !j.archived && isJobVisibleToMe(j));
    job.comments = Array.from({ length: 130 }, (_, i) => ({ id: 'feed-' + i, author: 'A', text: 'Message ' + i, when: Date.now() - i * 60000, replies: [] }));
    switchTab('home');
    renderHomeDashboard();
  });
  const items = page.locator('#homeJobChatList .job-comment-item');
  await expect(items).toHaveCount(100);
  await expect(page.locator('#homeJobChatList')).toContainText('Message 0');
  await expect(page.locator('#homeJobChatList')).not.toContainText('Message 129');
  const more = page.locator('#homeJobChatList .job-chat-show-older');
  await expect(more).toHaveText('Show older messages (30)');
  await more.click();
  await expect(items).toHaveCount(130);
  await expect(more).toHaveCount(0);
});

test('findJob/getPhaseCard stay correct as the arrays change underneath them', async ({ page }) => {
  await open(page);
  const r = await page.evaluate(() => {
    const out = {};
    const job = jobs.find((j) => getPhaseCard(j, null));
    const card = getPhaseCard(job, null);
    const idx = boardCards.indexOf(card);
    // Replaced in place (what an incoming teammate change does).
    const replacement = Object.assign({}, card, { title: 'replacement' });
    boardCards[idx] = replacement;
    out.replaced = getPhaseCard(job, null) === replacement;
    // Removed.
    boardCards.splice(idx, 1);
    out.removed = getPhaseCard(job, null) === undefined;
    // Re-added at the end, then an earlier card re-pointed at this job in place.
    boardCards.push(replacement);
    out.readded = getPhaseCard(job, null) === replacement;
    // An orphaned card (no jobId) sitting EARLIER in the list gets adopted
    // by this job in place: a scan would now find it first, so must we.
    const orphan = { id: 'orphan-card', title: job.name, column: replacement.column, phaseId: null };
    boardCards.unshift(orphan);
    getPhaseCard(job, null); // re-cache with the orphan still unlinked
    migrateOrphanedCards();
    out.firstMatchKept = getPhaseCard(job, null) === orphan;
    boardCards.shift();
    // Whole array swapped (project switch / reload).
    const copy = boardCards.map((c) => Object.assign({}, c));
    boardCards = copy;
    out.swapped = copy.indexOf(getPhaseCard(job, null)) !== -1;
    // findJob: moved, removed, missing.
    const j = jobs[2];
    jobs.splice(2, 1); jobs.unshift(j);
    const found = findJob(j.id);
    out.jobMoved = found.job === j && found.idx === 0;
    jobs.shift();
    out.jobRemoved = findJob(j.id) === null;
    out.missing = findJob('no-such-job') === null;
    return out;
  });
  expect(r).toEqual({ replaced: true, removed: true, readded: true, firstMatchKept: true, swapped: true, jobMoved: true, jobRemoved: true, missing: true });
});

test('formatDate matches toLocaleDateString exactly', async ({ page }) => {
  await open(page);
  const r = await page.evaluate(() => {
    const opts = [{ month: 'short' }, { month: 'short', day: 'numeric' }, { month: 'short', day: 'numeric', year: 'numeric' }, { weekday: 'short' }, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }];
    const mismatches = [];
    for (let m = 0; m < 12; m++) {
      const d = new Date(2026, m, 3 + m, 9 + m, 5);
      opts.forEach((o) => {
        const want = o.hour ? d.toLocaleString('en-US', o) : d.toLocaleDateString('en-US', o);
        if (formatDate(d, o) !== want) mismatches.push([d.toISOString(), JSON.stringify(o), formatDate(d, o), want]);
      });
    }
    return mismatches;
  });
  expect(r).toEqual([]);
});

test('a local copy bigger than localStorage allows (1,000 realistic jobs) survives an offline reload', async ({ page }) => {
  test.setTimeout(90000);
  await open(page);
  const bytes = await page.evaluate(() => {
    const note = 'frame wall panel truss header joist sill plate stud king jack cripple beam post footing anchor bolt '.repeat(5);
    for (let i = 0; i < 1000; i++) {
      const id = 'big-' + i;
      jobs.push({ id, name: 'Big Job ' + i, color: '#1e88e5', archived: i % 3 !== 0, order: 1000 + i, tasks: [], comments: Array.from({ length: 8 }, (_, c) => ({ id: id + 'c' + c, author: 'A', text: note, when: 1, replies: [] })) });
    }
    saveJobs();
    flushProjectsToLocalCache();
    return JSON.stringify(projects).length;
  });
  expect(bytes).toBeGreaterThan(5 * 1024 * 1024);
  await expect.poll(async () => { const c = await idbGet(page); return !!c && c.text.includes('Big Job 999'); }, { timeout: 20000 }).toBe(true);
  await reloadOffline(page);
  await expect.poll(() => page.evaluate(() => jobs.filter((j) => String(j.id).startsWith('big-')).length)).toBe(1000);
});
