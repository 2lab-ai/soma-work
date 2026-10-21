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

import { probeSlackApi, runPreflightChecks, validateConfig } from '../config';

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

/**
 * Task 7 — signing secret is OPTIONAL under Socket Mode.
 *
 * `SLACK_SIGNING_SECRET` verifies the `X-Slack-Signature` header on requests
 * Slack delivers over HTTP. This runtime speaks Socket Mode (outbound wss,
 * authenticated by `xapp-…`), so a missing secret is not a defect and must not
 * fail boot. A secret that IS provided must still look real — a truncated
 * paste is an operator error, so it stays a hard error (never a warning).
 */
describe('signing secret contract (Socket Mode)', () => {
  const EXACTLY_MIN = 'b'.repeat(20);
  const TOO_SHORT = 'c'.repeat(19);

  function signingEntries(list: string[]): string[] {
    return list.filter((entry) => entry.includes('SIGNING_SECRET'));
  }

  beforeEach(() => {
    authTestMock.mockReset();
    authTestMock.mockResolvedValue({ ok: true, user: 'soma', team: 'Acme', bot_id: 'B1' });
    vi.stubEnv('SLACK_BOT_TOKEN', 'xoxb-valid-token');
    vi.stubEnv('SLACK_APP_TOKEN', 'xapp-valid-token');
    vi.stubEnv('SLACK_SIGNING_SECRET', undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('validateConfig', () => {
    it('accepts an absent SLACK_SIGNING_SECRET when bot + app tokens are present', () => {
      expect(() => validateConfig()).not.toThrow();
    });

    it('accepts an empty / whitespace-only SLACK_SIGNING_SECRET', () => {
      vi.stubEnv('SLACK_SIGNING_SECRET', '');
      expect(() => validateConfig()).not.toThrow();
      vi.stubEnv('SLACK_SIGNING_SECRET', '   ');
      expect(() => validateConfig()).not.toThrow();
    });

    it('still requires SLACK_BOT_TOKEN and SLACK_APP_TOKEN', () => {
      vi.stubEnv('SLACK_BOT_TOKEN', undefined);
      expect(() => validateConfig()).toThrow(/SLACK_BOT_TOKEN/);
      vi.stubEnv('SLACK_BOT_TOKEN', 'xoxb-valid-token');
      vi.stubEnv('SLACK_APP_TOKEN', undefined);
      expect(() => validateConfig()).toThrow(/SLACK_APP_TOKEN/);
    });

    it('rejects a provided secret shorter than 20 chars (hard error)', () => {
      vi.stubEnv('SLACK_SIGNING_SECRET', TOO_SHORT);
      expect(() => validateConfig()).toThrow(/SLACK_SIGNING_SECRET/);
      expect(() => validateConfig()).toThrow(/19 chars/);
    });

    it('accepts a provided secret of exactly 20 chars', () => {
      vi.stubEnv('SLACK_SIGNING_SECRET', EXACTLY_MIN);
      expect(() => validateConfig()).not.toThrow();
    });

    it('never puts the secret value in the failure message', () => {
      vi.stubEnv('SLACK_SIGNING_SECRET', TOO_SHORT);
      let message = '';
      try {
        validateConfig();
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe('');
      expect(message).not.toContain(TOO_SHORT);
    });
  });

  describe('runPreflightChecks', () => {
    it('reports no error and no warning for an absent signing secret', async () => {
      const result = await runPreflightChecks();
      expect(signingEntries(result.errors)).toEqual([]);
      expect(signingEntries(result.warnings)).toEqual([]);
    });

    it('reports nothing for a whitespace-only signing secret either', async () => {
      vi.stubEnv('SLACK_SIGNING_SECRET', '   ');
      const result = await runPreflightChecks();
      expect(signingEntries(result.errors)).toEqual([]);
      expect(signingEntries(result.warnings)).toEqual([]);
    });

    it('hard-errors (not warns) on a provided secret shorter than 20 chars', async () => {
      vi.stubEnv('SLACK_SIGNING_SECRET', TOO_SHORT);
      const result = await runPreflightChecks();
      expect(signingEntries(result.errors)).toHaveLength(1);
      expect(signingEntries(result.errors)[0]).toContain('19 chars');
      expect(signingEntries(result.errors)[0]).not.toContain(TOO_SHORT);
      expect(signingEntries(result.warnings)).toEqual([]);
    });

    it('accepts a provided secret of exactly 20 chars', async () => {
      vi.stubEnv('SLACK_SIGNING_SECRET', EXACTLY_MIN);
      const result = await runPreflightChecks();
      expect(signingEntries(result.errors)).toEqual([]);
      expect(signingEntries(result.warnings)).toEqual([]);
    });

    it('keeps xoxb- / xapp- prefix validation untouched', async () => {
      vi.stubEnv('SLACK_BOT_TOKEN', 'xoxa-wrong');
      vi.stubEnv('SLACK_APP_TOKEN', 'xoxb-wrong');
      const result = await runPreflightChecks();
      expect(result.errors.some((e) => e.includes('SLACK_BOT_TOKEN') && e.includes('xoxb-'))).toBe(true);
      expect(result.errors.some((e) => e.includes('SLACK_APP_TOKEN') && e.includes('xapp-'))).toBe(true);
    });
  });
});

/**
 * `config.slack.signingSecret` is read once at module import, so this block
 * re-imports the module under a stubbed env instead of reusing the singleton.
 */
describe('config.slack.signingSecret normalization', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function loadSigningSecret(raw: string | undefined): Promise<string | undefined> {
    vi.resetModules();
    vi.stubEnv('SLACK_SIGNING_SECRET', raw);
    const mod = await import('../config');
    return mod.config.slack.signingSecret;
  }

  it('is undefined when the env var is absent', async () => {
    await expect(loadSigningSecret(undefined)).resolves.toBeUndefined();
  });

  it('is undefined for blank / whitespace-only values', async () => {
    await expect(loadSigningSecret('')).resolves.toBeUndefined();
    await expect(loadSigningSecret('   ')).resolves.toBeUndefined();
  });

  it('carries a configured value through (trimmed)', async () => {
    await expect(loadSigningSecret(`  ${'a'.repeat(32)}  `)).resolves.toBe('a'.repeat(32));
  });
});
