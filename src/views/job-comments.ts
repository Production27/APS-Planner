// Job Manager: comments/replies on a job. Pure logic + rendering for the
// Job Manager drawer's own comments panel (#jobCommentsPanel) — the
// actual "post a comment"/"post a reply" functions (postJobComment/
// postJobReply) are also called directly by Home's Job Chat widget (see
// postHomeJobChatComment()/addHomeJobReply() in home.ts), which is why
// this file exists separately from the rest of Job Manager (still in
// index.html) rather than waiting for that whole extraction — Phase 6 of
// the extraction plan already required resolving one shared-infra tangle
// (board.ts's custom fields/attachments) before Job Manager could move at
// all, and this comment system is the next such shared piece: home.ts
// real-imports formatCommentWhen/postJobComment/postJobReply from here,
// while Job Manager's own remaining index.html code (addJobComment(),
// deleteJobComment(), the drawer's compose box, etc.) still lives there
// and calls everything below as ambient globals — same forward-reference
// pattern as the rest of this extraction.
import type { Job } from '../core/types';
import { findJob } from '../core/models';
import { escapeHtml } from '../utils/html';
import { genId } from '../utils/id';
import { getStoredDisplayName, DISPLAY_NAME_KEY } from '../auth/session';
import { logActivity } from '../sync/outbound';
import { renderHomeJobChat } from './home';

export function formatCommentWhen(when: number | undefined): string {
  return when
    ? new Date(when).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
    : 'Imported';
}

export function renderJobComments(job: Job): void {
  // The drawer only ever shows ONE job's comments at a time, in a single
  // shared #jobCommentsList element — without this guard, calling this
  // for a job other than whichever one the drawer currently has open
  // (e.g. deleteJobComment()/addJobReply() reached from the Home Job
  // Chat widget, which acts on jobs regardless of what's open) would
  // silently overwrite that list with the WRONG job's comments while the
  // rest of the drawer (title, fields) kept showing the job that's
  // actually open.
  if (job.id !== editingJobId) return;
  const listEl = document.getElementById('jobCommentsList');
  if (!listEl) return;
  const comments = ((job.comments as any[]) || []).slice().sort(function (a, b) { return (b.when || 0) - (a.when || 0); });

  // Keeps the collapsed tab's badge (see .job-comments-panel.collapsed)
  // in sync — same count convention as the job list's own comment badge.
  const tabCountEl = document.getElementById('jobCommentsTabCount');
  if (tabCountEl) {
    tabCountEl.textContent = String(comments.length);
    tabCountEl.style.display = comments.length ? 'flex' : 'none';
  }
  const importantDotEl = document.getElementById('jobCommentsTabImportantDot');
  if (importantDotEl) {
    (importantDotEl as HTMLElement).style.display = comments.some(function (c) { return c.important; }) ? 'block' : 'none';
  }

  if (!comments.length) {
    listEl.innerHTML = '<div class="job-comments-empty">No comments yet.</div>';
    return;
  }
  listEl.innerHTML = comments.map(function (c) { return renderJobCommentItem(job, c); }).join('');
  applyPermissionGating(); // rebuilt on every comment/reply edit, outside renderAll()'s own sweep
}

