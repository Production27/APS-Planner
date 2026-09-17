import { render } from 'preact';

// Board's per-column chrome — header, the ⋮ settings dropdown, and the
// color grid — into #boardWrapper (see board.ts's rebuildBoardColumnChrome()
// and its cachedBoardColumnDoms comment for why this only actually
// re-renders on a real column-data change, not on every card move). Each
// column's own col-body-<id> is rendered as a
// childless leaf here — board-card.tsx's renderBoardCardsInto() is a
// SEPARATE Preact root targeting that same div, exactly like Gantt's
// barsLayer/gridLinesLayer sub-containers (see gantt.ts's
// getOrCreateGanttGridLayers()): a plain-imperative-feeling leaf that one
// specific Preact tree fully owns, with nothing else — including THIS
// tree — ever touching its children.
//
// One real subtlety: the settings dropdown's/color panel's open-or-closed
// state is NOT part of BOARD_COLUMNS — it's a classList toggle
// (.show/.open) applied by toggleColSettings()/toggleColColorPanel() in
// board.ts, entirely outside this component's own props. Preact only ever
// touches DOM attributes whose value actually changed between renders (the
// same "properties I don't declare, I never touch" principle the Gantt
// reorder-animation relies on) — since this component's own `class` prop
// for the dropdown/panel never includes .show/.open, a chrome rebuild
// triggered by a DIFFERENT column's data changing leaves an open dropdown
// on THIS column alone. board.ts still explicitly closes every dropdown/
// panel at the top of rebuildBoardColumnChrome() before calling render()
// here, though, so a rebuild triggered by THIS column's own data changing
// (e.g. picking a new color) still closes it afterward — matching what
// the old innerHTML-rebuild version always did (every real chrome rebuild
// closes every dropdown), rather than leaving that "quiet" survival open
// as an accidental new inconsistency.

export interface ColorSwatch {
  color: string | null;
  selected: boolean;
  onClick: (e: MouseEvent) => void;
}

export interface SelectOption {
  value: string;
  label: string;
  selected: boolean;
}

export interface BoardColumnChromeProps {
  id: string;
  label: string;
  scheduleDisconnectedIcon: boolean;
  canManage: boolean;
  headerStyle: { background?: string; color?: string };
  settingsBtnColor?: string;
  hideFromSchedule: boolean;
  scheduleDisconnected: boolean;
  isFinishedTrigger: boolean;
  workflowItemOptions: SelectOption[];
  autoAssignChecklist: boolean;
  assigneeOptions: SelectOption[];
  defaultDuration: number;
  stalledAfterDays: number;
  colorSwatches: ColorSwatch[];
  onToggleSettings: (e: MouseEvent) => void;
  onToggleColorPanel: (e: MouseEvent) => void;
  onToggleScheduleVisibility: (e: MouseEvent) => void;
  onToggleScheduleSync: (e: MouseEvent) => void;
  onToggleFinishedTrigger: (e: MouseEvent) => void;
  onSetWorkflowItem: (e: Event) => void;
  onToggleAutoAssignChecklist: (e: MouseEvent) => void;
  onSetChecklistAssignee: (e: Event) => void;
  onSetDefaultDuration: (e: Event) => void;
  onSetStalledThreshold: (e: Event) => void;
  onManageChecklist: (e: MouseEvent) => void;
  onRename: (e: MouseEvent) => void;
  onDelete: (e: MouseEvent) => void;
  onHeaderDragStart: (e: DragEvent) => void;
  onHeaderDragEnd: (e: DragEvent) => void;
  onColumnDragOver: (e: DragEvent) => void;
  onColumnDragLeave: (e: DragEvent) => void;
  onColumnDrop: (e: DragEvent) => void;
  onSwatchKeyDown: (e: KeyboardEvent) => void;
}

function onEnterOrSpace(fn: (e: KeyboardEvent) => void) {
  return (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(e); } };
}

