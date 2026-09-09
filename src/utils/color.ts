// Moved verbatim from index.html as part of Phase 2 of the architecture
// roadmap — pure color math, no DOM or shared-state dependency.

export function darkenColor(hex: string | null | undefined, amount: number): string {
  hex = (hex || '#3949ab').replace('#', '');
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  const num = parseInt(hex, 16) || 0;
  const r = Math.max(0, Math.round(((num >> 16) & 255) * (1 - amount)));
  const g = Math.max(0, Math.round(((num >> 8) & 255) * (1 - amount)));
  const b = Math.max(0, Math.round((num & 255) * (1 - amount)));
  return 'rgb(' + r + ',' + g + ',' + b + ')';
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
