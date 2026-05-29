/**
 * #1003 — `probeSlackApi` bounded-retry preflight connectivity probe.
 *
 * Proves the fix for the crash-loop: a transient Slack-API/network failure at
 * boot must NOT hard-fail (it is retried, then degraded to a warning by the
 * caller), while a genuine credential rejection stays fatal and short-circuits
 * without burning retries.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authTestMock = vi.hoisted(() => vi.fn());

vi.mock('@slack/web-api', () => ({
  WebClient: class {
    auth = { test: authTestMock };
    // biome-ignore lint/complexity/noUselessConstructor: matches WebClient(token) shape
    constructor(_token?: string) {}
  },
}));

vi.mock('../logger', () => ({
  Logger: class {
    warn = vi.fn();
    info = vi.fn();
    debug = vi.fn();
    error = vi.fn();
  },
}));

import { probeSlackApi } from '../config';

describe('probeSlackApi (#1003 preflight retry)', () => {
  beforeEach(() => {
    authTestMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns ok on first-attempt success (no retry)', async () => {
    authTestMock.mockResolvedValueOnce({ ok: true, user: 'soma', team: 'Acme', bot_id: 'B123' });
    const result = await probeSlackApi('xoxb-test', { backoffBaseMs: 0 });
    expect(result.ok).toBe(true);
    expect(result.user).toBe('soma');
    expect(result.team).toBe('Acme');
    expect(result.botId).toBe('B123');
    expect(authTestMock).toHaveBeenCalledTimes(1);
  });

  it('invalid_auth (thrown) is fatal and short-circuits without retrying', async () => {
    const err = Object.assign(new Error('An API error occurred: invalid_auth'), {
      data: { ok: false, error: 'invalid_auth' },
    });
    authTestMock.mockRejectedValue(err);
    const onRetry = vi.fn();
    const result = await probeSlackApi('xoxb-test', { backoffBaseMs: 0, maxAttempts: 3, onRetry });
    expect(result.ok).toBe(false);
    expect(result.fatalAuth).toBe(true);
    expect(result.message).toContain('invalid_auth');
    expect(authTestMock).toHaveBeenCalledTimes(1); // no retries for fatal auth
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('auth.test returning {ok:false, error:invalid_auth} (non-throw) is also fatal', async () => {
    authTestMock.mockResolvedValue({ ok: false, error: 'invalid_auth' });
    const result = await probeSlackApi('xoxb-test', { backoffBaseMs: 0, maxAttempts: 3 });
    expect(result.ok).toBe(false);
    expect(result.fatalAuth).toBe(true);
    expect(authTestMock).toHaveBeenCalledTimes(1);
  });

  it('transient failure on every attempt → not fatal, retried to the budget', async () => {
    const transient = Object.assign(new Error('A request error occurred: ECONNRESET'), { code: 'ECONNRESET' });
    authTestMock.mockRejectedValue(transient);
    const onRetry = vi.fn();
    const result = await probeSlackApi('xoxb-test', { backoffBaseMs: 0, maxAttempts: 3, onRetry });
    expect(result.ok).toBe(false);
    expect(result.fatalAuth).toBe(false); // transient → caller degrades to warning, NOT a hard fail
    expect(result.message).toContain('Connection failed');
    expect(authTestMock).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2); // between the 3 attempts
  });

  it('transient failure then success recovers without surfacing an error', async () => {
    const transient = Object.assign(new Error('A request error occurred: ETIMEDOUT'), { code: 'ETIMEDOUT' });
    authTestMock
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce({ ok: true, user: 'soma', team: 'Acme', bot_id: 'B999' });
    const result = await probeSlackApi('xoxb-test', { backoffBaseMs: 0, maxAttempts: 3 });
    expect(result.ok).toBe(true);
    expect(result.botId).toBe('B999');
    expect(authTestMock).toHaveBeenCalledTimes(2);
  });
});
