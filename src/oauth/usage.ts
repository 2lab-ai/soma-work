/**
 * Claude OAuth usage endpoint wrapper.
 *
 * Pure HTTP function — callers own the cadence / backoff state. Use
 * {@link nextUsageBackoffMs} to compute the next retry delay when the server
 * returns 429 or another transient error.
 */

import type { UsageSnapshot } from '../cct-store/types';

export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

const USAGE_TIMEOUT_MS = 30_000;
const DEFAULT_SUCCESS_INTERVAL_MS = 2 * 60 * 1000;

const BACKOFF_LADDER_MS: readonly number[] = [2 * 60 * 1000, 5 * 60 * 1000, 10 * 60 * 1000, 15 * 60 * 1000];

export class UsageFetchError extends Error {
  public readonly status: number;
  public readonly body: string;

  constructor(status: number, body: string, message: string) {
    super(message);
    this.name = 'UsageFetchError';
    this.status = status;
    this.body = body;
  }
}

export interface UsageFetchResult {
  snapshot: UsageSnapshot;
  nextFetchAllowedAtMs: number;
}

interface UsageWindowRaw {
  utilization?: unknown;
  resets_at?: unknown;
}

interface UsageResponseRaw {
  five_hour?: UsageWindowRaw | null;
  seven_day?: UsageWindowRaw | null;
  seven_day_sonnet?: UsageWindowRaw | null;
}

function parseWindow(raw: UsageWindowRaw | null | undefined): UsageSnapshot['fiveHour'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const util = raw.utilization;
  const resets = raw.resets_at;
  if (typeof util !== 'number' || !Number.isFinite(util)) return undefined;
  if (typeof resets !== 'string' || resets.length === 0) return undefined;
  return { utilization: util, resetsAt: resets };
}

/**
 * GET https://api.anthropic.com/api/oauth/usage with the OAuth beta header.
 *
 * On 2xx: parse the response into a {@link UsageSnapshot}. `nextFetchAllowedAtMs`
 * is set to `Date.now() + 2min` so callers can throttle successful polls.
 *
 * On non-2xx: throws {@link UsageFetchError}. Callers decide whether to refresh
 * (401) or back off (429/5xx) using {@link nextUsageBackoffMs}.
 */
export async function fetchUsage(accessToken: string): Promise<UsageFetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), USAGE_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(CLAUDE_USAGE_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    let body = '';
    try {
      body = await response.text();
    } catch {
      // ignore
    }
    throw new UsageFetchError(response.status, body, `Usage fetch failed with status ${response.status}`);
  }

  let parsed: UsageResponseRaw;
  try {
    parsed = (await response.json()) as UsageResponseRaw;
  } catch (error) {
    throw new UsageFetchError(response.status, '', `Usage response was not valid JSON: ${(error as Error).message}`);
  }

  const snapshot: UsageSnapshot = {
    fetchedAt: new Date().toISOString(),
  };
  const five = parseWindow(parsed.five_hour);
  if (five) snapshot.fiveHour = five;
  const seven = parseWindow(parsed.seven_day);
  if (seven) snapshot.sevenDay = seven;
  const sevenSonnet = parseWindow(parsed.seven_day_sonnet);
  if (sevenSonnet) snapshot.sevenDaySonnet = sevenSonnet;

  return {
    snapshot,
    nextFetchAllowedAtMs: Date.now() + DEFAULT_SUCCESS_INTERVAL_MS,
  };
}

/**
 * Return the next backoff duration given the current (last-used) backoff in ms.
 *
 * Ladder: 2m → 5m → 10m → 15m (capped). Pass `undefined` or `0` on the first
 * failure after a success to start at 2m.
 */
export function nextUsageBackoffMs(currentBackoffMs: number | undefined): number {
  if (currentBackoffMs === undefined || currentBackoffMs <= 0) {
    return BACKOFF_LADDER_MS[0];
  }
  for (let i = 0; i < BACKOFF_LADDER_MS.length; i++) {
    if (currentBackoffMs < BACKOFF_LADDER_MS[i]) {
      return BACKOFF_LADDER_MS[i];
    }
  }
  // Already at or past the ladder — return the cap.
  const cap = BACKOFF_LADDER_MS[BACKOFF_LADDER_MS.length - 1];
  if (currentBackoffMs >= cap) {
    return cap;
  }
  return cap;
}

/**
 * Return the backoff duration for the Nth consecutive failure (0-indexed).
 *
 * Ladder: 2m → 5m → 10m → 15m (capped). Pass `0` on the first failure after a
 * success to start at 2m; values beyond the ladder length clamp to the cap.
 *
 * This is the count-based variant of {@link nextUsageBackoffMs}. Prefer it at
 * call sites that track a `consecutiveUsageFailures` counter, because it
 * avoids the "initial 2-minute post-success throttle masquerades as the
 * first failure" ambiguity that bites the duration-based helper.
 */
export function usageBackoffForFailureCount(failureCount: number): number {
  const idx = Math.max(0, Math.min(BACKOFF_LADDER_MS.length - 1, Math.floor(failureCount)));
  return BACKOFF_LADDER_MS[idx];
}
