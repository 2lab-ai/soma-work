import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OAuthCredentials } from '../cct-store/types';
import {
  CLAUDE_OAUTH_CLIENT_ID,
  CLAUDE_OAUTH_REFRESH_URL,
  OAuthRefreshError,
  refreshClaudeCredentials,
} from './refresher';

function makeCurrent(overrides: Partial<OAuthCredentials> = {}): OAuthCredentials {
  return {
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAtMs: 0,
    scopes: ['user:profile', 'user:inference'],
    rateLimitTier: 'tier-1',
    subscriptionType: 'pro',
    ...overrides,
  };
}

describe('refreshClaudeCredentials', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-18T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('posts to the refresh URL with client_id and refresh_token in JSON body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => '',
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
        scope: 'user:profile user:inference',
        token_type: 'Bearer',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const current = makeCurrent();
    const updated = await refreshClaudeCredentials(current);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(CLAUDE_OAUTH_REFRESH_URL);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'old-refresh',
      client_id: CLAUDE_OAUTH_CLIENT_ID,
    });

    expect(updated.accessToken).toBe('new-access');
    expect(updated.refreshToken).toBe('new-refresh');
    expect(updated.scopes).toEqual(['user:profile', 'user:inference']);
  });

  it('computes expiresAtMs = Date.now() + expires_in*1000 (±1s)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => '',
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
        scope: 'user:profile',
        token_type: 'Bearer',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const before = Date.now();
    const updated = await refreshClaudeCredentials(makeCurrent());
    const after = Date.now();

    expect(updated.expiresAtMs).toBeGreaterThanOrEqual(before + 3600 * 1000 - 1000);
    expect(updated.expiresAtMs).toBeLessThanOrEqual(after + 3600 * 1000 + 1000);
  });

  it('reuses the old refresh_token if the server does not rotate it', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => '',
      json: async () => ({
        access_token: 'new-access',
        expires_in: 1800,
        scope: 'user:profile',
        token_type: 'Bearer',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const updated = await refreshClaudeCredentials(makeCurrent({ refreshToken: 'keep-me' }));
    expect(updated.refreshToken).toBe('keep-me');
  });

  it('preserves rateLimitTier and subscriptionType from current credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => '',
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 1800,
        scope: 'user:profile',
        token_type: 'Bearer',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const updated = await refreshClaudeCredentials(makeCurrent({ rateLimitTier: 'tier-xyz', subscriptionType: 'max' }));
    expect(updated.rateLimitTier).toBe('tier-xyz');
    expect(updated.subscriptionType).toBe('max');
  });

  it('throws OAuthRefreshError on 401', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: new Headers(),
      text: async () => 'unauthorized',
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(refreshClaudeCredentials(makeCurrent())).rejects.toBeInstanceOf(OAuthRefreshError);
    try {
      await refreshClaudeCredentials(makeCurrent());
    } catch (e) {
      expect((e as OAuthRefreshError).status).toBe(401);
    }
  });

  it('throws OAuthRefreshError on 403', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      headers: new Headers(),
      text: async () => 'forbidden',
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      await refreshClaudeCredentials(makeCurrent());
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(OAuthRefreshError);
      expect((e as OAuthRefreshError).status).toBe(403);
    }
  });

  it('throws OAuthRefreshError on 5xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      headers: new Headers(),
      text: async () => 'bad gateway',
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(refreshClaudeCredentials(makeCurrent())).rejects.toBeInstanceOf(OAuthRefreshError);
  });

  it('throws on network error', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(refreshClaudeCredentials(makeCurrent())).rejects.toBeInstanceOf(Error);
  });

  it('throws on abort/timeout', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(refreshClaudeCredentials(makeCurrent())).rejects.toBeInstanceOf(Error);
  });
});
