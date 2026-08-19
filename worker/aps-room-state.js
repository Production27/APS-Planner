// ==========================================
// APS Planner — Room state reducer (pure logic, no Durable Object/
// Cloudflare runtime dependencies)
// ==========================================
//
// This module is the correctness-critical core of the Liveblocks
// replacement: given the room's current state and one incoming message
// from a client, decide what (if anything) changes. It's deliberately
// dependency-free — no `state.storage`, no `WebSocket`, nothing
// Workers-specific — so it can be unit-tested in a plain browser/headless
// Chrome environment exactly like every other piece of logic tested this
// session, without needing a real Durable Objects runtime (none is
// available in this dev environment).
//
// The actual Durable Object class (aps-room-do.js) is a thin wrapper:
// it owns the WebSocket/hibernation plumbing and `state.storage`
// persistence, but every actual decision about what a message means goes
// through applyMessage() here.
//
// ---- Why this exists (read before changing anything) ----
//
// Liveblocks' CRDT Storage used to make two classes of bug impossible by
// construction; a hand-rolled backend has to earn both explicitly:
//
// 1. STALENESS, not concurrency. A Durable Object processes one message
//    at a time, so two writes never truly race server-side — but that
//    does NOT mean a late-arriving stale write can't clobber a newer
//    value. The historical bugs this app already fixed once (a job
//    vanishing, a "hide column from schedule" toggle silently reverting)
//    were BOTH caused by a client pushing an old whole-value snapshot
//    after a newer one had already landed — single-threaded processing
//    replays that exact bug faithfully unless something explicitly
//    rejects the stale write. That's what fieldRevisions below is for.
// 2. DELETE SAFETY. A local snapshot can be stale relative to the shared
//    room (e.g. a tab that deferred applying a remote update while the
//    user was mid-edit — see index.html's isBusyEditing()). Diffing "what's
//    missing from my snapshot" and deleting it remotely would risk
//    destroying a teammate's concurrent addition. So deletes are only
//    ever explicit (deleteFromMap/recordTombstone messages), never
//    inferred from an upsert's absence — upserts are pure adds/updates,
//    full stop.

const TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — matches the client's existing constant
const ACTIVITY_LOG_CAP = 50;

function mergeTombstones(a, b) {
  const merged = Object.assign({}, a || {}, b || {});
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  Object.keys(merged).forEach(function (id) {
    if (!merged[id] || merged[id] < cutoff) delete merged[id];
  });
  return merged;
}

function blankProject(name) {
  return {
    name: name || 'Untitled Project',
    jobs: {},
    boardCards: {},
    calendarEvents: {},
    boardColumns: [],
    fieldOptions: {},
    deletedIds: {},
    header: { title: name || 'Untitled', subtitle: '', theme: { c1: '#1a237e', c2: '#3949ab' } },
    activityLog: [],
    rev: 0,
    fieldRevisions: { boardColumns: 0, fieldOptions: 0, header: 0 }
  };
}

function cloneRoomState(state) {
  // Structured-clone-equivalent deep copy. Every accepted mutation
  // produces a brand new state object (never mutates the one passed in)
  // so callers (tests, the DO's own before/after comparison) can rely on
  // reference equality to mean "nothing changed."
  return JSON.parse(JSON.stringify(state));
}

function ensureProject(state, projectId, seedName) {
  if (state.projects[projectId]) return state;
  const next = cloneRoomState(state);
  next.projects[projectId] = blankProject(seedName);
  return next;
}

function emptyRoomState() {
  return { projects: {} };
}

// ---- Per-message-type handlers ----
// Each takes (project, msg) and returns { project, changed } — project is
// either the same reference (unchanged) or a new object (changed). None
// of these touch state.projects directly; applyMessage() below handles
// the project lookup/creation and reassembly.

function handleUpsertJob(project, msg) {
  const job = msg.job;
  if (!job || !job.id) return { project, changed: false, error: 'upsertJob missing job.id' };
  if (project.deletedIds[job.id]) return { project, changed: false }; // tombstoned — silently ignored, not an error
  const existing = project.jobs[job.id];
  const incomingUpdatedAt = job.updatedAt || 0;
  if (existing && (existing.updatedAt || 0) > incomingUpdatedAt) {
    return { project, changed: false, rejected: 'stale' }; // a newer version is already stored
  }
  const next = cloneRoomState({ projects: { p: project } }).projects.p;
  next.jobs[job.id] = job;
  next.rev++;
  return { project: next, changed: true };
}

function handleUpsertCard(project, msg) {
  const card = msg.card;
  if (!card || !card.id) return { project, changed: false, error: 'upsertCard missing card.id' };
  if (project.deletedIds[String(card.id)]) return { project, changed: false };
  const existing = project.boardCards[card.id];
  const incomingUpdatedAt = card.updatedAt || 0;
  if (existing && (existing.updatedAt || 0) > incomingUpdatedAt) {
    return { project, changed: false, rejected: 'stale' };
  }
  const next = cloneRoomState({ projects: { p: project } }).projects.p;
  next.boardCards[card.id] = card;
  next.rev++;
  return { project: next, changed: true };
}

