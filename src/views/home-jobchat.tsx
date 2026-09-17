import { render } from 'preact';

// Home dashboard's Job Chat feed (#homeJobChatList) — a static, empty
// element from index.html exclusively written to by renderHomeJobChat()
// (see home.ts) and nothing else, same "safe to hand over directly, no
// wrapper needed" case as Calendar's hourly grid (see
// calendar-hourgrid.tsx's own comment).
//
// A reply row's open/closed state (toggleHomeReplyBox(), still in
// home.ts, unchanged) is a classList/style.display toggle entirely
// outside this component's own props, same as Board's settings dropdown
// (see board-column-chrome.tsx's own comment) — Preact only ever rewrites
// a prop whose declared value actually changed, and this component never
// declares style.display for the reply row, so an open reply box quietly
// survives a re-render triggered by an unrelated comment arriving
// elsewhere. Unlike Board's dropdown, there's no evidence the original
// code ever wanted a rebuild to force every reply box closed (no
// "close all" call anywhere outside toggleHomeReplyBox() itself, which
// already closes every OTHER one whenever you open a new one) — so this
// is a plain behavioral improvement, not something needing a matching
// "close on rebuild" fix.

export interface JobChatReply {
  replyKey: string;
  author: string;
  whenLabel: string;
  text: string;
  onDelete: () => void;
}

export interface JobChatItemProps {
  itemKey: string;
  jobName: string;
  jobColor: string;
  important: boolean;
  author: string;
  whenLabel: string;
  text: string;
  replies: JobChatReply[];
  replyRowId: string;
  replyTextareaId: string;
  onOpenJob: (e: MouseEvent | KeyboardEvent) => void;
  onDeleteComment: () => void;
  onToggleReply: (e: MouseEvent) => void;
  onReplyKeyDown: (e: KeyboardEvent) => void;
  onPostReply: () => void;
}

function onEnterOrSpace(fn: (e: KeyboardEvent) => void) {
  return (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(e); } };
}

function ReplyItem(p: JobChatReply) {
  return (
    <div class="job-comment-reply-item">
      <div class="job-comment-meta">
        <span class="job-comment-author" title={p.author}>{p.author}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span class="job-comment-when">{p.whenLabel}</span>
          <button class="job-comment-delete" data-min-tier="commenter" title="Delete reply" onClick={p.onDelete}>×</button>
        </span>
      </div>
      <div class="job-comment-text">{p.text}</div>
    </div>
  );
}

function JobChatItem(p: JobChatItemProps) {
  return (
    <div class="job-comment-item">
      <div class="job-comment-meta">
        <span style={{ display: 'flex', alignItems: 'center' }}>
          <span class="job-chat-source" tabIndex={0} role="button" title={'Open ' + p.jobName} onClick={p.onOpenJob} onKeyDown={onEnterOrSpace(p.onOpenJob)}>
            <span class="job-chat-source-dot" style={{ background: p.jobColor }} />
            {p.jobName}
          </span>
          {p.important ? <span class="job-comment-important-badge" title="Marked important">●</span> : null}
          <span class="job-comment-author" title={p.author}>{p.author}</span>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span class="job-comment-when">{p.whenLabel}</span>
          <button class="job-comment-delete" data-min-tier="commenter" title="Delete comment" onClick={p.onDeleteComment}>×</button>
        </span>
      </div>
      <div class="job-comment-text">{p.text}</div>
      {p.replies.length ? (
        <div class="job-comment-replies">
          {p.replies.map((r) => <ReplyItem key={r.replyKey} {...r} />)}
        </div>
      ) : null}
      <button class="job-comment-reply-btn" onClick={p.onToggleReply}>Reply{p.replies.length ? ' (' + p.replies.length + ')' : ''}</button>
      <div class="job-comment-reply-input-row" id={p.replyRowId}>
        <textarea id={p.replyTextareaId} data-min-tier="commenter" placeholder="Write a reply..." onKeyDown={p.onReplyKeyDown} />
        <button class="btn btn-primary" data-min-tier="commenter" style={{ alignSelf: 'flex-end', padding: '4px 10px', fontSize: '12px' }} onClick={p.onPostReply}>Post Reply</button>
      </div>
    </div>
  );
}

function JobChatList({ items }: { items: JobChatItemProps[] }) {
  if (!items.length) return <div class="job-comments-empty">No comments yet.</div>;
  return <>{items.map((it) => <JobChatItem key={it.itemKey} {...it} />)}</>;
}

export function renderHomeJobChatListInto(container: HTMLElement, items: JobChatItemProps[]): void {
  render(<JobChatList items={items} />, container);
}
