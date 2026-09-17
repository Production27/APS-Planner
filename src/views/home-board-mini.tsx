import { render } from 'preact';
import { AlertBar, type HomeAlertProps } from './home-widget-alert';

// Home dashboard's Workflow mini-board widget — three independent static
// containers from index.html (#homeStageAlert, #wsmBracketTrack,
// #wsmBarsWrap, all siblings under #homeStageBody), each its own small
// Preact root. Only the bar chart + bracket band + alert convert here —
// the widget's OTHER piece, the expanded-in-place real kanban board
// (renderHomeWorkflowExpandedBoard(), #homeBoardExpanded, still calling
// Board's old buildCardEl()) is a separate, bigger decision — same
// "own implementation vs. reuse the real Board's cards" fork Karl was
// asked about for Calendar's own duplicate mini-widget — and stays
// untouched until that's raised with him.
//
// Two Preact render passes for the SAME reason Home's Calendar widget
// needs them (see home-calendar.tsx's own header comment): the bracket
// band's segment positions are measured off the bars' real
// getBoundingClientRect() after they're laid out, so bars have to exist
// in the DOM first. Unlike Calendar's bars, though, there's no
// "reuse across renders" concern worth the extra bookkeeping here — this
// widget has far fewer bars (one per board column, a handful at most,
// not one per scheduled task) and no drag gesture to protect, so a full
// bracket-track rebuild every render is cheap and the code stays simpler
// for it.

export interface HomeWsmBarProps {
  colId: string;
  label: string;
  count: number;
  heightPx: number;
  color: string;
  title: string;
  onClick: () => void;
}

export interface HomeWsmBracketSegmentProps {
  segKey: string;
  label: string;
  color: string | null;
  left: number;
  width: number;
}

function WsmBar(p: HomeWsmBarProps) {
  return (
    <div
      class="wsm-bar-col"
      data-column={p.colId}
      tabIndex={0}
      role="button"
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); p.onClick(); } }}
      onClick={p.onClick}
      title={p.title}
    >
      <span class="wsm-bar-label">{p.label}</span>
      <span class="wsm-bar-count">{p.count}</span>
      <span class="wsm-bar" style={{ height: p.heightPx + 'px', background: p.color }} />
    </div>
  );
}

function WsmEmpty() {
  return (
    <div class="home-widget-empty" style={{ width: '100%' }}>
      <svg viewBox="0 0 24 24" width="28" height="28" xmlns="http://www.w3.org/2000/svg"><path d="M3 6a1 1 0 011-1h5l2 2h9a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V6z" fill="#f0ad4e" /></svg>
      <div>No cards on the board yet.</div>
    </div>
  );
}

function WsmBarsList({ bars, empty }: { bars: HomeWsmBarProps[]; empty: boolean }) {
  if (empty) return <WsmEmpty />;
  return <>{bars.map((b) => <WsmBar key={b.colId} {...b} />)}</>;
}

function WsmBracketSeg(p: HomeWsmBracketSegmentProps) {
  const width = p.width;
  const bw = Math.max(width - 10, 16);
  const inset = 2, flare = 5;
  const path = 'M' + inset + ',8 L' + (inset + flare) + ',2 L' + (bw - inset - flare) + ',2 L' + (bw - inset) + ',8';
  const bracketStyle = p.color ? { color: p.color } : { color: 'var(--text-light)', opacity: 0.6 };
  return (
    <div class="wsm-seg" style={{ left: p.left + 'px', width: width + 'px' }}>
      <div class="wsm-seg-label">{p.label}</div>
      <div class="wsm-bracket-wrap" style={bracketStyle}>
        <svg width={bw} height="8" viewBox={'0 0 ' + bw + ' 8'}>
          <path d={path} stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </div>
    </div>
  );
}

function WsmBracketList({ segments }: { segments: HomeWsmBracketSegmentProps[] }) {
  return <>{segments.map((s) => <WsmBracketSeg key={s.segKey} {...s} />)}</>;
}

export function renderHomeStageAlertInto(container: HTMLElement, alert: HomeAlertProps | null): void {
  render(alert ? <AlertBar {...alert} /> : null, container);
}

export function renderWsmBarsInto(container: HTMLElement, bars: HomeWsmBarProps[], empty: boolean): void {
  render(<WsmBarsList bars={bars} empty={empty} />, container);
}

export function renderWsmBracketInto(container: HTMLElement, segments: HomeWsmBracketSegmentProps[]): void {
  render(<WsmBracketList segments={segments} />, container);
}