function handleUpsertCalendarEvent(project, msg) {
  const event = msg.event;
  if (!event || !event.id) return { project, changed: false, error: 'upsertCalendarEvent missing event.id' };
  if (project.deletedIds[String(event.id)]) return { project, changed: false };
  const existing = project.calendarEvents[event.id];
  const incomingUpdatedAt = event.updatedAt || 0;
  if (existing && (existing.updatedAt || 0) > incomingUpdatedAt) {
    return { project, changed: false, rejected: 'stale' };
  }
  const next = cloneRoomState({ projects: { p: project } }).projects.p;
  next.calendarEvents[event.id] = event;
  next.rev++;
  return { project: next, changed: true };
}

// Shared implementation for the three whole-value fields — each is
// staleness-checked against its OWN revision counter (not the project's
// overall `rev`), so an edit to boardColumns is only ever rejected by a
// newer boardColumns edit, never by an unrelated job/card upsert that
// happened to land in between. This precision is what avoids the coarse
// version spuriously rejecting unrelated edits.
function handleSetWholeField(project, msg, fieldName) {
  const currentRev = project.fieldRevisions[fieldName] || 0;
  const baseRev = typeof msg.baseFieldRevision === 'number' ? msg.baseFieldRevision : -1;
  if (baseRev < currentRev) {
    return { project, changed: false, rejected: 'stale', currentFieldRevision: currentRev };
  }
  const next = cloneRoomState({ projects: { p: project } }).projects.p;
  next[fieldName] = msg.value;
  next.fieldRevisions[fieldName] = currentRev + 1;
  next.rev++;
  return { project: next, changed: true, newFieldRevision: currentRev + 1 };
}

function handleDeleteFromMap(project, msg) {
  const mapKey = msg.mapKey; // 'jobs' | 'boardCards' | 'calendarEvents'
  const id = String(msg.id);
  if (!['jobs', 'boardCards', 'calendarEvents'].includes(mapKey)) {
    return { project, changed: false, error: 'deleteFromMap: invalid mapKey' };
  }
  const next = cloneRoomState({ projects: { p: project } }).projects.p;
  const hadEntry = Object.prototype.hasOwnProperty.call(next[mapKey], id) ||
    Object.prototype.hasOwnProperty.call(next[mapKey], msg.id);
  delete next[mapKey][id];
  delete next[mapKey][msg.id];
  next.deletedIds = mergeTombstones(next.deletedIds, { [id]: Date.now() });
  next.rev++;
  return { project: next, changed: true, hadEntry };
}

function handleRecordTombstone(project, msg) {
  const id = String(msg.id);
  const next = cloneRoomState({ projects: { p: project } }).projects.p;
  next.deletedIds = mergeTombstones(next.deletedIds, { [id]: Date.now() });
  next.rev++;
  return { project: next, changed: true };
}

function handleLogActivity(project, msg) {
  const next = cloneRoomState({ projects: { p: project } }).projects.p;
  next.activityLog.push({ who: msg.who || 'Someone', what: msg.what || '', when: msg.when || Date.now() });
  while (next.activityLog.length > ACTIVITY_LOG_CAP) next.activityLog.shift();
  next.rev++;
  return { project: next, changed: true };
}

const WHOLE_FIELD_TYPES = {
  setBoardColumns: 'boardColumns',
  setFieldOptions: 'fieldOptions',
  setHeader: 'header'
};

