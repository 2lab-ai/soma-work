/**
 * The 5-hour usage window is gone (owner, 2026-11-04: "이제 5시간 사용량 있는
 * 프로바이더가 없어짐"; 2026-11-10: "llmux에서도 완전히 삭제해주고, soma-work에서도
 * 완전히 삭제해줘"). No provider reports one, so soma-work neither reads, keeps,
 * gates on nor shows it. A reading that still arrives — an older llmux daemon, a
 * stored CCT snapshot, an operator config.json seeded before the removal — is
 * ignored, never an error.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthKey } from '../auth/auth-key';
import type { LlmuxAccount, LlmuxStatus } from '../auth/llmux-client';
import type { CctStoreSnapshot, SlotState } from '../cct-store/types';
import { buildCapacityView } from '../conversation/capacity-view';
import { cctSlotsToUsage, llmuxAccountsToUsage } from '../conversation/new-task-usage';
import { selectBestRotationCandidate } from '../oauth/auto-rotate';
import { fetchUsage } from '../oauth/usage';
import { accountLines, groupSummary } from '../slack/auth/capacity';
import { buildSlotRow } from '../slack/cct/builder';
import { DEFAULT_UI_SURFACES, normalizeUiSurfacesConfig, SURFACE_FIELD_REGISTRY } from '../slack/surface-config';

const NOW_MS = Date.parse('2026-11-10T00:00:00Z');
const NOW_S = NOW_MS / 1000;

/** A stale 5h reading as an older llmux / a stored snapshot would still carry it. */
const LEGACY_FIVE = { utilization: 1, resets_at: NOW_S + 3600, resets_in_secs: 3600 };

function llmuxAccount(over: Partial<LlmuxAccount> & Record<string, unknown> = {}): LlmuxAccount {
  return {
    name: 'claude:ai1@example.com',
    type: 'oauth',
    group: 'claude',
    status: 'ok',
    order: 1,
    blocked: null,
    seven_day: { utilization: 0.4, resets_at: NOW_S + 3 * 86400, resets_in_secs: 3 * 86400 },
    ...over,
  } as LlmuxAccount;
}

function cctSlot(keyId: string): AuthKey {
  return {
    kind: 'cct',
    source: 'setup',
    keyId,
    name: keyId,
    setupToken: 'sk-ant-oat01-xxxxxxxx',
    oauthAttachment: {
      accessToken: 't',
      refreshToken: 'r',
      expiresAtMs: NOW_MS + 7 * 3_600_000,
      scopes: ['user:profile', 'user:inference'],
      acknowledgedConsumerTosRisk: true,
    },
    createdAt: '2026-11-01T00:00:00Z',
  } as AuthKey;
}

/** A stored usage snapshot from before the removal still has `fiveHour`. */
function legacyState(fiveUtil: number, sevenUtil: number): SlotState {
  return {
    authState: 'healthy',
    activeLeases: [],
    usage: {
      fetchedAt: new Date(NOW_MS - 60_000).toISOString(),
      fiveHour: { utilization: fiveUtil, resetsAt: new Date(NOW_MS + 3_600_000).toISOString() },
      sevenDay: { utilization: sevenUtil, resetsAt: new Date(NOW_MS + 3 * 86_400_000).toISOString() },
    },
  } as unknown as SlotState;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('5h window removed — CCT usage (Anthropic /api/oauth/usage)', () => {
  it('a five_hour window in the response is not kept in the snapshot', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              five_hour: { utilization: 99, resets_at: '2026-11-10T03:00:00Z' },
              seven_day: { utilization: 12, resets_at: '2026-11-13T00:00:00Z' },
            }),
            { status: 200 },
          ),
      ),
    );
    const { snapshot } = await fetchUsage('token');
    expect(snapshot).not.toHaveProperty('fiveHour');
    expect(snapshot.sevenDay).toEqual({ utilization: 12, resetsAt: '2026-11-13T00:00:00Z' });
  });

  it('auto-rotation gates and sorts on the weekly window only — a stored 5h reading changes nothing', () => {
    const snap = {
      registry: { slots: [cctSlot('a'), cctSlot('b')], activeKeyId: 'b' },
      state: { a: legacyState(100, 10), b: legacyState(0, 10) },
    } as unknown as CctStoreSnapshot;
    // Same weekly reset and utilization: the tie goes to keyId order, not to the 5h reading.
    const winner = selectBestRotationCandidate(snap, NOW_MS, { sevenDayMax: 90 });
    expect(winner?.keyId).toBe('a');
    expect(winner).not.toHaveProperty('fiveHourUtilization');
  });

  it('the CCT card shows no 5h row for a stored 5h reading', () => {
    const blocks = buildSlotRow(cctSlot('a'), legacyState(42, 10), false, NOW_MS);
    const text = JSON.stringify(blocks);
    expect(text).toContain('7d');
    // The panel row reads "5h        ████…" (a JSON "\n" before it, so no \b): any "5h" then a space.
    expect(text).not.toMatch(/5h\s/);
  });

  it('the new-task battery reads no 5h window from a CCT slot', () => {
    const [account] = cctSlotsToUsage([legacyState(42, 10)], NOW_MS);
    expect(account.windows.map((w) => w.label)).toEqual(['7d', '7d-sonnet']);
  });
});

