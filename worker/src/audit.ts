// --- AUDIT TRAIL ---
// A server-side record of who changed what, and when. The project
// activityLog (room-state.ts) is written by the client and keeps only the
// last 50 entries, so it can't serve as an audit record. These entries are
// written by the server itself:
//   - one per data change actually saved: every job, card and calendar
//     event created, updated or deleted, plus project-level settings
//     (columns, fields, header, name). Derived from the same
//     computeRoomDelta() that drives sync, so a no-op write records nothing.
//   - sign-ins (successful and failed), account administration, backup
//     downloads/restores, maintenance mode, data exports and deletion
//     requests, reported by the Worker's HTTP handlers (recordAudit()).
// Stored in the room Durable Object under 'audit|<time>|<seq>' keys,
// separate from the project data (room-storage.ts only touches 'p|' and
// 'meta' keys, so a backup restore never removes audit entries). Entries
// older than AUDIT_RETENTION_DAYS are pruned.
import { getRoomStub } from './room-stub.ts';
import type { RoomDelta } from './room-state.ts';
import type { RoomState } from './types.ts';

export const AUDIT_PREFIX = 'audit|';
export const AUDIT_RETENTION_DAYS = 365;
// A single write touching more items than this records the first ones and
// one summary row, so a bulk import can't produce a runaway log.
export const AUDIT_MAX_ROWS_PER_WRITE = 500;

export interface AuditEntry {
  at: number;             // ms since epoch
  user: string;           // username, or the attempted one for a failed sign-in
  role?: string;
  action: string;         // human-readable, e.g. "Updated job", "Signed in"
  projectId?: string | null;
  projectName?: string;
  item?: string;          // name of the job/card/event/account involved
  itemId?: string;
  ip?: string;
  details?: string;
}

export function auditKey(at: number, seq: string): string {
  return AUDIT_PREFIX + String(Math.max(0, Math.floor(at))).padStart(15, '0') + '|' + seq;
}

const KIND_LABEL: Record<string, string> = { jobs: 'job', boardCards: 'board card', calendarEvents: 'calendar event' };
// Project fields whose change is worth a row; the rest (rev, fieldRevisions,
// activityLog, deletedIds) are bookkeeping that follows other changes.
const FIELD_LABEL: Record<string, string> = {
  name: 'Renamed project', boardColumns: 'Changed board columns', workflowItems: 'Changed workflow items',
  fieldOptions: 'Changed field options', header: 'Changed project header',
};

function itemName(kind: string, item: any): string {
  if (!item || typeof item !== 'object') return '';
  const v = kind === 'jobs' ? item.name : item.title;
  return typeof v === 'string' ? v.slice(0, 200) : '';
}

// Turns one saved write into audit rows. prev/next are the room before and
// after; delta is computeRoomDelta(prev, next).
export function describeChange(prev: RoomState, next: RoomState, delta: RoomDelta, who: { user: string; role?: string; ip?: string }, at: number): AuditEntry[] {
  const rows: AuditEntry[] = [];
  const base = { at: at, user: who.user, role: who.role, ip: who.ip };
  Object.keys(delta.projects).forEach(function (pid) {
    const d = delta.projects[pid] as Record<string, any>;
    const before = (prev.projects || {})[pid] as any;
    const after = (next.projects || {})[pid] as any;
    const projectName = (after && after.name) || (before && before.name) || '';
    const row = function (action: string, extra?: Partial<AuditEntry>): void {
      rows.push(Object.assign({}, base, { action: action, projectId: pid, projectName: projectName }, extra || {}));
    };
    if (d.projectRemoved) { row('Removed project'); return; }
    if (d.replace) { row('Added project'); return; }
    (['jobs', 'boardCards', 'calendarEvents'] as const).forEach(function (kind) {
      const label = KIND_LABEL[kind];
      const changed = (d[kind] || {}) as Record<string, any>;
      Object.keys(changed).forEach(function (id) {
        const existed = !!(before && before[kind] && before[kind][id]);
        const item = changed[id];
        let action = (existed ? 'Updated ' : 'Created ') + label;
        if (kind === 'jobs' && existed && before[kind][id].archived !== item.archived) action = item.archived ? 'Archived job' : 'Restored job';
        row(action, { item: itemName(kind, item), itemId: id });
      });
      const removed = (d.removedIds && d.removedIds[kind]) || [];
      removed.forEach(function (id: string) {
        row('Deleted ' + label, { item: itemName(kind, before && before[kind] && before[kind][id]), itemId: id });
      });
    });
    Object.keys(FIELD_LABEL).forEach(function (field) {
      if (!(field in d)) return;
      if (field === 'name') row(FIELD_LABEL[field], { details: 'from "' + ((before && before.name) || '') + '" to "' + ((after && after.name) || '') + '"' });
      else row(FIELD_LABEL[field]);
    });
  });
  if (rows.length > AUDIT_MAX_ROWS_PER_WRITE) {
    const extra = rows.length - AUDIT_MAX_ROWS_PER_WRITE + 1;
    const kept = rows.slice(0, AUDIT_MAX_ROWS_PER_WRITE - 1);
    kept.push(Object.assign({}, base, { action: 'Bulk change', details: extra + ' more item changes in the same save' }));
    return kept;
  }
  return rows;
}

// For the Worker's HTTP handlers: appends an entry via the room Durable
// Object. Best-effort — an audit failure never blocks the action itself,
// but it is logged.
export async function recordAudit(env: Env, entry: Omit<AuditEntry, 'at'> & { at?: number }): Promise<void> {
  try {
    const full = Object.assign({ at: Date.now() }, entry);
    const res = await getRoomStub(env).fetch('https://internal/internal/audit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entries: [full] })
    });
    if (!res.ok) console.error('Audit write failed:', res.status, entry.action);
  } catch (e) {
    console.error('Audit write failed:', e, entry.action);
  }
}

export function clientIp(request: Request): string {
  return (request && request.headers && request.headers.get('CF-Connecting-IP')) || '';
}
