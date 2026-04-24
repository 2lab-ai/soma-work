import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLAUDE_OAUTH_PROFILE_URL, fetchOAuthProfile, OAuthProfileUnauthorizedError } from '../profile';

describe('fetchOAuthProfile', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-20T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('parses a 200 response (email_address preferred over email)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => '',
      json: async () => ({
        account: {
          email_address: 'alice@example.com',
          display_name: 'Alice',
          uuid: 'acc-uuid-1',
          email: 'fallback@example.com', // must be ignored when email_address is present
        },
        organization: {
          name: 'Acme Corp',
          organization_type: 'personal',
          rate_limit_tier: 'default_claude_max_20x',
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchOAuthProfile('access-abc');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(CLAUDE_OAUTH_PROFILE_URL);
    expect(init.method ?? 'GET').toBe('GET');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer access-abc');
    expect(headers['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(headers.Accept).toBe('application/json');
    expect(headers['Content-Type']).toBe('application/json');

    expect(result.email).toBe('alice@example.com');
    expect(result.accountUuid).toBe('acc-uuid-1');
    expect(result.displayName).toBe('Alice');
    expect(result.organizationName).toBe('Acme Corp');
    expect(result.organizationType).toBe('personal');
    expect(result.rateLimitTier).toBe('default_claude_max_20x');
    expect(result.fetchedAt).toBe(Date.now());
  });

  it('falls back to account.email when email_address is missing', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => '',
      json: async () => ({
        account: { email: 'bob@example.com' },
        organization: {},
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchOAuthProfile('access-abc');
    expect(result.email).toBe('bob@example.com');
  });

  it('returns a minimal profile when the payload is missing optional fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => '',
      json: async () => ({ account: {}, organization: {} }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchOAuthProfile('access-abc');
    expect(result.fetchedAt).toBe(Date.now());
    expect(result.email).toBeUndefined();
    expect(result.accountUuid).toBeUndefined();
    expect(result.rateLimitTier).toBeUndefined();
  });

  it('throws OAuthProfileUnauthorizedError on 401', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: new Headers(),
      text: async () => 'unauthorized',
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchOAuthProfile('access-abc')).rejects.toBeInstanceOf(OAuthProfileUnauthorizedError);
  });

  it('throws a plain Error with status + redacted body on 500', async () => {
    const longBody = 'x'.repeat(500);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Headers(),
      text: async () => longBody,
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchOAuthProfile('access-abc')).rejects.toThrow(/status=500/);
    // Body must be capped to 200 chars + ellipsis.
    try {
      await fetchOAuthProfile('access-abc');
    } catch (err) {
      const msg = (err as Error).message;
      const bodyExcerpt = msg.split('body=')[1] ?? '';
      expect(bodyExcerpt.length).toBeLessThanOrEqual(201);
    }
  });

  it('throws when the 200 body is malformed JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => '',
      json: async () => {
        throw new Error('Unexpected token');
      },
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchOAuthProfile('access-abc')).rejects.toThrow(/not valid JSON/);
  });

  it('times out via AbortController after the configured timeoutMs', async () => {
    vi.useRealTimers();
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchOAuthProfile('access-abc', { timeoutMs: 20 })).rejects.toThrow(/timed out/);
  });
});
