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
// The dark shade starts at 60% darker and keeps darkening until it reaches
// WCAG's 4.5:1 for small text (A5) — a fixed 60% fell just short on some
// mid-tone pastels (e.g. 4.28:1 on #f48fb1).
export function columnLabelTextColor(bg: string): string {
  const rgb = parseHexRGB(bg);
  if (!rgb) return '#fff';
  const bgLum = luminanceFromRGB(rgb[0], rgb[1], rgb[2]);
  const h = bg.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const num = parseInt(full, 16) || 0;
  const luminance = (0.299 * ((num >> 16) & 255) + 0.587 * ((num >> 8) & 255) + 0.114 * (num & 255)) / 255;
  if (luminance < 0.5) return contrastRatio(1, bgLum) >= 4.5 ? '#fff' : DARK_TEXT_COLOR;
  for (let amt = 0.6; amt < 0.95; amt += 0.05) {
    const shade = rgb.map((c) => Math.round(c * (1 - amt)));
    if (contrastRatio(luminanceFromRGB(shade[0], shade[1], shade[2]), bgLum) >= 4.5) return 'rgb(' + shade.join(',') + ')';
  }
  return DARK_TEXT_COLOR;
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
export function tintedTextColor(color: string, bg: string, targetContrast?: number): string {
  const base = parseHexRGB(color);
  const bgRgb = parseHexRGB(bg);
  if (!base || !bgRgb) return color;
  const bgLum = luminanceFromRGB(bgRgb[0], bgRgb[1], bgRgb[2]);
  // 4.5 = WCAG AA for normal-size text (was 3.2 before the A5 pass).
  const TARGET_CONTRAST = targetContrast || 4.5;
  // Already readable: keep the color itself rather than shifting it.
  if (contrastRatio(luminanceFromRGB(base[0], base[1], base[2]), bgLum) >= TARGET_CONTRAST) return 'rgb(' + base.join(',') + ')';
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

// Gantt bar fills (Karl, 2026-09-29, the "Soft" restyle): a light pastel of
// the stage/job color, mixed in CSS against --gantt-bar-base (white, or the
// dark card color in dark mode) so it follows a dark-mode switch without a
// re-render. How much of the color is kept is a CSS variable too, because
// dark mode needs more of it: a third of the color over a dark base read
// as nearly black (Karl, 2026-09-30). `strong` is the deeper shade used for
// the second stripe of a one-color overlap hatch.
export function ganttPastel(color: string | null | undefined, strong?: boolean): string {
  return 'color-mix(in srgb, ' + (color || '#3949ab') + ' var(--gantt-bar-pct' + (strong ? '-strong' : '') + '), var(--gantt-bar-base))';
}
// A soft tinted chip (stage tags, job tags): a light tint of `color` with
// text in a deeper shade of it. Mixed in CSS (--gantt-chip-* in index.html)
// so dark mode flips it without a re-render.
export function softChip(color: string | null | undefined): { background: string; color: string } {
  const c = color || '#3949ab';
  return {
    background: 'color-mix(in srgb, ' + c + ' var(--gantt-chip-bg-pct), var(--gantt-bar-base))',
    color: 'color-mix(in srgb, ' + c + ' var(--gantt-chip-ink-pct), var(--gantt-chip-ink-base))',
  };
}
// The same pastel as a plain hex over white, for contrast math on the
// light-mode text sitting on it (dark mode sets bar text in CSS).
export function ganttPastelHex(color: string | null | undefined): string {
  return softenColor(color, 0.66);
}

// Contrast target for job names (Gantt rows, the Jobs list, Board cards):
// WCAG AA, so names stay as close to the job's own color as they can while
// still readable. Was 6 until Karl found the names too dark (2026-09-29).
export const JOB_NAME_CONTRAST = 4.5;

// ===== Board column colors: Trello's list palette (Karl, 2026-09-30) =====
// `base` is what a column stores (and what its Gantt/Calendar stage color
// is mixed from); `bg` and `title` are the column's background and title
// on the Board. Blue, yellow, orange, red and purple were read straight
// off Karl's Trello board; the rest are Atlassian's matching tokens.
export interface BoardColor { name: string; base: string; bg: string; title: string }
export const BOARD_COLORS: BoardColor[] = [
  { name: 'Green', base: '#4bce97', bg: '#baf3db', title: '#164b35' },
  { name: 'Yellow', base: '#e2b203', bg: '#f5e989', title: '#533f04' },
  { name: 'Orange', base: '#faa53d', bg: '#fce4a6', title: '#693200' },
  { name: 'Red', base: '#f87462', bg: '#ffd5d2', title: '#5d1f1a' },
  { name: 'Purple', base: '#c97cf4', bg: '#eed7fc', title: '#48245d' },
  { name: 'Blue', base: '#579dff', bg: '#cfe1fd', title: '#123263' },
  { name: 'Teal', base: '#6cc3e0', bg: '#c6edfb', title: '#164555' },
  { name: 'Lime', base: '#94c748', bg: '#d3f1a7', title: '#37471f' },
  { name: 'Pink', base: '#e774bb', bg: '#fdd0ec', title: '#50253f' },
  { name: 'Gray', base: '#8590a2', bg: '#dcdfe4', title: '#172b4d' },
];

export function boardColorFor(color: string | null | undefined): BoardColor | null {
  const c = (color || '').toLowerCase();
  return BOARD_COLORS.find((b) => b.base === c) || null;
}

function hueSat(rgb: [number, number, number]): { h: number; s: number } {
  const r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return { h: 0, s: 0 };
  const l = (max + min) / 2;
  const sat = d / (1 - Math.abs(2 * l - 1));
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return { h, s: sat };
}

// The old Board palette's cyan (made from #00bcd4) is Karl's Design column,
// which he asked to be Trello's blue rather than its teal.
const OLD_CYAN = '#4dd0e1';

// Moves a column color from the old palette onto the Trello one: a color
// already in the palette is kept, anything else goes to the nearest hue
// (greys to Gray). Run when a project's columns load, so existing boards
// switch over without anyone re-picking each column.
export function toBoardColor(color: string | null | undefined): string | undefined {
  if (!color) return undefined;
  const c = color.toLowerCase();
  if (boardColorFor(c)) return c;
  if (c === OLD_CYAN) return '#579dff';
  const rgb = parseHexRGB(c);
  if (!rgb) return color;
  const hs = hueSat(rgb);
  if (hs.s < 0.15) return '#8590a2';
  let best = BOARD_COLORS[0], bestDist = 999;
  BOARD_COLORS.forEach(function (b) {
    if (b.name === 'Gray') return;
    const bh = hueSat(parseHexRGB(b.base) as [number, number, number]).h;
    const dist = Math.min(Math.abs(bh - hs.h), 360 - Math.abs(bh - hs.h));
    if (dist < bestDist) { bestDist = dist; best = b; }
  });
  return best.base;
}

// A column's background and title on the Board (and Home's Board widget).
// Palette colors use Trello's exact pair; any other color (tests, old data
// not yet loaded through toBoardColor()) falls back to a lightened fill
// with a darker shade of itself for the title.
export function boardColumnColors(color: string): { background: string; title: string } {
  const b = boardColorFor(color);
  if (b) return { background: b.bg, title: b.title };
  return { background: softenColor(color, 0.42), title: columnLabelTextColor(color) };
}
