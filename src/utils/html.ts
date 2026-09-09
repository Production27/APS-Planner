// Moved verbatim from index.html — general-purpose, used across the
// whole app (not just Board, where it happened to be defined), same
// category as Phase 2's id/date/color utilities: pure, no DOM state
// dependency beyond creating a throwaway element.

export function escapeHtml(str: string | null | undefined): string {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}
