export const DARK_PALETTE = {
  bg: '#1A1A1A',
  surface: '#242424',
  accent: '#CD7F5C',
  accentSoft: '#8F5B45',
  accentBg: '#3A231C',
  text: '#F0E8E0',
  textMuted: '#8F8880',
  grid: '#2E2E2E',
} as const;

// Rec.601 Y luminance of each step (verified against dark-palette.test.ts):
//   #1F1F1F → 31.00
//   #3A231C → 41.26
//   #6B3F30 → 73.11
//   #A06048 → 109.65
//   #CD7F5C → 146.33
// Strictly monotonic ascending — enforced by the `luminance strictly
// monotonically increases` test. Keep upper bound spacing ≥ ~35 between
// neighbors so heatmap cells stay visually distinguishable at all DPIs.
export const HEATMAP_SCALE = ['#1F1F1F', '#3A231C', '#6B3F30', '#A06048', '#CD7F5C'] as const;

/** Y = 0.299R + 0.587G + 0.114B — returns 0..255 */
export function luminance(hex: string): number {
  const clean = hex.startsWith('#') ? hex.slice(1) : hex;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}
