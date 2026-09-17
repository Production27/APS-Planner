import { render, Fragment } from 'preact';

// Home dashboard's Checklist widget (#homeChecklistBody) — a static,
// empty element from index.html exclusively written to by
// renderHomeDashboard() (see home.ts) and nothing else, same "safe to
// hand over directly, no wrapper needed" case as Job Chat's own list
// element (see home-jobchat.tsx's own comment).
//
// Two modes share one component instead of two: the compact widget
// (top 6 rows, flat) and the expanded-in-place version (every row,
// grouped by job — see home.ts's own renderHomeChecklistWidgetExpanded
// comment for why that's real markup and not a call into the real
// Checklist tab's own renderMyChecklistList()). Group headers are
// rendered as a sibling of the item they precede, not a wrapper around
// it, matching the original flat DOM the CSS expects — a keyed Fragment
// per row carries both without introducing one.

export interface HomeChecklistRowProps {
  rowKey: string;
  text: string;
  required: boolean;
  jobName: string;
  jobColor: string;
  columnLabel: string;
  isGroupStart: boolean;
  onToggleDone: () => void;
  onOpenItem: () => void;
}

export interface HomeChecklistWidgetProps {
  rows: HomeChecklistRowProps[];
  expanded: boolean;
  moreCount: number;
  onShowMore: () => void;
}

function onEnterOrSpace(fn: () => void) {
  return (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } };
}

function ChecklistEmpty() {
  return (
    <div class="home-widget-empty">
      <svg viewBox="0 0 24 24" width="28" height="28" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="18" height="18" rx="3" fill="#28a745" /><path d="M7 12l3 3 7-7" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round" /></svg>
      <div>Nothing assigned to you right now.</div>
    </div>
  );
}

function CompactRow(p: HomeChecklistRowProps) {
  return (
    <div class="home-row">
      <input type="checkbox" onChange={p.onToggleDone} />
      <span class="home-row-text" onClick={p.onOpenItem}>{p.text}</span>
      <span class="my-checklist-job-bubble" style={{ background: p.jobColor }}>{p.jobName}</span>
    </div>
  );
}

function ExpandedRow(p: HomeChecklistRowProps) {
  return (
    <Fragment key={p.rowKey}>
      {p.isGroupStart ? (
        <div class="my-checklist-group-header"><span class="home-row-dot" style={{ background: p.jobColor }} />{p.jobName}</div>
      ) : null}
      <div class="checklist-item my-checklist-item">
        <input type="checkbox" onChange={p.onToggleDone} />
        {p.required ? <span class="ci-required is-required" title="Required">★</span> : null}
        <span class="ci-text" tabIndex={0} role="button" onKeyDown={onEnterOrSpace(p.onOpenItem)} onClick={p.onOpenItem}>{p.text}</span>
        <span class="my-checklist-job-bubble" style={{ background: p.jobColor }} onClick={p.onOpenItem}>{p.jobName}</span>
        <span class="my-checklist-stage-tag">{p.columnLabel}</span>
      </div>
    </Fragment>
  );
}

function HomeChecklistWidget(p: HomeChecklistWidgetProps) {
  if (!p.rows.length) return <ChecklistEmpty />;
  if (p.expanded) {
    return <>{p.rows.map((r) => <ExpandedRow key={r.rowKey} {...r} />)}</>;
  }
  return (
    <>
      {p.rows.map((r) => <CompactRow key={r.rowKey} {...r} />)}
      {p.moreCount > 0 ? <div class="home-more-link" onClick={p.onShowMore}>+{p.moreCount} more — go to Checklist</div> : null}
    </>
  );
}

export function renderHomeChecklistWidgetInto(container: HTMLElement, props: HomeChecklistWidgetProps): void {
  render(<HomeChecklistWidget {...props} />, container);
}