export function renderJobCommentItem(job: Job, c: any): string {
  // Oldest-first within a thread so a reply chain reads top-to-bottom.
  const replies = ((c.replies as any[]) || []).slice().sort(function (a, b) { return (a.when || 0) - (b.when || 0); });
  const repliesHtml = replies.map(function (r) {
    return '<div class="job-comment-reply-item">' +
      '<div class="job-comment-meta">' +
        '<span class="job-comment-author" title="' + escapeHtml(r.author || 'Someone') + '">' + escapeHtml(r.author || 'Someone') + '</span>' +
        '<span style="display:flex;align-items:center;gap: var(--s-1);">' +
          '<span class="job-comment-when">' + formatCommentWhen(r.when) + '</span>' +
          '<button class="job-comment-delete" data-min-tier="commenter" onclick="deleteJobReply(\'' + job.id + '\', \'' + c.id + '\', \'' + r.id + '\')" title="Delete reply">×</button>' +
        '</span>' +
      '</div>' +
      '<div class="job-comment-text">' + escapeHtml(r.text) + '</div>' +
    '</div>';
  }).join('');

  return '<div class="job-comment-item">' +
    '<div class="job-comment-meta">' +
      '<span>' +
        (c.important ? '<span class="job-comment-important-badge" title="Marked important">●</span>' : '') +
        '<span class="job-comment-author" title="' + escapeHtml(c.author || 'Someone') + '">' + escapeHtml(c.author || 'Someone') + '</span>' +
      '</span>' +
      '<span style="display:flex;align-items:center;gap: var(--s-1);">' +
        '<span class="job-comment-when">' + formatCommentWhen(c.when) + '</span>' +
        '<button class="job-comment-delete" data-min-tier="commenter" onclick="deleteJobComment(\'' + job.id + '\', \'' + c.id + '\')" title="Delete comment">×</button>' +
      '</span>' +
    '</div>' +
    '<div class="job-comment-text">' + escapeHtml(c.text) + '</div>' +
    (replies.length ? '<div class="job-comment-replies">' + repliesHtml + '</div>' : '') +
    '<button class="job-comment-reply-btn" onclick="toggleReplyBox(\'' + c.id + '\', event)">Reply' + (replies.length ? ' (' + replies.length + ')' : '') + '</button>' +
    '<div class="job-comment-reply-input-row" id="reply-row-' + c.id + '">' +
      '<textarea id="reply-ta-' + c.id + '" data-min-tier="commenter" placeholder="Write a reply..." onkeydown="handleReplyKey(event, \'' + job.id + '\', \'' + c.id + '\')"></textarea>' +
      '<button class="btn btn-primary" data-min-tier="commenter" style="align-self:flex-end;padding: var(--s-1) var(--s-2-5);font-size: var(--t-sm);" onclick="addJobReply(\'' + job.id + '\', \'' + c.id + '\')">Post Reply</button>' +
    '</div>' +
  '</div>';
}

export function toggleReplyBox(commentId: string, event?: Event): void {
  if (event) event.stopPropagation();
  const row = document.getElementById('reply-row-' + commentId);
  if (!row) return;
  const isOpen = row.style.display === 'flex';
  // Only one reply box open at a time keeps the panel from getting cluttered.
  document.querySelectorAll('.job-comment-reply-input-row').forEach(function (r) { (r as HTMLElement).style.display = 'none'; });
  if (!isOpen) {
    row.style.display = 'flex';
    const ta = document.getElementById('reply-ta-' + commentId);
    if (ta) ta.focus();
  }
}

// Shared by the drawer's own reply box and the Home Job Chat widget's
// (see toggleHomeReplyBox()/addHomeJobReply() in home.ts) — the actual
// "post a reply" logic only cares about jobId/commentId/text, not which
// UI surface it came from. Returns the new reply object, or null if
// nothing was posted (empty text, unknown job/comment).
export function postJobReply(jobId: string, commentId: string, text: string | false | undefined): any {
  const found = findJob(jobId);
  if (!found) return null;
  const job = found.job;
  const comment = ((job.comments as any[]) || []).find(function (c) { return c.id === commentId; });
  if (!comment) return null;
  const trimmed = (text || '').trim();
  if (!trimmed) return null;

  let author = getStoredDisplayName();
  if (!author) {
    author = window.prompt('Your name (shown on comments):') || 'Team member';
    localStorage.setItem(DISPLAY_NAME_KEY, author);
  }

  if (!Array.isArray(comment.replies)) comment.replies = [];
  const reply = { id: genId(), author: author, text: trimmed, when: Date.now() };
  comment.replies.push(reply);
  saveJobs();
  logActivity('replied to a comment on job "' + job.name + '"');
  renderJobComments(job); // no-op unless job.id === editingJobId — see that function's own guard
  renderHomeJobChat();
  return reply;
}

