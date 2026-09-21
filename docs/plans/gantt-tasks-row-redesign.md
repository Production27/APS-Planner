# Gantt Tasks-view row redesign — implementation plan

**Status: Phase A shipped** (index.html, src/views/gantt.ts, src/views/gantt-task-row.tsx). Phase B (job-level fold) was explicitly declined — not built, not scoped for later unless separately requested.

**The shipped design went through two live rounds after this doc was first written**, both driven by Karl reacting to the real thing (a mockup, then the actual running app) rather than this doc's original spec. Read the doc below with that in mind — the "approved design" section and the early mockup link right after it describe the STARTING point, not what shipped:

**Round 1 (mockup review, https://claude.ai/artifact/RtFedWUR2dTXgqmMh5W3Yy):** collapsed to exactly one pill per row (no stacking), dropped the mini segmented-bar preview in favor of plain chevron+label pills, and moved the job name into a permanently-visible middle column instead of a pill.

**Round 2 (after shipping, testing the real app):** the one-pill version had a real usability problem — expanding a phase pill replaced it with a *different* pill (the sub-phase's) sitting in roughly the same spot, so a second click on "the same-looking bubble" drilled deeper instead of collapsing back, which read as broken. Karl's fix: **go back to stacked pills** — phase pill + sub-phase pill + (on a leaf row) a third pill for the task's own name, all shown together, each independently clickable, exactly like the original three-pill idea below. What's still different from the original spec:

1. **The job name stays in the middle column, permanently** (round 1's change — kept). It's not a pill; it's the row's own name text, clickable to isolate to that job (reusing the exact click/focus-ring mechanics the task name used to have).
2. **No mini segmented bar.** Every pill, folded or not, is a chevron baked into the label text (e.g. "▸ Framing") — no solid/hatch/tick preview. That still exists only in the real timeline's collapsed job-span rendering, untouched.
3. **A leaf task's own name is now a (non-foldable) third pill**, not plain row text — since the job name occupies where task names used to live. It doubles as the board-column-focus click (`ganttFocusedTaskColumnId`/`toggleGanttTaskFocus()`).
4. **Row height is 44px, not 40.** A leaf row under a multi-sub-phase phase stacks 3 pills; 40px (the original row height, fine for a single line of text) doesn't comfortably fit that. See `GANTT_ROW_H` in gantt.ts.

Also discovered while implementing: **Jobs/Leads view is dead code** — `ganttViewMode` is a constant always `'tasks'` (see its own comment in index.html), so the `isTasksMode`-false branch in `renderLeftPanelRows()` never runs. It was left in place (not deleted — out of scope), just updated to keep compiling against the new shared prop shape. This made "don't break Jobs/Leads" a non-issue in practice, though the code still behaves as if it could matter.

---

The rest of this document is the ORIGINAL plan as first written, kept for the reasoning behind things that are still true (why rows aren't grouped by job, the row-key/reorder-animation mechanics, the file-by-file map). Its "stacked pills" description in item 5 below is actually what shipped, after a detour through a one-pill version — see above.

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

- **`index.html`** — merged `.col-date` (92px) + `.lane` (112px, up to 3 stacked `.task-row-lane-pill`s) replace the old `.col-start`/`.col-finish`/`.task-row-jobname`/`-phasename`/`-subphasename` rules, which were deleted outright (confirmed dead — see the Jobs/Leads discovery at the top of this doc). The static `#leftBody` header row (`Start`/`Finish`/`Task`) became `Date`/`Job`/`Level`. `.task-row` height is 44px (was 40).
- **`src/views/gantt-task-row.tsx`** — `TaskRowProps.dateStr` replaces `startStr`/`finishStr`; `jobPill`/`phasePill`/`subPill` collapsed into one `pills: TaskRowPillProps[]`, rendered stacked in the lane in order. `TaskRowPillProps` itself ended up back close to its original shape (`label`/`title`/`background`/`focused`/`onClick`, chevron baked into `label` like the original code did) after a detour through a `glyph` + dual-hotspot-label shape that only made sense for the one-pill version. Still a pure presentational component, still resolved from `gantt.ts`'s `renderLeftPanelRows()` (not `buildTaskRowProps` — that name in the original draft below didn't match the actual function).
- **`src/views/gantt.ts`** — only `renderLeftPanelRows()` changed (plus `GANTT_ROW_H` 40→44). `buildVisibleTaskRows()`/`buildPhaseCollapsedRow()`/`buildSubPhaseRow()` are byte-for-byte unchanged, exactly as the original plan hoped. New `formatMergedDateRange()` helper for the Date column.

## Testing / verification checklist

- [x] Left panel and timeline stay pixel-aligned row-for-row, at every fold state — verified via real browser screenshots (folded, phase-expanded, Expand All at 3 pills, Collapse All) with a constructed multi-phase/sub-phase job; `npm run typecheck`, `npm run build`, and the full Playwright suite (197 tests, including the Gantt-specific ones) all pass, both on the one-pill version and again after reverting to stacked pills.
- [x] Reorder animation, drag/resize — unaffected (all `gantt-reorder-animation.spec.js`/`gantt-collapsed-drag-sync.spec.js` tests still pass; `buildVisibleTaskRows()`/row-key scheme untouched).
- [x] A long real name truncates gracefully — verified with "Riverside Medical Office Build-Out" in the 340px panel; ellipsis handles it.
- [x] Folding/toggling at every level — verified interactively, specifically re-tested the actual regression Karl hit: expand a phase pill, click that SAME pill again (now sitting at the top of the first resulting row, next to a sub-phase pill) → correctly collapses the whole phase back to one row, instead of drilling into the sub-phase (the one-pill version's bug — clicking "the same spot" hit a different, deeper pill instead of toggling the one you'd already opened).
- [x] Dark mode — verified via screenshot.
- [ ] Mobile width behavior — not specifically re-tested narrow; existing ellipsis/truncation mechanics are unchanged in kind, just on new column widths and now up to 3 stacked pills in 112px. Worth a real look if it comes up.
- N/A: mini segmented-bar item — dropped, nothing to verify.

## Open questions — resolved

1. Default fold state on load: **folded** (matches today's actual default — see top-of-doc correction to this doc's original recommendation).
2. Phase B: **declined**, not built.
3. Lane/date-column width: **112px lane, 92px date column** — the values worked out live in the mockup, carried straight into the shipped CSS (`.task-row .lane`, `.task-row .col-date` in index.html).
