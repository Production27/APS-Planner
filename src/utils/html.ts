// General-purpose HTML-escaping, used across the whole app. Pure, no DOM
// state dependency beyond creating a throwaway element.

export function escapeHtml(str: string | null | undefined): string {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}
