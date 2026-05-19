/**
 * Format a rate-limit timestamp for Slack display.
 *
 * Produces a single line combining three time representations:
 *   1. Local wall clock in the user's IANA timezone (e.g. `2026-04-18 13:42 KST`).
 *   2. UTC wall clock rendered as `HH:mmZ`.
 *   3. Relative-time suffix (`now` / `Ns ago` / `Nm ago` / `Nh ago` / `Nd ago`).
 *
 * Example:
 *   formatRateLimitedAt('2026-04-18T03:37:00Z', 'Asia/Seoul', Date.parse('2026-04-18T03:42:00Z'))
 *   → '2026-04-18 12:37 KST / 03:37Z (5m ago)'
 *
 * @param isoUtc  ISO 8601 UTC timestamp string.
 * @param userTz  IANA timezone (default `'Asia/Seoul'`).
 * @param nowMs   Override for "now" (epoch ms) — defaults to `Date.now()`.
 */
export function formatRateLimitedAt(isoUtc: string, userTz: string = 'Asia/Seoul', nowMs?: number): string {
  const then = new Date(isoUtc);
  const thenMs = then.getTime();
  if (!Number.isFinite(thenMs)) {
    return isoUtc;
  }
  const now = typeof nowMs === 'number' ? nowMs : Date.now();

  const local = formatLocal(then, userTz);
  const utc = formatUtc(then);
  const relative = formatRelative(Math.max(0, now - thenMs));
  return `${local} / ${utc} (${relative})`;
}

/**
 * Well-known IANA → canonical short abbreviation map used only when
 * `Intl.DateTimeFormat` falls back to `GMT±N`. We prefer Intl's output when
 * it is a "real" letter abbreviation (e.g. `PDT`, `PST`, `EST`, `JST`).
 */
const ZONE_ABBREV: Readonly<Record<string, string>> = {
  'Asia/Seoul': 'KST',
  'Asia/Tokyo': 'JST',
  'Asia/Shanghai': 'CST', // China Standard Time (Intl gives GMT+8)
  'Asia/Hong_Kong': 'HKT',
  'Asia/Singapore': 'SGT',
  'Asia/Bangkok': 'ICT',
  'Asia/Kolkata': 'IST',
  'Europe/London': 'GMT',
  'Europe/Paris': 'CET',
  'Europe/Berlin': 'CET',
  'Australia/Sydney': 'AET',
  UTC: 'UTC',
};

/**
 * Render `YYYY-MM-DD HH:mm TZ` in the given IANA timezone.
 *
 * Timezone abbreviation preference:
 *   1. `Intl.DateTimeFormat(..., timeZoneName: 'short')` — used as-is when
 *      the result is a letter abbreviation (e.g. `PDT`, `PST`, `JST`).
 *   2. For zones where Intl emits `GMT±N`, fall back to a curated
 *      `ZONE_ABBREV` lookup so commonly expected names (e.g. `KST`) surface
 *      without hardcoding.
 *   3. If both fail, emit Intl's raw `GMT±N` string.
 */
function formatLocal(date: Date, userTz: string): string {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: userTz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  });
  const parts = dtf.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '';
  const year = get('year');
  const month = get('month');
  const day = get('day');
  let hour = get('hour');
  const minute = get('minute');
  // en-US occasionally reports hour as '24' for midnight in hour12:false; normalise.
  if (hour === '24') hour = '00';
  const intlTz = get('timeZoneName') || 'UTC';
  // Prefer a curated abbreviation only when Intl emits GMT±N (indicating no
  // canonical short name is available from the runtime). Letter names like
  // `PDT`/`JST` pass through unchanged.
  const isGmtOffset = /^GMT[+-]?\d+/.test(intlTz) || intlTz === 'GMT';
  const tz = isGmtOffset ? (ZONE_ABBREV[userTz] ?? intlTz) : intlTz;
  return `${year}-${month}-${day} ${hour}:${minute} ${tz}`;
}

/** `HH:mmZ` in UTC. */
function formatUtc(date: Date): string {
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}Z`;
}

/**
 * Pick the largest unit ≥ 1 for the relative suffix.
 *   <30s → 'now'
 *   <60s → 'Ns ago'
 *   <60m → 'Nm ago'
 *   <24h → 'Nh ago'
 *   else  → 'Nd ago'
 */
function formatRelative(elapsedMs: number): string {
  const secs = Math.floor(elapsedMs / 1000);
  if (secs < 30) return 'now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
