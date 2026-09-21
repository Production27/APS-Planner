# Gantt Tasks-view row redesign — implementation plan

**Status: Phase A shipped** (index.html, src/views/gantt.ts, src/views/gantt-task-row.tsx). Phase B (job-level fold) was explicitly declined — not built, not scoped for later unless separately requested.

**The shipped design went through three live rounds after this doc was first written**, each driven by Karl reacting to the real thing (a mockup, then the actual running app, twice) rather than this doc's original spec. Read the doc below with that in mind — the "approved design" section and the early mockup link right after it describe the STARTING point, not what shipped:

**Round 1 (mockup review, https://claude.ai/artifact/RtFedWUR2dTXgqmMh5W3Yy):** collapsed to exactly one pill per row (no stacking), dropped the mini segmented-bar preview in favor of plain chevron+label pills, and moved the job name into a permanently-visible middle column instead of a pill.

**Round 2 (after shipping, testing the real app):** the one-pill version had a real usability problem — expanding a phase pill replaced it with a *different* pill (the sub-phase's) sitting in roughly the same spot, so a second click on "the same-looking bubble" drilled deeper instead of collapsing back, which read as broken. Fix: stacked pills in a separate right-hand lane — phase pill + sub-phase pill + (on a leaf row) a third pill for the task's own name, stacked vertically, each independently clickable. `GANTT_ROW_H` went 40→44px to fit 3 stacked pills.

**Round 3 (after shipping round 2):** Karl didn't want a separate lane or vertical stacking at all — pills should be horizontal, trailing after the name, the way they always were before any of this. Fix: pills moved back inline into `.col-jobs`, right after the job name (no more `.lane` column), and `GANTT_ROW_H` went back to 40. That immediately surfaced a real width problem: the job name (now always shown, unlike the original design where it was blank on a folded/merged row) could eat the whole column and squeeze trailing pills down to nothing, or a flexbox quirk could squeeze the *name* to nothing instead — `.col-jobs` is a flex row, pills had no `overflow:hidden`, so per spec their flex `min-width:auto` resolved to their full content size (refuse to shrink) while the name (which does have `overflow:hidden`) absorbed the entire deficit alone, down to 0px, whenever pills didn't fit. Fixed by capping the name at a fixed `max-width` with its own ellipsis AND giving both the name and every pill `flex-shrink: 0`, so each keeps its own intended size and, if everything doesn't fit, whatever's left just gets clipped at the column edge by `.col-jobs`'s existing `overflow:hidden` — the same hard-clip-at-the-edge behavior the original app always had. Two small follow-ups landed right after: the Date column got a touch wider (92→104px, a cross-month range like "Sep 28 – Oct 2" was touching the border), and an unnamed phase's pill shows just its chevron instead of the literal words "Unnamed phase".

**Round 4:** a new Task column, between Date and Job. On a real leaf row it's just that task's own name (moved out of the pills — see item 3 below). On a folded/merged row, which spans many real tasks at once, it calls out whichever one the job is "currently in" today: a task whose start–finish window covers today, else the soonest upcoming one, else the most recently finished one, else just the first dated task — see `findCurrentTask()`/`getTasksForMergedRow()` in gantt.ts. Initially shipped as plain text, informational-only on a merged row — Karl wanted it as a clickable pill instead (matching the phase/sub-phase pills' look), on *every* row including merged ones: clicking it isolates by that specific task's own board-column stage, same feature the leaf row's version already carried.

What's different from the original spec, net of all four rounds:

1. **The job name stays in the middle column, permanently** (round 1's change — kept through every later round). It's not a pill; it's the row's own name text, capped at a fixed width with its own ellipsis, clickable to isolate to that job (reusing the exact click/focus-ring mechanics the task name used to have).
2. **No mini segmented bar.** Every pill, folded or not, is a chevron baked into the label text (e.g. "▸ Framing") — no solid/hatch/tick preview. That still exists only in the real timeline's collapsed job-span rendering, untouched.
3. **A new Task column (round 4)**, between Date and Job — its own pill (same look as the phase/sub-phase pills, moved out of `.col-jobs`), always clickable when present: a leaf row's own task, or a folded/merged row's current-task callout (see round 4 above), both isolating by that task's board-column stage (`ganttFocusedTaskColumnId`/`toggleGanttTaskFocus()`). The trailing pills in `.col-jobs` are down to at most 2 now (phase, sub-phase) — the task-name pill round 2/3 had moved here instead.
4. **Pills are horizontal and trailing, back in `.col-jobs`** — no separate lane column, no vertical stacking. `GANTT_ROW_H` is 40px again, same as the original design (single-line row).

Also discovered while implementing: **Jobs/Leads view is dead code** — `ganttViewMode` is a constant always `'tasks'` (see its own comment in index.html), so the `isTasksMode`-false branch in `renderLeftPanelRows()` never runs. It was left in place (not deleted — out of scope), just updated to keep compiling against the new shared prop shape. This made "don't break Jobs/Leads" a non-issue in practice, though the code still behaves as if it could matter.

---

The rest of this document is the ORIGINAL plan as first written, kept for the reasoning behind things that are still true (why rows aren't grouped by job, the row-key/reorder-animation mechanics, the file-by-file map). Its "stacked pills" description in item 5 below is actually closer to what shipped than it looks at first — "stacked" there meant horizontal/trailing (as it shipped), not the vertical lane round 2 tried and round 3 reverted.

**Mockup (early exploration — superseded by the live review above):** https://claude.ai/artifact/AEK9eyB8uoYaS6FVcMW5Nx — specifically the **"After — Option 3, with your pills"** section near the bottom. Everything else on that page (the "text lane" variant above it, and the three earlier concepts it replaced) was explored and rejected — ignore them. The mockup is a static/synthetic HTML file with fake data; it is a spec for behavior and layout, not code to port.

## The problem being solved

Today, in Gantt **Tasks view**, every row can carry up to three same-weight colored pills — job, phase, sub-phase — stacked inline after the task name, plus two separate 88px date columns. All three pills look equally important, so nothing tells the eye which one matters, and the row runs out of room fast in the 340px left panel.

## The approved design

1. **Merge the Start/Finish columns into one Date column** (e.g. "Mar 03–07"). Frees up width.
2. **Move job/phase/sub-phase pills into a fixed-width lane on the right side of the row**, instead of trailing the task name. The task name gets the left side to itself.
3. **All three levels — job, phase, sub-phase — fold independently**, each via a chevron on its own pill (click the pill, same gesture as today). Folding a level merges its rows into one, wherever that merged row sorts by date (today's board is sorted purely by date across the whole board — rows are **not** grouped/contiguous, see "Why this shape" below).
4. **A folded/merged row shows a small segmented mini-bar** instead of a plain label — solid color per task, hatched where two tasks overlap that day, a tick at each task's finish date. This mirrors the segmented bar the real timeline **already** shows today for a collapsed job-span (see "Reuse, don't reimplement" below) — it should look and behave like a small version of that, not a new invented thing.
5. Rows default to **quiet**: with a job folded, its lane shows just the job pill; expand it and the lane shows job + phase (+ sub-phase where applicable) pills, stacked.

### Why this shape (don't relitigate)

Earlier rounds tried an indented tree and a section-header layout. Both were dropped because **Tasks view rows are not grouped by phase today** — `buildVisibleTaskRows()` pushes every row into one flat array and a single global sort orders it purely by `task.start` (gantt.ts, `byStartDate()` ~1063-1073, final sort ~1243-1244), regardless of job/phase/sub-phase. A "Framing" row can already sit between two "Electrical" rows just because of scheduling. Any row style that assumes visual adjacency (indentation implying a parent above it, a shared section header) breaks under that — a phase's rows can be scattered, or the same header can repeat several times down the list. The pill-lane design was chosen because **every row is self-describing regardless of its neighbors**, which is the actual constraint. Don't propose a grouped/indented layout again without also changing the sort itself (see Phase C, optional, below).

## Scope

**In scope:** Gantt **Tasks view** left-panel rows only.
**Out of scope, untouched:** Jobs/Leads view (different pill/collapse model already, not part of this), the timeline/bar panel on the right (already shows the segmented-bar behavior correctly today — nothing to change there), Calendar/Board/Home views.

## Recommended phasing

Don't build this as one big change. Two phases, cut at a real functionality boundary:

### Phase A — restyle only (do this first) — SHIPPED
- Merge Start/Finish into one Date column. ✅
- Move pills into the right-hand lane — as one pill, not stacked (see the top-of-doc note). ✅
- Kept today's fold behavior exactly as-is: phase and sub-phase fold, same underlying state (`tasksExpandedPhaseIds`/`tasksExpandedSubPhaseIds`, `toggleTasksPhaseExpanded()`/`toggleTasksSubPhaseExpanded()`) and same row-building functions (`buildVisibleTaskRows()`/`buildPhaseCollapsedRow()`/`buildSubPhaseRow()`, all UNCHANGED) — this really was restyle-only at the data layer, exactly as hoped. Only `renderLeftPanelRows()`'s per-row prop construction changed.
- Job name ended up NOT a pill at all (see top-of-doc note) — informational-only became "always the middle column," which is a stronger version of the original intent here.

### Phase B — job-level fold — DECLINED, not built
Karl explicitly said not to build this. Left here only as historical context for the shape it would have taken if revisited later — the reasoning below (new `tasksExpandedJobIds` set, a new job-level row-merge function) is still accurate if this gets picked up again, minus the mini segmented-bar part (dropped, see top-of-doc note).

### Phase C — optional, not currently planned
The mockup's earlier rejected concepts (indented tree, section headers) would become valid again **only if** Tasks view's sort were changed to actually group rows by phase (sacrificing pure date order across phases). That's a data-ordering change, not a style change, and isn't part of this plan — only revisit it if Phase A+B still don't feel like enough.

## Key technical risks — resolve/verify before writing UI code

1. **Row-height sync is load-bearing — this is the biggest risk.** `GANTT_ROW_H = 40` (gantt.ts ~115) is a *global constant* the whole Gantt assumes: the timeline panel positions every task bar at `visibleRowIdx * GANTT_ROW_H`, the reorder-animation FLIP math, scroll/spacer height, and zebra striping all depend on every left-panel row being *exactly* the same height as its corresponding timeline row. An expanded task row in the new design shows 3 stacked pills (job/phase/sub-phase) — check whether that comfortably fits in 40px at the app's real type scale, or needs more room.
   - **Preferred resolution:** keep pills small enough to fit 3 stacked inside 40px (the mockup used 9px pill text — verify against the app's actual `--t-*` type tokens, not the mockup's arbitrary sizing).
   - **Fallback if that's not legible:** bump `GANTT_ROW_H` itself to a slightly taller uniform value (e.g. 44-46px) — a single constant change, not per-row variable height, so every downstream assumption keeps working. Check first whether `GANTT_ROW_H` can be conditional on view mode (Tasks view only) without touching the shared draw loop that both views run through — if it can't cleanly, decide whether Jobs/Leads view also getting slightly taller rows is acceptable.
   - **Do not build variable per-row height** (i.e., a folded 1-pill row at 40px next to an expanded 3-pill row at 50px in the same list) without also reworking the bar-positioning/animation math that assumes uniform row height — that's a much bigger change than this task and almost certainly not worth it here.

2. **Reuse, don't reimplement, the segment computation.** The real timeline already computes solid/hatch/tick segments for a collapsed job-span, in the `isJobSpan` branch of the draw loop (gantt.ts ~1696-1958, the day-by-day grouping logic starting ~1792). The new left-panel mini-bar needs the *same* segment data at a smaller scale. Extract that day-coverage computation into a small shared/pure function both call, rather than writing a second implementation (the mockup's `computeSegments()` in its own `<script>` is a reasonable reference for the *algorithm shape* — generic day-by-day coverage grouped into runs — but it's throwaway JS, not code to copy in).

3. **Phase/sub-phase colors already exist** — today's pills are already colored per phase/sub-phase (`phasePill`/`subPill` in `renderLeftPanelRows()`, gantt.ts ~1500-1545). Confirm the exact field names on the Phase/SubPhase data model and reuse them; don't invent a new color scheme.

4. **Confirm the default fold state.** The mockup demo starts with every job folded (to show off the interaction dramatically). That is very likely **not** what should ship by default — recommend defaulting to "everything expanded," matching current Tasks-view behavior, so this reads as a decluttering pass rather than a surprise change to what's visible on open. Flag this to Karl explicitly if it comes up — don't assume the mockup's demo default is the intended shipped default.

5. **Typography: use the app's real tokens.** The mockup artifact loads Google Fonts (IBM Plex Sans/Mono) and its own font-size scale purely for that standalone page's presentation. The real implementation must use the app's existing type tokens (`--t-2xs`, `--t-xs`, `--t-sm`, etc., see index.html's `<style>` block ~line 50) and whatever font stack `.task-row` already inherits — do not add IBM Plex or any new font loading to the real app.

6. **Reorder-animation identity.** Rows are matched across renders by a stable `data-row-key` (see the big comment block at the top of `gantt-task-row.tsx`, and `captureBarTopsByRowKey()`/`animateReorderedBars()`, gantt.ts ~2291/~2454, `GANTT_REORDER_MS = 1100`). Preact reuses the same DOM node per `rowKey`. As long as the new row markup keeps using the same `rowKey`/`data-row-key` scheme for task rows and for merged/collapsed pseudo-rows (already true for the existing phase/sub-phase collapse — just confirm it stays true for the restyled row and, in Phase B, for the new job-level merged row), the existing animation system should keep working without changes.

## File-by-file (as shipped)

- **`index.html`** — merged `.col-date` (104px) replaces `.col-start`/`.col-finish`. New `.col-task` (90px, fixed) sits right after it, hosting one `.task-row-pill` — the pill styling (`.task-row-pill` and its `.collapsible`/`.focused` states) is now shared between this column and the trailing pills in `.col-jobs`, rather than scoped to `.col-jobs` alone. `.task-row-name` (the job name) is capped at `max-width: 90px` (shrunk from 110 to make room for the new column) with its own ellipsis and `flex-shrink: 0`. Trailing `.task-row-pill`s (renamed from the old `.task-row-jobname`/`-phasename`/`-subphasename`) sit inline after the name inside `.col-jobs`, each also `flex-shrink: 0`. No separate lane column (round 2 tried one, round 3 removed it). The static `#leftBody` header row is now `Date`/`Task`/`Job`. `.task-row` height is 40px.
- **`src/views/gantt-task-row.tsx`** — `TaskRowProps.dateStr` replaces `startStr`/`finishStr`; new `taskPill: TaskRowPillProps | null` for the Task column (reuses the same `TaskRowPill` component/shape the trailing pills use — briefly shipped as plain clickable text, then converted to a pill per Karl's follow-up); `jobPill`/`phasePill`/`subPill` collapsed into one `pills: TaskRowPillProps[]` (now just phase + sub-phase — the task-name pill moved into the new column). `TaskRowPillProps` is back to its original shape (`label`/`title`/`background`/`focused`/`onClick`, chevron baked into `label`). Still a pure presentational component, still resolved from `gantt.ts`'s `renderLeftPanelRows()` (not `buildTaskRowProps` — that name in the original draft below didn't match the actual function).
- **`src/views/gantt.ts`** — only `renderLeftPanelRows()` changed. `GANTT_ROW_H` is back to 40 (its original value). `buildVisibleTaskRows()`/`buildPhaseCollapsedRow()`/`buildSubPhaseRow()` are byte-for-byte unchanged, exactly as the original plan hoped. New `formatMergedDateRange()` helper for the Date column, and `findCurrentTask()`/`getTasksForMergedRow()` for the Task column's merged-row callout.

## Testing / verification checklist

- [x] Left panel and timeline stay pixel-aligned row-for-row, at every fold state — verified via real browser screenshots (folded, phase-expanded, Expand All, Collapse All) with a constructed multi-phase/sub-phase job; `npm run typecheck`, `npm run build`, and the full Playwright suite (197 tests, including the Gantt-specific ones) all pass, re-verified after each of the four rounds.
- [x] Reorder animation, drag/resize — unaffected (all `gantt-reorder-animation.spec.js`/`gantt-collapsed-drag-sync.spec.js` tests still pass; `buildVisibleTaskRows()`/row-key scheme untouched).
- [x] A long real name truncates gracefully — verified with "Riverside Medical Office Build-Out" in the 340px panel; caught a real bug here (see round 3 above: pills without `flex-shrink`/`overflow` made the name get squeezed to 0px instead of truncating at its own cap) and fixed it before shipping.
- [x] Folding/toggling at every level — verified interactively, specifically re-tested the actual regression Karl hit in round 2: expand a phase pill, click that SAME pill again → correctly collapses the whole phase back to one row. Re-verified again in round 3 after moving pills back inline.
- [x] Task column's "current task" callout — verified with a phase-level merge spanning two sub-phases (one finished, one covering today): correctly picked the task whose start–finish window covers today, across the whole phase's tasks, not just the nearer sub-phase's.
- [x] Board-column-focus click still works, now from the Task column instead of a pill — verified: clicking a leaf row's task name sets `ganttFocusedTaskColumnId` and isolates the Gantt, without also folding the row.
- [x] Dark mode — verified via screenshot, every round.
- [ ] Mobile width behavior — not specifically re-tested narrow. With pills now `flex-shrink:0` and hard-clipped at the column edge when they don't fit, narrow widths will just show fewer pills (whichever fit) rather than squeezing anything illegibly — worth a real look if it comes up, but shouldn't be broken.
- N/A: mini segmented-bar item — dropped, nothing to verify.

## Open questions — resolved

1. Default fold state on load: **folded** (matches today's actual default — see top-of-doc correction to this doc's original recommendation).
2. Phase B: **declined**, not built.
3. Lane/date-column width: **112px lane, 92px date column** — the values worked out live in the mockup, carried straight into the shipped CSS (`.task-row .lane`, `.task-row .col-date` in index.html).
