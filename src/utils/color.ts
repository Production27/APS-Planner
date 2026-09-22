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

// Text color for a label sitting on a board column's own color — the
// Trello-style rule the Board's column headers use: white on a dark
// background, otherwise a much darker shade of the same hue. Shared so a
// Gantt task pill (which mirrors its column's color) reads identically.
export function columnLabelTextColor(bg: string): string {
  const h = bg.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const num = parseInt(full, 16) || 0;
  const luminance = (0.299 * ((num >> 16) & 255) + 0.587 * ((num >> 8) & 255) + 0.114 * (num & 255)) / 255;
  return luminance < 0.5 ? '#fff' : darkenColor(bg, 0.6);
}

// Dark slate used for text on light backgrounds — same family as the app's
// other dark text colors rather than pure black, so it reads softer on pastels.
export const DARK_TEXT_COLOR = '#1f2937';

// Shared by relativeLuminance()/tintedTextColor() below — null for
// anything that isn't a '#rgb'/'#rrggbb' string.
function parseHexRGB(hex: string): [number, number, number] | null {
  let h = (hex || '').trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  const num = parseInt(h, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function luminanceFromRGB(r: number, g: number, b: number): number {
  const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// WCAG relative luminance of a '#rgb'/'#rrggbb' color, or null if unparsable.
function relativeLuminance(hex: string): number | null {
  const rgb = parseHexRGB(hex);
  return rgb ? luminanceFromRGB(rgb[0], rgb[1], rgb[2]) : null;
}

function contrastRatio(l1: number, l2: number): number {
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

// A readable variant of `color` for small bold text sitting on `bg` —
// unlike readableTextColor() (which snaps to plain white or a dark
// neutral), this keeps `color`'s own hue: it darkens or lightens `color`
// toward black/white, whichever direction increases contrast against
// `bg`, in small steps until a small-bold-text contrast target is met.
// Capped so a near-white or near-black job color never fully vanishes
// into its own (similarly pale/dark) tinted background — past the cap it
// just returns the most-shifted attempt rather than looping forever.
export function tintedTextColor(color: string, bg: string): string {
  const base = parseHexRGB(color);
  const bgRgb = parseHexRGB(bg);
  if (!base || !bgRgb) return color;
  const bgLum = luminanceFromRGB(bgRgb[0], bgRgb[1], bgRgb[2]);
  const TARGET_CONTRAST = 3.2;
  const shift = (amt: number, towardBlack: boolean): [number, number, number] => {
    const toward = towardBlack ? 0 : 255;
    const mix = (c: number) => Math.max(0, Math.min(255, Math.round(c + (toward - c) * amt)));
    return [mix(base[0]), mix(base[1]), mix(base[2])];
  };
  // A light bg needs darker text and vice versa; try that direction first,
  // then fall back to the other if it can't reach the target within its cap.
  const order: boolean[] = bgLum >= 0.5 ? [true, false] : [false, true];
  let fallback: [number, number, number] = base;
  for (const towardBlack of order) {
    const cap = towardBlack ? 0.75 : 0.85;
    for (let amt = 0.1; amt <= cap; amt += 0.08) {
      const rgb = shift(amt, towardBlack);
      if (contrastRatio(luminanceFromRGB(rgb[0], rgb[1], rgb[2]), bgLum) >= TARGET_CONTRAST) {
        return 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';
      }
      fallback = rgb;
    }
  }
  return 'rgb(' + fallback[0] + ',' + fallback[1] + ',' + fallback[2] + ')';
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