// The client's routine (debounced) save batches every job/card/calendar-
// event in the active project into ONE message rather than one per item —
// same reasoning as the old Liveblocks-era pushProjectToShared() batching
// multiple writes into one room.batch() call: a save can easily touch a
// few dozen items, and this keeps that down to one storage write and one
// broadcast instead of dozens of each. Each item inside still gets its
// own independent staleness check (an old item in the same batch doesn't
// get to piggyback past a newer one already stored), matching exactly
// what would happen if they'd been sent as separate upsertJob/upsertCard/
// upsertCalendarEvent messages.
//
// header is intentionally NOT staleness-protected here the way
// setBoardColumns/setFieldOptions/setHeader are (via baseFieldRevision) —
// this mirrors the pre-migration behavior exactly (the old
// pushProjectToShared() wrote header unconditionally on every routine
// save too, while boardColumns/fieldOptions were deliberately excluded
// from that same path specifically because THEY don't have this
// protection). It's a known, low-priority gap carried over as-is rather
// than solved here: title/subtitle edits are rare and low-conflict in
// practice, which is presumably why this was never the source of a
// reported bug the way the boardColumns exclusion's absence was. Revisit
// if that ever changes — the dedicated setHeader message type (with full
// revision protection) already exists for exactly that upgrade path.
function handleUpsertProjectBatch(project, msg) {
  let next = project;
  let changed = false;
  function ensureCloned() { if (next === project) next = cloneRoomState({ projects: { p: next } }).projects.p; }

  if (typeof msg.name === 'string' && msg.name !== next.name) {
    ensureCloned();
    next.name = msg.name;
    changed = true;
  }

  (msg.jobs || []).forEach(function (job) {
    if (!job || !job.id) return;
    if (next.deletedIds[job.id]) return;
    const existing = next.jobs[job.id];
    if (existing && (existing.updatedAt || 0) > (job.updatedAt || 0)) return;
    ensureCloned();
    next.jobs[job.id] = job;
    changed = true;
  });

  (msg.boardCards || []).forEach(function (card) {
    if (!card || !card.id) return;
    if (next.deletedIds[String(card.id)]) return;
    const existing = next.boardCards[card.id];
    if (existing && (existing.updatedAt || 0) > (card.updatedAt || 0)) return;
    ensureCloned();
    next.boardCards[card.id] = card;
    changed = true;
  });

  (msg.calendarEvents || []).forEach(function (ev) {
    if (!ev || !ev.id) return;
    if (next.deletedIds[String(ev.id)]) return;
    const existing = next.calendarEvents[ev.id];
    if (existing && (existing.updatedAt || 0) > (ev.updatedAt || 0)) return;
    ensureCloned();
    next.calendarEvents[ev.id] = ev;
    changed = true;
  });

  if (msg.header && typeof msg.header === 'object') {
    ensureCloned();
    next.header = msg.header;
    changed = true;
  }

  if (!changed) return { project, changed: false };
  next.rev++;
  return { project: next, changed: true };
}

// The main entry point. Returns:
//   { state, changed, ack: {type:'ack', msgId}, rejected?: {...}, error?: string }
// `state` is always a valid room state — on error/rejection it's just the
// unchanged input passed back, never partially applied.
function applyMessage(state, msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
    return { state, changed: false, error: 'malformed message' };
  }
  if (!msg.projectId) {
    return { state, changed: false, error: 'message missing projectId' };
  }

  let working = ensureProject(state, msg.projectId, msg.seedProjectName);
  const project = working.projects[msg.projectId];
  let result;

  switch (msg.type) {
    case 'upsertJob': result = handleUpsertJob(project, msg); break;
    case 'upsertCard': result = handleUpsertCard(project, msg); break;
    case 'upsertCalendarEvent': result = handleUpsertCalendarEvent(project, msg); break;
    case 'upsertProjectBatch': result = handleUpsertProjectBatch(project, msg); break;
    case 'setBoardColumns': result = handleSetWholeField(project, msg, 'boardColumns'); break;
    case 'setFieldOptions': result = handleSetWholeField(project, msg, 'fieldOptions'); break;
    case 'setHeader': result = handleSetWholeField(project, msg, 'header'); break;
    case 'deleteFromMap': result = handleDeleteFromMap(project, msg); break;
    case 'recordTombstone': result = handleRecordTombstone(project, msg); break;
    case 'logActivity': result = handleLogActivity(project, msg); break;
    case 'renameProject': {
      const next = cloneRoomState({ projects: { p: project } }).projects.p;
      next.name = msg.name || next.name;
      next.rev++;
      result = { project: next, changed: true };
      break;
    }
    default:
      return { state, changed: false, error: 'unknown message type: ' + msg.type };
  }

  if (result.error) return { state, changed: false, error: result.error };
  if (!result.changed) {
    return {
      state,
      changed: false,
      rejected: result.rejected ? { reason: result.rejected, currentFieldRevision: result.currentFieldRevision } : undefined,
      ack: { type: 'ack', msgId: msg.msgId }
    };
  }

  const newState = cloneRoomState(working);
  newState.projects[msg.projectId] = result.project;
  return {
    state: newState,
    changed: true,
    ack: { type: 'ack', msgId: msg.msgId, newFieldRevision: result.newFieldRevision }
  };
}

// Removes a project entirely (mirrors removeProjectFromShared — currently
// unused app-wide since project deletion is disabled, kept for parity).
function removeProject(state, projectId) {
  if (!state.projects[projectId]) return { state, changed: false };
  const next = cloneRoomState(state);
  delete next.projects[projectId];
  return { state: next, changed: true };
}

module.exports = {
  TOMBSTONE_TTL_MS,
  ACTIVITY_LOG_CAP,
  mergeTombstones,
  blankProject,
  emptyRoomState,
  ensureProject,
  applyMessage,
  removeProject
};
// Also expose as globals for the no-module-system headless-Chrome test
// harness (same pattern used for every other pure-logic test this
// session) and for inlining into the single-file Worker deploy, which
// has no import/require system either.
if (typeof window !== 'undefined') {
  window.ApsRoomState = module.exports;
}
