/**
 * OAuth refresh-token flow for Claude credentials.
 *
 * Pure HTTP wrapper — no global state, no coupling to TokenManager. Callers are
 * responsible for deciding what to do with the result (persist, bump auth
 * state, etc.).
 */

import type { OAuthCredentials } from '../cct-store/types';

export const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const CLAUDE_OAUTH_REFRESH_URL = 'https://platform.claude.com/v1/oauth/token';

const REFRESH_TIMEOUT_MS = 30_000;

export class OAuthRefreshError extends Error {
  public readonly status: number;
  public readonly body: string;

  constructor(status: number, body: string, message: string) {
    super(message);
    this.name = 'OAuthRefreshError';
    this.status = status;
    this.body = body;
  }
}

interface RefreshResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  token_type?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseScopeString(scope: string | undefined, fallback: string[]): string[] {
  if (!scope) return fallback;
  const parts = scope
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : fallback;
}

/**
 * POST https://platform.claude.com/v1/oauth/token with the refresh grant.
 *
 * On success: returns new credentials.
 *   - `expiresAtMs` = `Date.now() + expires_in * 1000` (computed after the
 *     network response is parsed, so clock skew on either end is not
 *     compensated for — this is the industry norm).
 *   - `refreshToken` rotates when the server returns one; otherwise the
 *     previous refresh token is preserved (Claude today rotates, but some
 *     providers don't).
 *   - `rateLimitTier` and `subscriptionType` are preserved from the prior
 *     credentials — the refresh response does not contain these; they are
 *     populated only at initial OAuth login.
 *
 * On 4xx/5xx or network failure: throws {@link OAuthRefreshError} (or a raw
 * Error for aborts/network issues). The caller decides whether to transition
 * the auth state (e.g. `invalid_grant` → force re-login).
 */
export async function refreshClaudeCredentials(current: OAuthCredentials): Promise<OAuthCredentials> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(CLAUDE_OAUTH_REFRESH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken,
        client_id: CLAUDE_OAUTH_CLIENT_ID,
      }),
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
    throw new OAuthRefreshError(response.status, body, `OAuth refresh failed with status ${response.status}`);
  }

  let parsed: RefreshResponse;
  try {
    parsed = (await response.json()) as RefreshResponse;
  } catch (error) {
    throw new OAuthRefreshError(
      response.status,
      '',
      `OAuth refresh response was not valid JSON: ${(error as Error).message}`,
    );
  }

  const accessToken = asString(parsed.access_token);
  const expiresIn = asNumber(parsed.expires_in);
  if (!accessToken || expiresIn === undefined) {
    throw new OAuthRefreshError(response.status, '', 'OAuth refresh response missing access_token or expires_in');
  }

  const refreshToken = asString(parsed.refresh_token) ?? current.refreshToken;
  const scopes = parseScopeString(asString(parsed.scope), current.scopes);
  const expiresAtMs = Date.now() + expiresIn * 1000;

  const next: OAuthCredentials = {
    accessToken,
    refreshToken,
    expiresAtMs,
    scopes,
  };
  if (current.rateLimitTier !== undefined) {
    next.rateLimitTier = current.rateLimitTier;
  }
  if (current.subscriptionType !== undefined) {
    next.subscriptionType = current.subscriptionType;
  }
  return next;
}
