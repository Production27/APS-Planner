# Gantt Tasks-view row redesign — implementation plan

**Status:** approved design, not yet implemented. Written as a handoff so a fresh session can pick this up without the design-exploration history.

**Mockup (source of truth for the visual/interaction spec):** https://claude.ai/artifact/AEK9eyB8uoYaS6FVcMW5Nx — specifically the **"After — Option 3, with your pills"** section near the bottom. Everything else on that page (the "text lane" variant above it, and the three earlier concepts it replaced) was explored and rejected — ignore them. The mockup is a static/synthetic HTML file with fake data; it is a spec for behavior and layout, not code to port.

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

### Phase A — restyle only (do this first)
- Merge Start/Finish into one Date column.
- Move pills into the right-hand lane.
- Keep today's fold behavior exactly as-is: phase and sub-phase fold (already exist — `tasksExpandedPhaseIds`/`tasksExpandedSubPhaseIds`, `togglePhaseCollapse()`/`toggleTasksPhaseExpanded()`/`toggleTasksSubPhaseExpanded()`, gantt.ts ~762-811). **Job pill is informational only in Phase A — not clickable, not foldable.**
- This alone gets most of the decluttering with the least risk, since it's a styling/layout change to existing data flow, not new state or new row-merging logic.

### Phase B — job-level fold (separate, bigger, do after A ships and feels right)
- **This is new functionality, not a restyle.** Tasks view has no concept of folding a whole job today (job-level collapse exists only in Jobs/Leads view, via `collapsedPhaseIds`, which is a different view/state). Building it means:
  - A new persisted state set, e.g. `tasksExpandedJobIds` (localStorage, following the exact pattern of the two that already exist).
  - A new row-merge function analogous to `buildPhaseCollapsedRow()`/`buildSubPhaseRow()` (gantt.ts ~1108-1147), one level up — merges *all* of a job's tasks (across every phase/sub-phase) into one pseudo-row spanning min-start→max-finish when that job is collapsed.
  - The merged row's mini segmented-bar needs to handle more tasks/colors than a single phase's — verify the segment-color-cycling approach still reads clearly at that scale (the mockup capped at ~4 tasks per merge for this reason).
- Flagging this explicitly so "restyle the pills" doesn't silently grow into "add a whole new fold dimension" without that being a deliberate call.

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

## File-by-file

- **`index.html`** (inline `<style>`, Gantt rules start ~line 507) — new/changed CSS: merged date-column width, the right-hand lane and its pill styles, the mini segmented-bar component. Remove/retire the old three-inline-pill styles (`.task-row-jobname`/`-phasename`/`-subphasename` trailing-pill layout, ~567-578) once the new lane replaces them — check nothing else in Jobs/Leads view depends on those exact classes before deleting (Jobs/Leads view is out of scope for the redesign but may share CSS).
- **`src/views/gantt-task-row.tsx`** — the `TaskRow`/`TaskRowPill` components change shape: merged date prop instead of separate start/finish, pill lane instead of trailing pills, plus the new mini-segment sub-component for merged rows. Keep this file's existing discipline — it's documented as a *pure presentational* component with no ambient-global reads; all per-row decisions still get resolved in `gantt.ts`'s `buildTaskRowProps()` first.
- **`src/views/gantt.ts`** — `buildVisibleTaskRows()` / `buildPhaseCollapsedRow()` / `buildSubPhaseRow()` need their output reshaped to match the new row-prop shape (merged date range, segment data for collapsed rows). Phase B adds the new job-level collapse function and persisted state alongside the existing two.

## Testing / verification checklist

- [ ] Left panel and timeline stay pixel-aligned row-for-row, at every fold state, on both a Windows/Chromium and the actual shipped font stack (not the mockup's fonts).
- [ ] Reorder animation (drag a task bar to a new date) still plays correctly and rows still slide via the existing FLIP system, unchanged.
- [ ] A phase/sub-phase/job with a long real name truncates gracefully in the lane (use real data, not the mockup's short example names — this was flagged as untested in the mockup itself).
- [ ] Folding at every level (task→sub-phase merge, sub-phase→phase merge, and in Phase B phase→job merge) produces a merged row sorted at the correct position (earliest date among its merged tasks).
- [ ] Segment mini-bar matches the real timeline's segment bar for the same collapsed group (same solid/hatch/tick logic, same colors) — spot-check a few examples side by side.
- [ ] Dark mode.
- [ ] Mobile width behavior (today's Gantt already drops date columns on mobile — decide how the new merged date column + lane behave at narrow widths; the mockup didn't test this).

## Open questions to confirm with Karl before/while building

1. Default fold state on load — expanded (recommended) or folded (mockup's demo default)?
2. Is Phase B (job-level fold) wanted now, or ship Phase A first and decide later?
3. Exact lane width / date-column width in the real app's actual pixel budget (mockup numbers were illustrative, not final).
