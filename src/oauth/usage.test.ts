import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_USAGE_URL,
  fetchUsage,
  nextUsageBackoffMs,
  UsageFetchError,
  usageBackoffForFailureCount,
} from './usage';

describe('nextUsageBackoffMs', () => {
  it('returns 2min for first attempt (undefined)', () => {
    expect(nextUsageBackoffMs(undefined)).toBe(2 * 60 * 1000);
  });

  it('escalates 2m -> 5m', () => {
    expect(nextUsageBackoffMs(2 * 60 * 1000)).toBe(5 * 60 * 1000);
  });

  it('escalates 5m -> 10m', () => {
    expect(nextUsageBackoffMs(5 * 60 * 1000)).toBe(10 * 60 * 1000);
  });

  it('escalates 10m -> 15m', () => {
    expect(nextUsageBackoffMs(10 * 60 * 1000)).toBe(15 * 60 * 1000);
  });

  it('caps at 15m (15m -> 15m)', () => {
    expect(nextUsageBackoffMs(15 * 60 * 1000)).toBe(15 * 60 * 1000);
  });

  it('treats 0 as first attempt', () => {
    expect(nextUsageBackoffMs(0)).toBe(2 * 60 * 1000);
  });

  it('caps arbitrary large values at 15m', () => {
    expect(nextUsageBackoffMs(60 * 60 * 1000)).toBe(15 * 60 * 1000);
  });
});

describe('usageBackoffForFailureCount', () => {
  // Regression: previously the initial 2m post-success throttle would be
  // fed back into `nextUsageBackoffMs` on the first failure, causing the
  // ladder to skip the 2m rung and start at 5m.
  it('progresses 2m -> 5m -> 10m -> 15m across consecutive failures after success', () => {
    expect(usageBackoffForFailureCount(0)).toBe(2 * 60 * 1000);
    expect(usageBackoffForFailureCount(1)).toBe(5 * 60 * 1000);
    expect(usageBackoffForFailureCount(2)).toBe(10 * 60 * 1000);
    expect(usageBackoffForFailureCount(3)).toBe(15 * 60 * 1000);
  });

  it('caps at 15m for failure counts beyond the ladder length', () => {
    expect(usageBackoffForFailureCount(4)).toBe(15 * 60 * 1000);
    expect(usageBackoffForFailureCount(99)).toBe(15 * 60 * 1000);
  });

  it('treats negative / non-integer counts as the first rung', () => {
    expect(usageBackoffForFailureCount(-1)).toBe(2 * 60 * 1000);
    expect(usageBackoffForFailureCount(0.9)).toBe(2 * 60 * 1000);
  });
});

describe('fetchUsage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-18T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('parses a 200 response into a snapshot and sets nextFetchAllowedAtMs = now + 2min', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => '',
      json: async () => ({
        five_hour: { utilization: 0.25, resets_at: '2026-04-18T17:00:00Z' },
        seven_day: { utilization: 0.5, resets_at: '2026-04-25T00:00:00Z' },
        seven_day_sonnet: { utilization: 0.1, resets_at: '2026-04-25T00:00:00Z' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchUsage('access-abc');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(CLAUDE_USAGE_URL);
    expect(init.method ?? 'GET').toBe('GET');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer access-abc');
    expect(headers['anthropic-beta']).toBe('oauth-2025-04-20');

    expect(result.snapshot.fetchedAt).toBe('2026-04-18T12:00:00.000Z');
    expect(result.snapshot.fiveHour).toEqual({ utilization: 0.25, resetsAt: '2026-04-18T17:00:00Z' });
    expect(result.snapshot.sevenDay).toEqual({ utilization: 0.5, resetsAt: '2026-04-25T00:00:00Z' });
    expect(result.snapshot.sevenDaySonnet).toEqual({ utilization: 0.1, resetsAt: '2026-04-25T00:00:00Z' });
    expect(result.nextFetchAllowedAtMs).toBe(Date.now() + 2 * 60 * 1000);
  });

  it('parses a 200 response with only five_hour present', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => '',
      json: async () => ({
        five_hour: { utilization: 0.33, resets_at: '2026-04-18T17:00:00Z' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchUsage('access-abc');
    expect(result.snapshot.fiveHour).toEqual({ utilization: 0.33, resetsAt: '2026-04-18T17:00:00Z' });
    expect(result.snapshot.sevenDay).toBeUndefined();
    expect(result.snapshot.sevenDaySonnet).toBeUndefined();
  });

  it('throws UsageFetchError on 429', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers(),
      text: async () => 'rate limited',
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchUsage('access-abc')).rejects.toMatchObject({
      name: 'UsageFetchError',
      status: 429,
    });
  });

  it('throws UsageFetchError on 401', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: new Headers(),
      text: async () => 'unauthorized',
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchUsage('access-abc')).rejects.toBeInstanceOf(UsageFetchError);
    try {
      await fetchUsage('access-abc');
    } catch (e) {
      expect((e as UsageFetchError).status).toBe(401);
    }
  });

  it('throws UsageFetchError on 500', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Headers(),
      text: async () => 'server error',
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchUsage('access-abc')).rejects.toBeInstanceOf(UsageFetchError);
  });
});