export function addJobReply(jobId: string, commentId: string): void {
  const ta = document.getElementById('reply-ta-' + commentId) as HTMLTextAreaElement | null;
  const posted = postJobReply(jobId, commentId, ta ? ta.value : undefined);
  if (posted && ta) ta.value = '';
}

export function deleteJobReply(jobId: string, commentId: string, replyId: string): void {
  const found = findJob(jobId);
  if (!found) return;
  const job = found.job;
  const comment = ((job.comments as any[]) || []).find(function (c) { return c.id === commentId; });
  if (!comment) return;
  comment.replies = ((comment.replies as any[]) || []).filter(function (r) { return r.id !== replyId; });
  saveJobs();
  renderJobComments(job);
  renderHomeJobChat();
}

// Ctrl/Cmd+Enter posts the reply — mirrors handleJobCommentKey below.
export function handleReplyKey(event: KeyboardEvent, jobId: string, commentId: string): void {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    addJobReply(jobId, commentId);
  }
}

// Shared by the drawer's own compose box and the Home Job Chat widget's
// (see postHomeJobChatComment() in home.ts) — same reasoning as
// postJobReply() above. Returns the new comment object, or null if
// nothing was posted.
export function postJobComment(jobId: string, text: string, important: boolean): any {
  const found = findJob(jobId);
  if (!found) return null;
  const trimmed = (text || '').trim();
  if (!trimmed) return null;

  let author = getStoredDisplayName();
  if (!author) {
    author = window.prompt('Your name (shown on comments):') || 'Team member';
    localStorage.setItem(DISPLAY_NAME_KEY, author);
  }

  const job = found.job;
  if (!Array.isArray(job.comments)) job.comments = [];
  const comment = { id: genId(), author: author, text: trimmed, when: Date.now(), important: !!important };
  (job.comments as any[]).push(comment);
  saveJobs();
  logActivity('commented on job "' + job.name + '"' + (important ? ' (marked important)' : ''));
  renderJobComments(job); // no-op unless job.id === editingJobId — see that function's own guard
  renderJobList();
  renderHomeJobChat();
  return comment;
}

export function addJobComment(): void {
  if (!editingJobId) return;
  const textarea = document.getElementById('newJobCommentText') as HTMLTextAreaElement;
  const importantEl = document.getElementById('newJobCommentImportant') as HTMLInputElement | null;
  const posted = postJobComment(editingJobId, textarea.value, !!(importantEl && importantEl.checked));
  if (!posted) return;
  textarea.value = '';
  if (importantEl) importantEl.checked = false;
}

export function deleteJobComment(jobId: string, commentId: string): void {
  const found = findJob(jobId);
  if (!found) return;
  const job = found.job;
  job.comments = ((job.comments as any[]) || []).filter(function (c) { return c.id !== commentId; });
  saveJobs();
  renderJobComments(job);
  renderJobList();
  renderHomeJobChat();
}

// Ctrl/Cmd+Enter posts — plain Enter still inserts a newline, since comments
// are often more than one line.
export function handleJobCommentKey(event: KeyboardEvent): void {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    addJobComment();
  }
}

// Kept in sync with #jobCommentsPanel's own .collapsed (see
// editJob()/openJobDrawer() in index.html) — otherwise the drawer stays
// its full two-panel width and the now-narrow collapsed panel just sits
// centered in a lot of dead space instead of the window actually getting
// smaller.
export function toggleJobCommentsPanel(): void {
  const panel = document.getElementById('jobCommentsPanel');
  if (!panel) return;
  const collapsed = panel.classList.toggle('collapsed');
  const formArea = document.getElementById('formArea');
  if (formArea) formArea.classList.toggle('comments-collapsed', collapsed);
}
