/**
 * Formats a duration (ms) as `Nm SSs` where SS is zero-padded to 2 digits.
 * - NaN, negative, or missing input → '0m 00s'
 * - 0 minutes → '0m SSs'
 * - >= 60 minutes just keeps showing as minutes (e.g. '120m 20s')
 */
export function formatNmSSs(ms: number): string {
  if (ms === undefined || ms === null || Number.isNaN(ms) || ms < 0) {
    return '0m 00s';
  }
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}
