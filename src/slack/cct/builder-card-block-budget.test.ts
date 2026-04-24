/**
 * #701 block-budget invariant. The refresh-error segment (inside line2 of
 * an existing section block) and the stale-usage warning (inside the same
 * context block as the usage panel) must NOT introduce new Slack blocks.
 * A full 15-slot card with both surfaces active must still fit under the
 * 50-block cap.
 */

import { describe, expect, it } from 'vitest';
import type { AuthKey, SlotState } from '../../cct-store';
import { buildCctCardBlocks } from './builder';

const NOW = Date.parse('2026-04-24T00:00:00Z');

function attachedSlot(keyId: string, name: string): AuthKey {
  return {
    kind: 'cct',
    source: 'setup',
    keyId,
    name,
    setupToken: 'sk-ant-oat01-x',
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

function staleState(keyId: string): SlotState {
  return {
    authState: 'healthy',
    activeLeases: [],
    lastRefreshFailedAt: NOW - 5 * 60_000,
    lastRefreshError: { kind: 'rate_limited', status: 429, message: 'Refresh throttled (429)', at: NOW - 5 * 60_000 },
    consecutiveRefreshFailures: 3,
    usage: {
      fetchedAt: new Date(NOW - 2 * 86_400_000).toISOString(),
      fiveHour: { utilization: 5, resetsAt: new Date(NOW + 3 * 3_600_000).toISOString() },
      sevenDay: { utilization: 2, resetsAt: new Date(NOW + 4 * 86_400_000).toISOString() },
    },
  };
}

describe('#701 block-budget invariant', () => {
  it('15 attached slots with refresh-error + stale-usage surfaces ≤ 50 blocks', () => {
    const slots: AuthKey[] = [];
    const states: Record<string, SlotState> = {};
    for (let i = 0; i < 15; i++) {
      const keyId = `slot-${i}`;
      slots.push(attachedSlot(keyId, `s${i}`));
      states[keyId] = staleState(keyId);
    }
    const blocks = buildCctCardBlocks({ slots, states, nowMs: NOW });
    expect(blocks.length).toBeLessThanOrEqual(50);
  });

  it('per-attached-slot block count is identical with and without refresh error + stale warning', () => {
    const slots: AuthKey[] = [attachedSlot('s1', 'n1')];
    const cleanStates: Record<string, SlotState> = {
      s1: {
        authState: 'healthy',
        activeLeases: [],
        usage: {
          fetchedAt: new Date(NOW - 30_000).toISOString(),
          fiveHour: { utilization: 10, resetsAt: new Date(NOW + 3 * 3_600_000).toISOString() },
        },
      },
    };
    const staleStates: Record<string, SlotState> = { s1: staleState('s1') };
    const cleanBlocks = buildCctCardBlocks({ slots, states: cleanStates, nowMs: NOW });
    const staleBlocks = buildCctCardBlocks({ slots, states: staleStates, nowMs: NOW });
    expect(staleBlocks.length).toBe(cleanBlocks.length);
  });
});
