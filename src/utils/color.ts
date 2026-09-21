// Pure color math (hex darken/soften) — no DOM or shared-state
// dependency.

export function darkenColor(hex: string | null | undefined, amount: number): string {
  hex = (hex || '#3949ab').replace('#', '');
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  const num = parseInt(hex, 16) || 0;
  const r = Math.max(0, Math.round(((num >> 16) & 255) * (1 - amount)));
  const g = Math.max(0, Math.round(((num >> 8) & 255) * (1 - amount)));
  const b = Math.max(0, Math.round((num & 255) * (1 - amount)));
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}

// Dark slate used for text on light backgrounds — same family as the app's
// other dark text colors rather than pure black, so it reads softer on pastels.
export const DARK_TEXT_COLOR = '#1f2937';

// WCAG relative luminance of a '#rgb'/'#rrggbb' color, or null if unparsable.
function relativeLuminance(hex: string): number | null {
  let h = (hex || '').trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  const num = parseInt(h, 16);
  const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return 0.2126 * lin((num >> 16) & 255) + 0.7152 * lin((num >> 8) & 255) + 0.0722 * lin(num & 255);
}

// White or dark text, whichever has the higher contrast ratio against `bg`.
// Falls back to white for anything that isn't a hex color.
export function readableTextColor(bg: string | null | undefined): string {
  const lum = relativeLuminance(bg || '');
  if (lum === null) return '#fff';
  const whiteContrast = 1.05 / (lum + 0.05);
  const darkContrast = (lum + 0.05) / (relativeLuminance(DARK_TEXT_COLOR) as number + 0.05);
  return darkContrast > whiteContrast ? DARK_TEXT_COLOR : '#fff';
}

// How far Gantt task bars and board column backgrounds get blended
// toward white — a gentle pastel effect rather than full saturation.
export const SOFTEN_AMOUNT = 0.18;

// Blends a color toward white by `amount` (0-1, defaults to
// SOFTEN_AMOUNT). Returns a hex string (not rgb(), unlike darkenColor
// above) specifically so it composes with isDarkColor(), which needs a
// '#rrggbb' string.
export function softenColor(hex: string | null | undefined, amount?: number): string {
  hex = (hex || '#3949ab').replace('#', '');
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  amount = typeof amount === 'number' ? amount : SOFTEN_AMOUNT;
  const num = parseInt(hex, 16) || 0;
  const blend = (c: number) => Math.max(0, Math.min(255, Math.round(c + (255 - c) * (amount as number))));
  const toHex = (c: number) => c.toString(16).padStart(2, '0');
  const r = blend((num >> 16) & 255);
  const g = blend((num >> 8) & 255);
  const b = blend(num & 255);
  return '#' + toHex(r) + toHex(g) + toHex(b);
}
