/**
 * Tests for #701 — usage panel `fetched <ago>` suffix + in-panel stale
 * warning. The staleness surface must live inside the existing usage-panel
 * context block; adding a new block would blow the 50-block budget at
 * N ≥ 15 attached slots.
 */

import { describe, expect, it } from 'vitest';
import type { AuthKey, SlotState } from '../../cct-store';
import { buildSlotRow } from './builder';

const NOW = Date.parse('2026-04-24T00:00:00Z');

function oauthSlot(): AuthKey {
  return {
    kind: 'cct',
    source: 'setup',
    keyId: 'slot-s',
    name: 'notify',
    setupToken: 'sk-ant-oat01-xxxxxxxx',
    oauthAttachment: {
      accessToken: 't',
      refreshToken: 'r',
      expiresAtMs: NOW + 7 * 3_600_000,
      scopes: ['user:profile', 'user:inference'],
      acknowledgedConsumerTosRisk: true,
    },
    createdAt: '2026-04-01T00:00:00Z',
  };
}

function buildPanelText(state: SlotState): string {
  const blocks = buildSlotRow(oauthSlot(), state, false, NOW);
  const panel = blocks.find(
    (b): b is { type: 'context'; elements: Array<{ text: string }> } =>
      (b as { type?: string }).type === 'context' && Array.isArray((b as { elements?: unknown[] }).elements),
  );
  const el = panel?.elements?.[0];
  return (el as { text?: string } | undefined)?.text ?? '';
}

describe('#701: usage panel fetched <ago> suffix', () => {
  it('fresh snapshot (2m ago) → suffix present, no warning glyph', () => {
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      usage: {
        fetchedAt: new Date(NOW - 2 * 60_000).toISOString(),
        fiveHour: { utilization: 42, resetsAt: new Date(NOW + 3 * 3_600_000).toISOString() },
      },
    };
    const text = buildPanelText(state);
    expect(text).toContain('fetched 2m ago');
    // Only the suffix should carry the `fetched` text — no warning glyph
    // for fresh snapshots.
    expect(text).not.toMatch(/:warning:\s*fetched/);
  });

  it('stale snapshot (2d ago) → :warning: prepended to the fetched suffix', () => {
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      usage: {
        fetchedAt: new Date(NOW - 2 * 86_400_000).toISOString(),
        fiveHour: { utilization: 3, resetsAt: new Date(NOW + 3 * 3_600_000).toISOString() },
      },
    };
    const text = buildPanelText(state);
    expect(text).toMatch(/:warning: fetched 2d \d+h ago/);
  });

  it('boundary: just inside 10-minute threshold → no warning', () => {
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      usage: {
        fetchedAt: new Date(NOW - 9 * 60_000 - 30_000).toISOString(),
        fiveHour: { utilization: 10, resetsAt: new Date(NOW + 3 * 3_600_000).toISOString() },
      },
    };
    const text = buildPanelText(state);
    expect(text).toContain('fetched 9m ago');
    expect(text).not.toMatch(/:warning:\s*fetched/);
  });

  it('boundary: just past 10-minute threshold → :warning:', () => {
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      usage: {
        fetchedAt: new Date(NOW - 11 * 60_000).toISOString(),
        fiveHour: { utilization: 10, resetsAt: new Date(NOW + 3 * 3_600_000).toISOString() },
      },
    };
    const text = buildPanelText(state);
    expect(text).toMatch(/:warning: fetched 11m ago/);
  });

  it('lastRefreshError + usage → in-panel stale warning above the code fence (same block)', () => {
    const failedAt = NOW - 5 * 60_000;
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      usage: {
        fetchedAt: new Date(NOW - 30 * 60_000).toISOString(),
        fiveHour: { utilization: 42, resetsAt: new Date(NOW + 3 * 3_600_000).toISOString() },
      },
      lastRefreshFailedAt: failedAt,
      lastRefreshError: { kind: 'rate_limited', status: 429, message: 'Refresh throttled (429)', at: failedAt },
    };
    const text = buildPanelText(state);
    // Stale warning appears BEFORE the code fence.
    expect(text.indexOf(':warning: _Usage is stale')).toBeLessThan(text.indexOf('```'));
    expect(text).toContain('last refresh failed 5m ago');
  });

  it('lastRefreshError but NO usage → no panel at all (status-line segment covers it)', () => {
    const failedAt = NOW - 5 * 60_000;
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      lastRefreshFailedAt: failedAt,
      lastRefreshError: { kind: 'server', status: 500, message: 'Refresh server error (500)', at: failedAt },
    };
    const blocks = buildSlotRow(oauthSlot(), state, false, NOW);
    const panels = blocks.filter((b): b is { type: 'context' } => (b as { type?: string }).type === 'context');
    expect(panels).toHaveLength(0);
  });

  // Block-count invariant — the in-panel stale warning must NOT introduce a new block.
  it('stale warning + usage → still exactly ONE context block (50-block invariant)', () => {
    const failedAt = NOW - 5 * 60_000;
    const freshState: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      usage: {
        fetchedAt: new Date(NOW - 30_000).toISOString(),
        fiveHour: { utilization: 10, resetsAt: new Date(NOW + 3 * 3_600_000).toISOString() },
      },
    };
    const staleState: SlotState = {
      ...freshState,
      lastRefreshFailedAt: failedAt,
      lastRefreshError: { kind: 'network', message: 'Refresh network error', at: failedAt },
    };
    const countContext = (s: SlotState) =>
      buildSlotRow(oauthSlot(), s, false, NOW).filter((b) => (b as { type?: string }).type === 'context').length;
    expect(countContext(freshState)).toBe(1);
    expect(countContext(staleState)).toBe(1);
  });
});