describe('5h window removed — llmux status', () => {
  it('a Claude pool with weekly readings only is measured, not "unknown" (no 5h to wait for)', () => {
    const status = { accounts: [llmuxAccount()] } as LlmuxStatus;
    const [claude] = buildCapacityView(status, {}, NOW_MS).groups;
    expect(claude.state).toBe('ok');
    // Max x20 assumed (weight 1): 60% of the week left, all of it usable now.
    expect(claude.week).toBeCloseTo(0.6);
    expect(claude.now).toBeCloseTo(0.6);
    expect(claude).not.toHaveProperty('has5h');
    expect(claude).not.toHaveProperty('unmeasured5h');
    expect(claude.units[0]).not.toHaveProperty('unmeasured5h');
    expect(claude.units[0].blocks).not.toHaveProperty('fiveHour');
  });

  it('a 5h reading from an older llmux is ignored: no 5h cut on "now", no 5h refill', () => {
    const status = { accounts: [llmuxAccount({ five_hour: LEGACY_FIVE })] } as LlmuxStatus;
    const [claude] = buildCapacityView(status, {}, NOW_MS).groups;
    expect(claude.now).toBeCloseTo(0.6);
    expect(claude.events.map((e) => e.cause)).toEqual(['7d']);
  });

  it('the new-task battery reads no 5h window from llmux', () => {
    const [account] = llmuxAccountsToUsage([llmuxAccount({ five_hour: LEGACY_FIVE })], NOW_MS);
    expect(account.windows.map((w) => w.label)).toEqual(['7d']);
  });

  it('the Slack auth card names no 5h window, and a stale 5h reading does not mark the account unavailable', () => {
    const account = llmuxAccount({ five_hour: { ...LEGACY_FIVE, utilization: 1 } });
    const lines = [...groupSummary([account], NOW_MS), ...accountLines(account, NOW_MS)].join('\n');
    expect(lines).not.toMatch(/\b5h\b/);
    expect(lines).toContain('공통 한도 여유 1/1');
  });
});

describe('5h window removed — turn notification surface', () => {
  it('the turn-end surface has no fivehour field and no default line renders one', () => {
    expect(SURFACE_FIELD_REGISTRY.turnend).not.toContain('fivehour');
    expect(JSON.stringify(DEFAULT_UI_SURFACES)).not.toMatch(/fivehour|"5h"/);
  });

  it('a config.json seeded before the removal still loads: its fivehour entry is dropped without a warning', () => {
    const { config, warnings } = normalizeUiSurfacesConfig({
      turnend: {
        lines: [
          [
            { field: 'duration', label: 'Dur' },
            { field: 'fivehour', label: '5h', bar: { width: 6 } },
            { field: 'sevenday', label: '7d' },
          ],
        ],
      },
    });
    expect(warnings).toEqual([]);
    expect(config.turnend?.lines?.[0].fields.map((f) => f.field)).toEqual(['duration', 'sevenday']);
  });
});