function ColToggleRow(p: { icon: string; title?: string; on: boolean; onToggle: (e: MouseEvent) => void }) {
  return (
    <div
      class="board-col-gantt-toggle"
      tabIndex={0}
      role="button"
      title={p.title}
      onKeyDown={onEnterOrSpace((e) => p.onToggle(e as unknown as MouseEvent))}
      onClick={p.onToggle}
    >
      <span dangerouslySetInnerHTML={{ __html: p.icon }} />
      <span class={'board-col-gantt-switch' + (p.on ? ' on' : '')}><span class="knob" /></span>
    </div>
  );
}

const COLOR_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right:3px" xmlns="http://www.w3.org/2000/svg"><path d="M12 3a9 9 0 100 18c1.5 0 2-1 2-2s-.5-1.5-.5-2.5c0-1 .8-1.5 2-1.5h2a4 4 0 004-4c0-4.4-4-8-9.5-8z" fill="#dcdfe6"/><circle cx="7.5" cy="10.5" r="1.7" fill="#e53935"/><circle cx="9.5" cy="7" r="1.7" fill="#f0ad4e"/><circle cx="14.5" cy="7" r="1.7" fill="#3949ab"/><circle cx="16.5" cy="11" r="1.7" fill="#28a745"/></svg> Color';
const DISCONNECTED_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" xmlns="http://www.w3.org/2000/svg"><path d="M9 3L3 9l3 3 3-3 3 3-6 6 3 3 6-6-3-3 3-3-3-3-3 3-3-3z" fill="#8d6e63"/></svg>';
const SCHEDULE_VIS_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right:3px" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="4" width="10" height="3.5" rx="1" fill="#3949ab"/><rect x="3" y="10.2" width="16" height="3.5" rx="1" fill="#3949ab" opacity="0.75"/><rect x="3" y="16.5" width="7" height="3.5" rx="1" fill="#3949ab" opacity="0.5"/></svg> Show in Schedule';
const SCHEDULE_SYNC_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right:3px" xmlns="http://www.w3.org/2000/svg"><path d="M9 3L3 9l3 3 3-3 3 3-6 6 3 3 6-6-3-3 3-3-3-3-3 3-3-3z" fill="#8d6e63"/></svg> Connect to Schedule';
const FINISHED_TRIGGER_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right:3px" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" fill="#28a745"/><path d="M7.5 12.5l3 3 6-6.5" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg> Finished Trigger';
const WORKFLOW_ITEM_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right:3px" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="9" width="6" height="6" rx="1.5" fill="#3949ab"/><rect x="9.5" y="9" width="6" height="6" rx="1.5" fill="#3949ab" opacity="0.75"/><rect x="17" y="9" width="6" height="6" rx="1.5" fill="#3949ab" opacity="0.5"/></svg> Workflow Item';
const AUTO_CHECKLIST_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right:3px" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="18" height="18" rx="3" fill="#f0ad4e"/><path d="M7 12l3 3 7-7" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="18" cy="6" r="4" fill="#3949ab" stroke="#fff" stroke-width="1"/></svg> Send Checklist Action Item';
const ASSIGN_TO_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right:3px" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="8" r="4" fill="#b0bec5"/><path d="M4 20c0-4.4 3.6-7 8-7s8 2.6 8 7" stroke="#b0bec5" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg> Assign To';
const DEFAULT_DURATION_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right:3px" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" fill="#b0bec5"/><path d="M12 7v5l3.5 2" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg> Default Duration';
const STALLED_AFTER_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right:3px" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="13" r="8" fill="#b0bec5"/><path d="M12 9v4l3 2" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg> Stalled After (days)';
const CHECKLIST_ITEM_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right:3px" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="18" height="18" rx="3" fill="#28a745"/><path d="M7 12l3 3 7-7" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg> Default Checklist';
const RENAME_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right:3px" xmlns="http://www.w3.org/2000/svg"><path d="M4 20l1-4.5L15.5 5 19 8.5 8.5 19 4 20z" fill="#f0ad4e"/><path d="M15.5 5L19 8.5" stroke="#fff" stroke-width="1"/></svg> Rename';
const DELETE_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right:3px" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" fill="#dc3545"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg> Delete';
const DEFAULT_SWATCH_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right:3px" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" fill="#dc3545"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>';

