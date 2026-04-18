/**
 * Parse Claude rate-limit hints from HTTP response headers.
 *
 * Recognizes the `anthropic-ratelimit-unified-{5h,7d}-*` family:
 *   - `reset`                    → epoch seconds, exposed as `resetAtMs`
 *   - `limit`, `remaining`       → used to derive utilization when `percent` is missing
 *   - `percent`                  → utilization as either 0..100 or 0..1, normalized to 0..1
 *   - `representative-claim`     → opaque string passed through as `claim`
 *
 * Other `anthropic-*` headers (e.g. `anthropic-version`) are ignored.
 */

export interface RateLimitHint {
  window: '5h' | '7d';
  resetAtMs?: number;
  utilization?: number;
  claim?: string;
}

type HeaderBag = Headers | Record<string, string | string[] | undefined>;

type RawHint = {
  reset?: string;
  limit?: string;
  remaining?: string;
  percent?: string;
  claim?: string;
};

const WINDOWS: readonly ('5h' | '7d')[] = ['5h', '7d'];
const PREFIX = 'anthropic-ratelimit-unified-';

function getHeader(bag: HeaderBag, key: string): string | undefined {
  const lower = key.toLowerCase();
  if (typeof (bag as Headers).get === 'function' && bag instanceof Headers) {
    const v = bag.get(lower);
    return v === null ? undefined : v;
  }
  const rec = bag as Record<string, string | string[] | undefined>;
  // Header bags may preserve original casing; normalize.
  for (const k of Object.keys(rec)) {
    if (k.toLowerCase() === lower) {
      const v = rec[k];
      if (Array.isArray(v)) return v[0];
      return v;
    }
  }
  return undefined;
}

function parsePercent(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  // Accept either 0..1 or 0..100. Values >1.5 are assumed to be percentages.
  const normalized = n > 1.5 ? n / 100 : n;
  return normalized;
}

function parseNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function extract(bag: HeaderBag, window: '5h' | '7d'): RawHint {
  return {
    reset: getHeader(bag, `${PREFIX}${window}-reset`),
    limit: getHeader(bag, `${PREFIX}${window}-limit`),
    remaining: getHeader(bag, `${PREFIX}${window}-remaining`),
    percent: getHeader(bag, `${PREFIX}${window}-percent`),
    claim: getHeader(bag, `${PREFIX}${window}-representative-claim`),
  };
}

function hintFromRaw(window: '5h' | '7d', raw: RawHint): RateLimitHint | null {
  const hasAny =
    raw.reset !== undefined ||
    raw.limit !== undefined ||
    raw.remaining !== undefined ||
    raw.percent !== undefined ||
    raw.claim !== undefined;
  if (!hasAny) return null;

  const hint: RateLimitHint = { window };

  const resetSec = parseNumber(raw.reset);
  if (resetSec !== undefined) {
    hint.resetAtMs = Math.round(resetSec * 1000);
  }

  const percent = parsePercent(raw.percent);
  const limit = parseNumber(raw.limit);
  const remaining = parseNumber(raw.remaining);
  if (percent !== undefined) {
    hint.utilization = percent;
  } else if (limit !== undefined && limit > 0 && remaining !== undefined) {
    hint.utilization = Math.max(0, Math.min(1, (limit - remaining) / limit));
  }

  if (raw.claim !== undefined) {
    hint.claim = raw.claim;
  }

  return hint;
}

/**
 * Extract rate-limit hints from a response's headers. Returns an empty array
 * when no recognized headers are present.
 */
export function parseRateLimitHeaders(headers: HeaderBag): RateLimitHint[] {
  const hints: RateLimitHint[] = [];
  for (const window of WINDOWS) {
    const raw = extract(headers, window);
    const hint = hintFromRaw(window, raw);
    if (hint) hints.push(hint);
  }
  return hints;
}

/** Returns `true` when any hint signals that a rate-limit window is exhausted. */
export function hintsIndicateExhausted(hints: RateLimitHint[]): boolean {
  for (const hint of hints) {
    if (hint.utilization !== undefined && hint.utilization >= 1.0) {
      return true;
    }
  }
  return false;
}
