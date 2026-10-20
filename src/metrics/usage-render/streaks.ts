/**
 * KST (Korea Standard Time) streak utilities.
 *
 * Trace: docs/current/plans/usage-card-dark/trace.md — Scenarios 5, 6.
 *
 * All day keys are 'YYYY-MM-DD' strings computed in KST (UTC+9).
 * Pure functions — no clock, no I/O.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Parse a 'YYYY-MM-DD' key into a UTC-midnight Date (arithmetic anchor).
 * All downstream math is performed in UTC to avoid DST/locale drift; KST
 * has no DST so the calendar advances identically once we live in UTC land.
 */
function dayKeyToUtcDate(key: string): Date {
  const [y, m, d] = key.split('-').map((s) => parseInt(s, 10));
  return new Date(Date.UTC(y, m - 1, d));
}

function formatUtcDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  const d = date.getUTCDate();
  return `${y.toString().padStart(4, '0')}-${m.toString().padStart(2, '0')}-${d.toString().padStart(2, '0')}`;
}

/**
 * Longest consecutive-day run within the set. Returns 0 for an empty set.
 */
export function longestStreak(activeDaySet: Set<string>): number {
  if (activeDaySet.size === 0) return 0;

  const sorted = Array.from(activeDaySet).sort();
  let longest = 1;
  let current = 1;

  for (let i = 1; i < sorted.length; i++) {
    const prev = dayKeyToUtcDate(sorted[i - 1]);
    const curr = dayKeyToUtcDate(sorted[i]);
    const diff = Math.round((curr.getTime() - prev.getTime()) / MS_PER_DAY);
    if (diff === 1) {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 1;
    }
  }

  return longest;
}

/**
 * Current streak ending at `today` (KST 'YYYY-MM-DD').
 * If today ∉ set → 0. Otherwise walk backward one calendar day at a time.
 */
export function currentStreak(activeDaySet: Set<string>, today: string): number {
  if (!activeDaySet.has(today)) return 0;

  let count = 0;
  let cursor = dayKeyToUtcDate(today);
  while (activeDaySet.has(formatUtcDate(cursor))) {
    count += 1;
    cursor = new Date(cursor.getTime() - MS_PER_DAY);
  }
  return count;
}