function BoardColumnChrome(p: BoardColumnChromeProps) {
  return (
    <div
      class="board-column"
      data-column={p.id}
      style={{ background: p.headerStyle.background }}
      onDragOver={p.onColumnDragOver}
      onDragLeave={p.onColumnDragLeave}
      onDrop={p.onColumnDrop}
    >
      <div
        class="board-column-header"
        data-col-header={p.id}
        draggable={p.canManage}
        style={{ color: p.headerStyle.color }}
        onDragStart={p.onHeaderDragStart}
        onDragEnd={p.onHeaderDragEnd}
      >
        <div class="board-column-header-title">
          <span>{p.label}</span>
          {p.scheduleDisconnectedIcon ? (
            <span title="Disconnected from schedule — cards here no longer auto-move" style={{ display: 'inline-flex', flexShrink: 0 }} dangerouslySetInnerHTML={{ __html: DISCONNECTED_ICON }} />
          ) : null}
        </div>
        <div class="board-col-settings-wrap" data-min-tier="projectAdmin">
          <button class="board-col-settings-btn" draggable={false} title="Settings" style={{ color: p.settingsBtnColor }} onClick={p.onToggleSettings}>⋮</button>
          <div class="board-col-settings-dropdown" id={'col-settings-' + p.id}>
            <div class="board-col-color-toggle" onClick={p.onToggleColorPanel}>
              <span dangerouslySetInnerHTML={{ __html: COLOR_ICON }} />
              <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span class="col-color-swatch" id={'col-swatch-' + p.id} style={{ background: p.colorSwatches.find((s) => s.selected)?.color || '#eceef4' }} />
                <span class="col-color-arrow" id={'col-arrow-' + p.id}>▾</span>
              </span>
            </div>
            <div class="board-col-color-panel" id={'col-panel-' + p.id}>
              <div class="board-col-color-grid" id={'col-colors-' + p.id} role="radiogroup" aria-label="Column color">
                {p.colorSwatches.map((s, i) => (
                  <div
                    key={i}
                    class={'board-col-color-option' + (s.selected ? ' selected' : '')}
                    style={s.color ? { background: s.color } : { background: 'linear-gradient(135deg,#f5f5f5 0%,#e0e0e0 100%)', position: 'relative' }}
                    role="radio"
                    aria-checked={s.selected}
                    tabIndex={s.selected ? 0 : -1}
                    onKeyDown={p.onSwatchKeyDown}
                    onClick={s.onClick}
                    title={s.color ? undefined : 'Default (no color)'}
                  >
                    {s.color ? null : <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', fontWeight: 700, color: '#888' }} dangerouslySetInnerHTML={{ __html: DEFAULT_SWATCH_ICON }} />}
                  </div>
                ))}
              </div>
            </div>
            <ColToggleRow icon={SCHEDULE_VIS_ICON} on={!p.hideFromSchedule} onToggle={p.onToggleScheduleVisibility} />
            <ColToggleRow icon={SCHEDULE_SYNC_ICON} on={!p.scheduleDisconnected} onToggle={p.onToggleScheduleSync} title="When off, cards sitting in this board stay put and stop auto-moving with the schedule, until dragged into a connected board." />
            <ColToggleRow icon={FINISHED_TRIGGER_ICON} on={p.isFinishedTrigger} onToggle={p.onToggleFinishedTrigger} title="Jobs whose card sits in this board count as finished — they stop showing as overdue/due-soon or counting toward Active Jobs on Home." />
            <div class="board-col-duration-row" title="Groups this board under a named item in the strip above Board, independent of this board's own name — see ⚙ Settings → Workflow Items to add more.">
              <span dangerouslySetInnerHTML={{ __html: WORKFLOW_ITEM_ICON }} />
              <select class="board-col-duration-input" style={{ width: 'auto', flex: 1 }} onClick={(e: MouseEvent) => e.stopPropagation()} onChange={p.onSetWorkflowItem}>
                <option value="">None</option>
                {p.workflowItemOptions.map((o) => <option key={o.value} value={o.value} selected={o.selected}>{o.label}</option>)}
              </select>
            </div>
            <ColToggleRow icon={AUTO_CHECKLIST_ICON} on={p.autoAssignChecklist} onToggle={p.onToggleAutoAssignChecklist} title="The moment a card lands here, this board's Default Checklist is created on it (not just left as a template) and assigned to the picked person below, so it shows up as a real action item in their Checklist right away." />
            {p.autoAssignChecklist ? (
              <div class="board-col-duration-row" title="Who the checklist items get assigned to on arrival. Left on Auto, it uses the card's own Foreman, then Project Manager, whichever is set.">
                <span dangerouslySetInnerHTML={{ __html: ASSIGN_TO_ICON }} />
                <select class="board-col-duration-input" style={{ width: 'auto', flex: 1 }} onClick={(e: MouseEvent) => e.stopPropagation()} onChange={p.onSetChecklistAssignee}>
                  <option value="">Auto (card's Foreman/PM)</option>
                  {p.assigneeOptions.map((o) => <option key={o.value} value={o.value} selected={o.selected}>{o.label}</option>)}
                </select>
              </div>
            ) : null}
            <div class="board-col-duration-row" title="How many days this board's task defaults to when only a start date is set in Job Manager">
              <span dangerouslySetInnerHTML={{ __html: DEFAULT_DURATION_ICON }} />
              <input type="number" min={1} class="board-col-duration-input" value={p.defaultDuration} onClick={(e: MouseEvent) => e.stopPropagation()} onChange={p.onSetDefaultDuration} />
            </div>
            <div class="board-col-duration-row" title="How many days a card can sit in this board before it shows up as Stalled on Home and gets a badge on the card.">
              <span dangerouslySetInnerHTML={{ __html: STALLED_AFTER_ICON }} />
              <input type="number" min={1} class="board-col-duration-input" value={p.stalledAfterDays} onClick={(e: MouseEvent) => e.stopPropagation()} onChange={p.onSetStalledThreshold} />
            </div>
            <div class="board-col-settings-item" onClick={p.onManageChecklist} dangerouslySetInnerHTML={{ __html: CHECKLIST_ITEM_ICON }} />
            <div class="board-col-settings-item" onClick={p.onRename} dangerouslySetInnerHTML={{ __html: RENAME_ICON }} />
            <div class="board-col-settings-divider" />
            <div class="board-col-settings-item danger" onClick={p.onDelete} dangerouslySetInnerHTML={{ __html: DELETE_ICON }} />
          </div>
        </div>
      </div>
      <div class="board-column-body" id={'col-body-' + p.id} />
    </div>
  );
}

function BoardColumnsChrome({ columns, addColumn }: { columns: BoardColumnChromeProps[]; addColumn: AddColumnFormProps }) {
  return (
    <>
      {columns.map((c) => <BoardColumnChrome key={c.id} {...c} />)}
      <div class="board-add-column" id="addColumnContainer" data-min-tier="projectAdmin">
        <button class="board-add-column-btn" id="addColumnBtn" onClick={addColumn.onShow}>+ Add Board</button>
        <div class="board-add-column-form" id="addColumnForm">
          <input type="text" id="newColumnName" placeholder="Enter board title..." maxLength={30} onKeyDown={addColumn.onKeyDown} />
          <div class="form-actions" style={{ marginTop: 0, paddingTop: 0, borderTop: 'none' }}>
            <button class="btn btn-primary" style={{ padding: '6px 14px', fontSize: '12px' }} onClick={addColumn.onSubmit}>Add Board</button>
            <button class="btn btn-secondary" style={{ padding: '6px 14px', fontSize: '12px' }} onClick={addColumn.onCancel}>Cancel</button>
          </div>
        </div>
      </div>
    </>
  );
}

export interface AddColumnFormProps {
  onShow: () => void;
  onKeyDown: (e: KeyboardEvent) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

export function renderBoardColumnsChromeInto(container: HTMLElement, columns: BoardColumnChromeProps[], addColumn: AddColumnFormProps): void {
  render(<BoardColumnsChrome columns={columns} addColumn={addColumn} />, container);
}
