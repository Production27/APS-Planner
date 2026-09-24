import { render } from 'preact';

// The "Manage Column Checklist" modal body (#manageColumnChecklistBody in
// index.html) — a static, empty div, opened/closed via
// openManageColumnChecklist()/closeManageColumnChecklist() in
// checklist.ts, which only toggle a .show class (see openModal/
// closeModal in utils/ui.ts) so the container itself is never torn down.
// The "add item" input stays uncontrolled and keeps its existing id
// (mcc_new_item) — addColumnChecklistDefaultItem() reads its value via
// getElementById, same as before this conversion, so typed-but-
// unsubmitted text also now survives an unrelated re-render.

export interface ManageColumnChecklistItemProps {
  itemId: string;
  text: string;
}

export interface ManageColumnChecklistBodyProps {
  items: ManageColumnChecklistItemProps[];
  onRemove: (itemId: string) => void;
  onAddKeyDown: (e: KeyboardEvent) => void;
  onAddClick: () => void;
}

function ManageColumnChecklistBody(p: ManageColumnChecklistBodyProps) {
  return (
    <div class="manage-field-group">
      <div class="manage-field-chips">
        {p.items.length ? p.items.map((item) => (
          <span key={item.itemId} class="manage-field-chip">
            {item.text}
            <button onClick={() => p.onRemove(item.itemId)}>×</button>
          </span>
        )) : <span style={{ fontSize: '11px', color: 'var(--text-light)' }}>No default items yet</span>}
      </div>
      <div class="manage-field-add-row">
        <input type="text" id="mcc_new_item" placeholder="Add item..." onKeyDown={p.onAddKeyDown} />
        <button class="btn btn-secondary" onClick={p.onAddClick}>Add</button>
      </div>
    </div>
  );
}

export function renderManageColumnChecklistBodyInto(container: HTMLElement, props: ManageColumnChecklistBodyProps): void {
  render(<ManageColumnChecklistBody {...props} />, container);
}
