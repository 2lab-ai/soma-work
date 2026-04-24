/**
 * Tests for `TokenManager.classifyRefreshError`.
 *
 * These tests enforce the security boundary around `RefreshErrorInfo.message`:
 * every returned message must come from the fixed ASCII template table in
 * `src/token-manager.ts::classifyRefreshError`, never from the underlying
 * `err.message` or `OAuthRefreshError.body`. Adversarial inputs with
 * token-like patterns (`sk-ant-oat01-…`) must be invisibly dropped.
 */

import { describe, expect, it } from 'vitest';
import { OAuthRefreshError } from './oauth/refresher';
import { TokenManager } from './token-manager';

describe('TokenManager.classifyRefreshError', () => {
  it('401 → unauthorized with the fixed template', () => {
    const info = TokenManager.classifyRefreshError(
      new OAuthRefreshError(401, '{"error":"invalid_grant"}', 'OAuth refresh failed with status 401'),
    );
    expect(info).toEqual({ kind: 'unauthorized', status: 401, message: 'Refresh rejected (401 invalid_grant)' });
  });

  it('403 → revoked', () => {
    const info = TokenManager.classifyRefreshError(
      new OAuthRefreshError(403, '{"error":"revoked"}', 'OAuth refresh failed with status 403'),
    );
    expect(info).toEqual({ kind: 'revoked', status: 403, message: 'Refresh revoked (403)' });
  });

  it('429 → rate_limited', () => {
    const info = TokenManager.classifyRefreshError(
      new OAuthRefreshError(429, 'slow down', 'OAuth refresh failed with status 429'),
    );
    expect(info).toEqual({ kind: 'rate_limited', status: 429, message: 'Refresh throttled (429)' });
  });

  it('500 → server', () => {
    const info = TokenManager.classifyRefreshError(
      new OAuthRefreshError(500, 'oops', 'OAuth refresh failed with status 500'),
    );
    expect(info).toEqual({ kind: 'server', status: 500, message: 'Refresh server error (500)' });
  });

  it('502 → server', () => {
    const info = TokenManager.classifyRefreshError(
      new OAuthRefreshError(502, '', 'OAuth refresh failed with status 502'),
    );
    expect(info).toEqual({ kind: 'server', status: 502, message: 'Refresh server error (502)' });
  });

  it('599 → server (inclusive upper bound)', () => {
    const info = TokenManager.classifyRefreshError(
      new OAuthRefreshError(599, '', 'OAuth refresh failed with status 599'),
    );
    expect(info).toEqual({ kind: 'server', status: 599, message: 'Refresh server error (599)' });
  });

  it('other 4xx → unknown with status', () => {
    const info = TokenManager.classifyRefreshError(
      new OAuthRefreshError(418, '', 'OAuth refresh failed with status 418'),
    );
    expect(info).toEqual({ kind: 'unknown', status: 418, message: 'Refresh failed (418)' });
  });

  it('parse — invalid JSON body (empty body + "not valid JSON" prefix)', () => {
    const info = TokenManager.classifyRefreshError(
      new OAuthRefreshError(200, '', 'OAuth refresh response was not valid JSON: Unexpected token'),
    );
    expect(info).toEqual({ kind: 'parse', message: 'Refresh response malformed' });
  });

  it('parse — missing fields (empty body + "OAuth refresh response missing" prefix)', () => {
    const info = TokenManager.classifyRefreshError(
      new OAuthRefreshError(200, '', 'OAuth refresh response missing access_token or expires_in'),
    );
    expect(info).toEqual({ kind: 'parse', message: 'Refresh response malformed' });
  });

  it('AbortError → timeout', () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    const info = TokenManager.classifyRefreshError(err);
    expect(info).toEqual({ kind: 'timeout', message: 'Refresh timed out after 30s' });
  });

  it('TypeError from fetch → network', () => {
    const info = TokenManager.classifyRefreshError(new TypeError('fetch failed'));
    expect(info).toEqual({ kind: 'network', message: 'Refresh network error' });
  });

  it('ECONNRESET code → network', () => {
    const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const info = TokenManager.classifyRefreshError(err);
    expect(info).toEqual({ kind: 'network', message: 'Refresh network error' });
  });

  it('ENOTFOUND code → network', () => {
    const err = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    const info = TokenManager.classifyRefreshError(err);
    expect(info).toEqual({ kind: 'network', message: 'Refresh network error' });
  });

  it('EAI_AGAIN code → network', () => {
    const err = Object.assign(new Error('dns lookup'), { code: 'EAI_AGAIN' });
    expect(TokenManager.classifyRefreshError(err)).toEqual({ kind: 'network', message: 'Refresh network error' });
  });

  it('ECONNREFUSED code → network', () => {
    const err = Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(TokenManager.classifyRefreshError(err)).toEqual({ kind: 'network', message: 'Refresh network error' });
  });

  it('plain unknown Error → unknown template', () => {
    const info = TokenManager.classifyRefreshError(new Error('something weird happened'));
    expect(info).toEqual({ kind: 'unknown', message: 'Refresh failed (unknown)' });
  });

  it('non-Error throwable → unknown template', () => {
    const info = TokenManager.classifyRefreshError('just a string');
    expect(info).toEqual({ kind: 'unknown', message: 'Refresh failed (unknown)' });
  });

  it('undefined → unknown template', () => {
    const info = TokenManager.classifyRefreshError(undefined);
    expect(info).toEqual({ kind: 'unknown', message: 'Refresh failed (unknown)' });
  });

  // ── Adversarial secret-redaction tests ─────────────────────────

  it('adversarial: token pattern in OAuthRefreshError.message does NOT appear in the stored message', () => {
    const adversary = 'sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAA';
    const err = new OAuthRefreshError(500, `body containing ${adversary} blob`, `leaked: ${adversary}`);
    const info = TokenManager.classifyRefreshError(err);
    expect(info.message).toBe('Refresh server error (500)');
    expect(info.message).not.toContain('sk-ant-');
    expect(info.message).not.toContain(adversary);
  });

  it('adversarial: token pattern in OAuthRefreshError.body does NOT leak', () => {
    const adversary = 'sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBB';
    const err = new OAuthRefreshError(401, adversary, `rejected: ${adversary}`);
    const info = TokenManager.classifyRefreshError(err);
    expect(info.message).toBe('Refresh rejected (401 invalid_grant)');
    expect(info.message).not.toContain('sk-ant-');
  });

  it('adversarial: token pattern inside parse-error message does NOT leak', () => {
    const err = new OAuthRefreshError(
      200,
      '',
      `OAuth refresh response was not valid JSON: token=sk-ant-oat01-CCCCCCCCCCCCCCCC`,
    );
    const info = TokenManager.classifyRefreshError(err);
    expect(info.message).toBe('Refresh response malformed');
    expect(info.message).not.toContain('sk-ant-');
  });

  it('adversarial: raw string throwable with token pattern does NOT leak', () => {
    const info = TokenManager.classifyRefreshError('sk-ant-oat01-DDDDDDDDDDDDDDDDDDDDDD leaked');
    expect(info.message).toBe('Refresh failed (unknown)');
    expect(info.message).not.toContain('sk-ant-');
  });
});
