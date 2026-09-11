// Deliberately loose in places (index signatures), matching
// src/core/types.ts's own stated philosophy on the client side: these
// mirror the SAME wire shapes the client sends over the WebSocket, typed
// enough for this file's own reducer/handler functions, not modeling the
// full shape of a job/card/event down to every field. The worker's own
// long-standing rule (see room-state.ts's sanitizeJobCommentAuthors()
// comment) is that job/card content stays an otherwise-unvalidated blob
// by design — these types support that, they don't relitigate it.

export interface JobComment {
  id: string;
  author?: string;
  when?: number | null;
  replies?: JobReply[];
  [key: string]: unknown;
}

export interface JobReply {
  id: string;
  author?: string;
  when?: number | null;
  [key: string]: unknown;
}

export interface Job {
  id: string;
  updatedAt?: number;
  tasks?: unknown[];
  phases?: unknown[];
  comments?: JobComment[];
  [key: string]: unknown;
}

export interface BoardCard {
  id: string | number;
  updatedAt?: number;
  attachments?: unknown[];
  checklists?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CalendarEvent {
  id: string | number;
  updatedAt?: number;
  exceptions?: Record<string, unknown>;
  visibleMembers?: unknown[];
  [key: string]: unknown;
}

export interface ActivityLogEntry {
  who: string;
  what: string;
  when: number;
}

export interface FieldRevisions {
  boardColumns: number;
  fieldOptions: number;
  header: number;
  workflowItems: number;
}

export interface Project {
  name: string;
  jobs: Record<string, Job>;
  boardCards: Record<string, BoardCard>;
  calendarEvents: Record<string, CalendarEvent>;
  boardColumns: unknown[];
  fieldOptions: Record<string, unknown>;
  deletedIds: Record<string, number>;
  header: Record<string, unknown>;
  activityLog: ActivityLogEntry[];
  rev: number;
  fieldRevisions: FieldRevisions;
  [key: string]: unknown;
}

export interface RoomState {
  projects: Record<string, Project>;
}

// The WebSocket connection's own server-verified identity (see
// room-token.ts's signed payload shape) — attached to each socket at
// connect time and read back on every subsequent message.
export interface Attachment {
  username: string;
  displayName: string;
  role: string;
  assignedProjectId: string | null;
  [key: string]: unknown;
}

// Every inbound WebSocket message shares at minimum a `type`; individual
// handlers narrow further via their own destructuring/field access. Kept
// broad (matching the reducer's own historically loose runtime
// validation) rather than a full discriminated union of every message
// type — this models just enough to catch shape mistakes on the fields
// each handler actually dereferences.
export interface RoomMessage {
  type: string;
  projectId?: string;
  msgId?: number;
  [key: string]: unknown;
}

// A stored user account record (USERS_KV, key "user:<username>").
export interface UserRecord {
  username: string;
  displayName: string;
  role: string;
  assignedProjectId: string | null;
  isLead?: boolean;
  passwordHash: string;
  salt: string;
  createdAt: number;
  [key: string]: unknown;
}

// Public-facing shape after resolveIdentity()/resolveIdentityFromToken()
// — same fields regardless of which path (password or token) produced it.
export interface Identity {
  username: string;
  displayName: string;
  role: string;
  assignedProjectId: string | null;
}

// ROOM_TOKEN_SECRET is a Worker secret, intentionally not declared in
// wrangler.jsonc (see that file's own comment) — `wrangler types`
// generates worker-configuration.d.ts's Env from bindings alone, so it
// never includes secrets. This merges in the one this worker actually
// needs; TEAM_PASSWORD/LIVEBLOCKS_SECRET_KEY are historical and unused.
declare global {
  interface Env {
    ROOM_TOKEN_SECRET: string;
  }
}
