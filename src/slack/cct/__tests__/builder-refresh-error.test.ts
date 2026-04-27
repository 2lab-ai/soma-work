/**
 * Tests for #701 — the refresh-error segment appended to `line2` of
 * `buildSlotStatusLine` for OAuth-attached slots.
 *
 * The segment surfaces every persisted `lastRefreshError` regardless of
 * authState, with a kind-specific glyph, the fixed-template message, an
 * age suffix, and a streak badge when consecutive failures ≥ 2.
 */

import { describe, expect, it } from 'vitest';
import type { AuthKey, RefreshErrorInfo, SlotState } from '../../../cct-store';
import { buildSlotRow } from '../builder';

const NOW = Date.parse('2026-04-24T00:00:00Z');

function oauthSlot(expiresInHours = 7): AuthKey {
  return {
    kind: 'cct',
    source: 'setup',
    keyId: 'slot-r',
    name: 'notify',
    setupToken: 'sk-ant-oat01-xxxxxxxx',
    oauthAttachment: {
      accessToken: 't',
      refreshToken: 'r',
      expiresAtMs: NOW + expiresInHours * 3_600_000,
      scopes: ['user:profile', 'user:inference'],
      acknowledgedConsumerTosRisk: true,
    },
    createdAt: '2026-04-01T00:00:00Z',
  };
}

function line2(
  authState: 'healthy' | 'refresh_failed' | 'revoked',
  err: Omit<RefreshErrorInfo, 'at'> & { ageMs?: number },
  consecutive?: number,
): string {
  const ageMs = err.ageMs ?? 2 * 60_000;
  const failedAt = NOW - ageMs;
  const state: SlotState = {
    authState,
    activeLeases: [],
    lastRefreshFailedAt: failedAt,
    lastRefreshError: {
      kind: err.kind,
      ...(err.status !== undefined ? { status: err.status } : {}),
      message: err.message,
      at: failedAt,
    },
    ...(consecutive !== undefined ? { consecutiveRefreshFailures: consecutive } : {}),
  };
  const blocks = buildSlotRow(oauthSlot(), state, false, NOW);
  const section = blocks[0] as { text?: { text?: string } };
  const text = section?.text?.text ?? '';
  // line2 is the portion after the first newline.
  const idx = text.indexOf('\n');
  return idx === -1 ? '' : text.slice(idx + 1);
}

describe('#701: refresh-error segment in buildSlotStatusLine', () => {
  it('kind=unauthorized (healthy-state fallback) uses :warning: and includes ago suffix', () => {
    // Note: unauthorized persists as authState=refresh_failed in practice,
    // but the segment rendering is authState-independent.
    const text = line2('refresh_failed', {
      kind: 'unauthorized',
      status: 401,
      message: 'Refresh rejected (401 invalid_grant)',
    });
    expect(text).toContain(':warning:');
    expect(text).toContain('Refresh rejected (401 invalid_grant)');
    expect(text).toContain('(2m ago)');
  });

  it('kind=revoked uses :warning: + Unavailable badge (authState=revoked)', () => {
    const text = line2('revoked', { kind: 'revoked', status: 403, message: 'Refresh revoked (403)' });
    expect(text).toContain(':black_circle: Unavailable');
    expect(text).toContain(':warning:');
    expect(text).toContain('Refresh revoked (403)');
    // The healthy-only OAuth refresh hint is absent for non-healthy states.
    expect(text).not.toContain('OAuth refreshes in');
  });

  it('kind=rate_limited uses :hourglass: (transient signal, not a user error)', () => {
    const text = line2('healthy', { kind: 'rate_limited', status: 429, message: 'Refresh throttled (429)' });
    expect(text).toContain(':hourglass:');
    expect(text).toContain('Refresh throttled (429)');
    // healthy keeps the green badge AND the OAuth refresh hint alongside the error.
    expect(text).toContain(':large_green_circle: Healthy');
    expect(text).toContain('OAuth refreshes in');
  });

  it('kind=server uses :warning:', () => {
    const text = line2('healthy', { kind: 'server', status: 500, message: 'Refresh server error (500)' });
    expect(text).toContain(':warning:');
    expect(text).toContain('Refresh server error (500)');
  });

  it('kind=network uses :satellite_antenna:', () => {
    const text = line2('healthy', { kind: 'network', message: 'Refresh network error' });
    expect(text).toContain(':satellite_antenna:');
    expect(text).toContain('Refresh network error');
  });

  it('kind=timeout uses :satellite_antenna:', () => {
    const text = line2('healthy', { kind: 'timeout', message: 'Refresh timed out after 30s' });
    expect(text).toContain(':satellite_antenna:');
    expect(text).toContain('Refresh timed out after 30s');
  });

  it('kind=parse uses :warning:', () => {
    const text = line2('healthy', { kind: 'parse', message: 'Refresh response malformed' });
    expect(text).toContain(':warning:');
    expect(text).toContain('Refresh response malformed');
  });

  it('consecutiveRefreshFailures ≥ 2 appends ` · ×N`', () => {
    const text = line2('healthy', { kind: 'rate_limited', status: 429, message: 'Refresh throttled (429)' }, 3);
    expect(text).toContain('×3');
  });

  it('consecutiveRefreshFailures = 1 does NOT append the streak badge', () => {
    const text = line2('healthy', { kind: 'rate_limited', status: 429, message: 'Refresh throttled (429)' }, 1);
    expect(text).not.toContain('×');
  });

  it('no lastRefreshError → no segment emitted', () => {
    // Scoped to line2 — line1 carries the unrelated `:warning: ToS-risk` badge.
    const state: SlotState = { authState: 'healthy', activeLeases: [] };
    const blocks = buildSlotRow(oauthSlot(), state, false, NOW);
    const section = blocks[0] as { text?: { text?: string } };
    const text = section?.text?.text ?? '';
    const idx = text.indexOf('\n');
    const line2Text = idx === -1 ? '' : text.slice(idx + 1);
    expect(line2Text).not.toContain(':warning:');
    expect(line2Text).not.toContain(':hourglass:');
    expect(line2Text).not.toContain(':satellite_antenna:');
    expect(line2Text).not.toMatch(
      /Refresh (rejected|revoked|throttled|server error|failed|timed out|network error|response malformed)/,
    );
  });

  it('ago suffix formats hours/days correctly', () => {
    const hoursAgo = line2('healthy', {
      kind: 'server',
      status: 500,
      message: 'Refresh server error (500)',
      ageMs: 3 * 3_600_000 + 15 * 60_000,
    });
    expect(hoursAgo).toContain('(3h 15m ago)');

    const daysAgo = line2('healthy', {
      kind: 'server',
      status: 500,
      message: 'Refresh server error (500)',
      ageMs: 2 * 86_400_000 + 4 * 3_600_000,
    });
    expect(daysAgo).toContain('(2d 4h ago)');
  });

  // Block-count invariant — the refresh-error segment must live inside
  // the existing section block's text, NOT add a new block.
  it('refresh-error segment does NOT add a new block (block count invariant)', () => {
    const noErr: SlotState = { authState: 'healthy', activeLeases: [] };
    const withErr: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      lastRefreshFailedAt: NOW - 60_000,
      lastRefreshError: { kind: 'rate_limited', status: 429, message: 'Refresh throttled (429)', at: NOW - 60_000 },
      consecutiveRefreshFailures: 2,
    };
    const blocksNoErr = buildSlotRow(oauthSlot(), noErr, false, NOW);
    const blocksWithErr = buildSlotRow(oauthSlot(), withErr, false, NOW);
    expect(blocksWithErr.length).toBe(blocksNoErr.length);
  });
});
