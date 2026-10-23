/**
 * T7/T9/T10 (SSOT 2026-10-23) — the llmux capacity view behind the dashboard's
 * cooldown timeline. Pure: /llmux/status snapshot + tier map + clock → rows.
 *
 *   - per account, availability = the BINDING window (min remaining over 5h ·
 *     7d; model-scoped weekly windows bind only their model, so they are shown
 *     but do not bind); a blocked / cooling / auth-failed account is 0;
 *   - group % = UNWEIGHTED mean over measured accounts (trinity D5: no plan or
 *     price weights in the number; the tier is colour + label only);
 *   - a window past its reset is STALE and an account with no reading is
 *     UNKNOWN — both excluded from the % and counted as 미확인;
 *   - markers: every future window reset of a usable account, and for a blocked
 *     account only the moment it RETURNS (every block lifted);
 *   - nextRefill (usable capacity grows) and nextReturn (first blocked account
 *     back) are kept apart (trinity D6);
 *   - state: empty (no usable account) · low (< 20%) · ok · unknown.
 */
import { describe, expect, it } from 'vitest';
import type { LlmuxAccount, LlmuxStatus } from '../../auth/llmux-client';
import { buildCapacityView } from '../capacity-view';

const NOW_S = 1_800_000_000;
const NOW_MS = NOW_S * 1000;
const w = (utilization: number, inSecs: number) => ({
  utilization,
  resets_at: NOW_S + inSecs,
  resets_in_secs: inSecs,
});
const H = 3600;
const D = 86400;

function acct(over: Partial<LlmuxAccount> & { name: string }): LlmuxAccount {
  return { type: 'oauth', status: 'ok', order: 1, blocked: null, five_hour: null, seven_day: null, ...over };
}

const TIERS = {
  'claude:ai7': 'claude-max-20x',
  'claude:ai3': 'claude-max-5x',
  'claude:ai12': 'claude-max-20x',
  'codex:ai1': 'chatgpt-pro-200',
  'codex:ai2': 'chatgpt-pro-200',
  'codex:ai5': 'chatgpt-pro-500',
  'codex:ai6': 'chatgpt-pro-500',
} as const;

const STATUS: LlmuxStatus = {
  current: 'ai7',
  accounts: [
    acct({ name: 'ai7', group: 'claude', five_hour: w(0.62, 41 * 60), seven_day: w(0.31, 5 * D) }),
    acct({ name: 'ai3', group: 'claude', order: 2, five_hour: w(0.1, 3 * H), seven_day: w(0.2, 4 * D) }),
    acct({
      name: 'ai12',
      group: 'claude',
      order: 3,
      blocked: '7d window exhausted',
      five_hour: w(1, 2 * H),
      seven_day: w(1, 5 * D),
    }),
    acct({ name: 'ai13', group: 'claude', order: 4 }),
    acct({ name: 'ai5', group: 'codex', type: 'codex', five_hour: w(1, 2 * H + 14 * 60), seven_day: w(0.5, 3 * D) }),
    acct({
      name: 'ai1',
      group: 'codex',
      type: 'codex',
      status: 'cooldown',
      cooldown_until: NOW_S + 4 * H,
      five_hour: w(0.3, H),
    }),
    acct({ name: 'ai2', group: 'codex', type: 'codex', status: 'auth_failed' }),
    acct({
      name: 'ai6',
      group: 'codex',
      type: 'codex',
      blocked: '5h utilization 95% ≥ ceiling',
      five_hour: w(0.95, 30 * 60),
      seven_day: w(0.4, 6 * D),
    }),
  ],
};

describe('buildCapacityView', () => {
  const view = buildCapacityView(STATUS, TIERS, NOW_MS);
  const claude = view.groups.find((g) => g.group === 'claude')!;
  const codex = view.groups.find((g) => g.group === 'codex')!;

  it('one row per provider group, Claude first', () => {
    expect(view.available).toBe(true);
    expect(view.groups.map((g) => g.label)).toEqual(['Claude', 'Codex']);
  });

  it('group % = unweighted mean of the binding remaining over measured accounts', () => {
    // ai7 0.38 · ai3 0.80 · ai12 0 (blocked); ai13 has no reading → 미확인, excluded.
    expect(claude.availablePct).toBeCloseTo(39.33, 1);
    expect(claude.availableAccounts).toBe(2);
    expect(claude.unknownAccounts).toBe(1);
    expect(claude.totalAccounts).toBe(4);
    expect(claude.state).toBe('ok');
  });

  it('an empty pool reads 0% and empty', () => {
    expect(codex.availablePct).toBe(0);
    expect(codex.availableAccounts).toBe(0);
    expect(codex.state).toBe('empty');
  });

  it('a usable account gets one marker per future window reset, tagged with its tier', () => {
    const ai7 = claude.markers.filter((m) => m.account === 'ai7');
    expect(ai7.map((m) => [m.window, m.at - NOW_S, Math.round(m.gainPct)])).toEqual([
      ['5h', 41 * 60, 62],
      ['7d', 5 * D, 31],
    ]);
    expect(ai7.every((m) => m.tier === 'claude-max-20x' && !m.returns)).toBe(true);
  });

  it('a blocked account shows only when it returns (the binding window reset)', () => {
    const ai12 = claude.markers.filter((m) => m.account === 'ai12');
    expect(ai12).toHaveLength(1);
    expect(ai12[0]).toMatchObject({ window: '7d', at: NOW_S + 5 * D, returns: true });
  });

  it('an account with no reading and an auth-failed account get no marker', () => {
    expect(claude.markers.some((m) => m.account === 'ai13')).toBe(false);
    expect(codex.markers.some((m) => m.account === 'ai2')).toBe(false);
    const ai2 = codex.accounts.find((a) => a.name === 'ai2')!;
    expect(ai2.blocked).toBe(true);
    expect(ai2.returnAt).toBeUndefined();
  });

  it('cooldown returns at cooldown_until; a ceiling block returns at its fullest window reset', () => {
    expect(codex.markers.find((m) => m.account === 'ai1')).toMatchObject({
      window: 'cooldown',
      at: NOW_S + 4 * H,
      returns: true,
    });
    expect(codex.markers.find((m) => m.account === 'ai6')).toMatchObject({
      window: '5h',
      at: NOW_S + 30 * 60,
      returns: true,
    });
    expect(codex.markers.find((m) => m.account === 'ai5')).toMatchObject({
      window: '5h',
      at: NOW_S + 2 * H + 14 * 60,
      returns: true,
      tier: 'chatgpt-pro-500',
    });
  });

  it('next refill (a usable account resets) and next return (a blocked account is back) stay apart', () => {
    expect(claude.nextRefill).toMatchObject({ account: 'ai7', window: '5h', at: NOW_S + 41 * 60 });
    expect(claude.nextReturn).toMatchObject({ account: 'ai12', at: NOW_S + 5 * D });
    // Codex has no usable account: nothing refills, the first account back is ai6.
    expect(codex.nextRefill).toBeUndefined();
    expect(codex.nextReturn).toMatchObject({ account: 'ai6', at: NOW_S + 30 * 60, tier: 'chatgpt-pro-500' });
  });

  it('a model-scoped weekly window is a marker, not a binding limit', () => {
    const view = buildCapacityView(
      {
        current: null,
        accounts: [
          acct({
            name: 'f',
            group: 'claude',
            five_hour: w(0.2, H),
            seven_day: w(0.2, 3 * D),
            scoped_limits: [{ ...w(1, 2 * D), scope_label: 'Fable' }],
          }),
        ],
      },
      {},
      NOW_MS,
    );
    const g = view.groups[0];
    expect(g.availablePct).toBeCloseTo(80, 5);
    expect(g.markers.find((m) => m.window === '7d-fable')).toMatchObject({ at: NOW_S + 2 * D, returns: false });
  });

  it('markers are sorted by time', () => {
    const ats = claude.markers.map((m) => m.at);
    expect([...ats].sort((a, b) => a - b)).toEqual(ats);
  });
});

describe('buildCapacityView — return only when every block lifts (trinity review)', () => {
  const one = (a: LlmuxAccount) => buildCapacityView({ current: null, accounts: [a] }, {}, NOW_MS).groups[0];

  it('cooldown plus a 5h ceiling: back when the later of the two lifts', () => {
    const g = one(
      acct({
        name: 'c',
        group: 'codex',
        type: 'codex',
        status: 'cooldown',
        cooldown_until: NOW_S + 300,
        blocked: '5h 96.0% > 95%',
        five_hour: w(0.96, 2 * H),
        seven_day: w(0.2, 3 * D),
      }),
    );
    expect(g.accounts[0].returnAt).toBe(NOW_S + 2 * H);
    expect(g.nextReturn).toMatchObject({ account: 'c', at: NOW_S + 2 * H });
  });

  it('an exhausted window with no reset time promises nothing', () => {
    const g = one(acct({ name: 'x', group: 'claude', five_hour: { utilization: 1, resets_at: 0, resets_in_secs: 0 } }));
    expect(g.accounts[0].blocked).toBe(true);
    expect(g.accounts[0].returnAt).toBeUndefined();
    expect(g.markers).toEqual([]);
  });

  it('a block llmux names without a time (paused) promises nothing', () => {
    const g = one(acct({ name: 'p', group: 'claude', blocked: 'paused', five_hour: w(0.3, H), seven_day: w(0.2, D) }));
    expect(g.accounts[0].returnAt).toBeUndefined();
    expect(g.markers).toEqual([]);
  });

  it('two binding windows at the same level: the later reset is the one that raises it', () => {
    const g = one(acct({ name: 'e', group: 'claude', five_hour: w(0.5, H), seven_day: w(0.5, 2 * D) }));
    expect(g.markers.find((m) => m.window === '5h')).toMatchObject({ raises: false });
    expect(g.markers.find((m) => m.window === '7d')).toMatchObject({ raises: true });
    expect(g.nextRefill).toMatchObject({ window: '7d', at: NOW_S + 2 * D });
  });

  it('next refill is the reset that raises availability, not just the next reset', () => {
    // 7d binds at 10% until +3d; the 5h reset in 1h changes nothing usable.
    const g = one(acct({ name: 'b', group: 'claude', five_hour: w(0.2, H), seven_day: w(0.9, 3 * D) }));
    expect(g.availablePct).toBeCloseTo(10, 5);
    expect(g.markers.find((m) => m.window === '5h')).toMatchObject({ raises: false });
    expect(g.nextRefill).toMatchObject({ window: '7d', at: NOW_S + 3 * D });
  });
});

describe('buildCapacityView — edge cases', () => {
  it('a window past its reset is left out on its own — the other binding window still counts', () => {
    const view = buildCapacityView(
      {
        current: null,
        accounts: [
          acct({ name: 'a', group: 'claude', five_hour: w(0.5, -60), seven_day: w(0.1, 2 * D) }),
          acct({ name: 'b', group: 'claude', five_hour: w(0.2, H), seven_day: w(0.2, 2 * D) }),
        ],
      },
      {},
      NOW_MS,
    );
    const g = view.groups[0];
    // a: 5h is past its reset (stale) → its 7d 90% binds; b: 80%.
    expect(g.availablePct).toBeCloseTo(85, 5);
    expect(g.unknownAccounts).toBe(0);
    expect(g.accounts.find((a) => a.name === 'a')).toMatchObject({ stale: true, availablePct: 90 });
  });

  it('an account whose every binding window is stale is unknown', () => {
    const view = buildCapacityView(
      {
        current: null,
        accounts: [
          acct({ name: 'a', group: 'claude', five_hour: w(0.5, -60), seven_day: w(0.1, -60) }),
          acct({ name: 'b', group: 'claude', five_hour: w(0.2, H), seven_day: w(0.2, 2 * D) }),
        ],
      },
      {},
      NOW_MS,
    );
    expect(view.groups[0].availablePct).toBeCloseTo(80, 5);
    expect(view.groups[0].unknownAccounts).toBe(1);
  });

  it('reads an exact plan string llmux reports when the operator map has none', () => {
    const view = buildCapacityView(
      {
        current: null,
        accounts: [
          acct({ name: 'z', group: 'claude', rate_limit_tier: 'default_claude_max_5x', five_hour: w(0.5, H) }),
        ],
      },
      {},
      NOW_MS,
    );
    expect(view.groups[0].markers[0].tier).toBe('claude-max-5x');
  });

  it('low state under 20%', () => {
    const view = buildCapacityView(
      { current: null, accounts: [acct({ name: 'a', group: 'claude', five_hour: w(0.9, H), seven_day: w(0.3, D) })] },
      {},
      NOW_MS,
    );
    expect(view.groups[0].state).toBe('low');
    expect(view.groups[0].availablePct).toBeCloseTo(10, 5);
  });

  it('masks email-shaped account names when llmux runs anonymous', () => {
    const view = buildCapacityView(
      {
        current: null,
        email_anonymous: true,
        accounts: [acct({ name: 'kim.lee@corp.example', group: 'claude', five_hour: w(0.5, H) })],
      },
      {},
      NOW_MS,
    );
    expect(view.groups[0].accounts[0].name).toBe('k***');
    expect(view.groups[0].markers[0].account).toBe('k***');
  });
});

// Live llmux shape (2026-10-23 snapshot): names are `group:local@domain`, and a
// throttled account sits in a cooldown of a few seconds.
describe('buildCapacityView — live llmux shapes', () => {
  it('labels accounts by their local name ([ai7]) and resolves tiers through it', () => {
    const view = buildCapacityView(
      {
        current: null,
        accounts: [
          acct({ name: 'codex:ai5@corp.example', group: 'codex', five_hour: w(0.5, H) }),
          acct({ name: 'claude:ai7@corp.example', group: 'claude', five_hour: w(0.5, H) }),
        ],
      },
      { 'claude:ai7': 'claude-max-20x' },
      NOW_MS,
    );
    const claude = view.groups.find((g) => g.group === 'claude');
    const codex = view.groups.find((g) => g.group === 'codex');
    expect(claude?.accounts[0]).toMatchObject({ name: 'ai7', tier: 'claude-max-20x' });
    expect(claude?.markers[0]).toMatchObject({ account: 'ai7', tier: 'claude-max-20x' });
    expect(codex?.accounts[0]).toMatchObject({ name: 'ai5', tier: 'chatgpt-pro-500' });
  });

  it('keeps the domain when two accounts of a group share a local name', () => {
    const view = buildCapacityView(
      {
        current: null,
        accounts: [
          acct({ name: 'claude:ai@one.example', group: 'claude', five_hour: w(0.5, H) }),
          acct({ name: 'claude:ai@two.example', group: 'claude', five_hour: w(0.5, H) }),
        ],
      },
      {},
      NOW_MS,
    );
    expect(view.groups[0].accounts.map((a) => a.name).sort()).toEqual(['ai@one.example', 'ai@two.example']);
  });

  it('a cooldown of a few seconds is throttling, not a supply problem: the account stays available', () => {
    const view = buildCapacityView(
      {
        current: null,
        accounts: [
          acct({
            name: 'claude:ai41@corp.example',
            group: 'claude',
            status: 'cooldown',
            blocked: 'cooldown 6s',
            cooldown_until: NOW_S + 6,
            five_hour: w(0.37, 2 * H),
            seven_day: w(0.06, 6 * D),
          }),
        ],
      },
      {},
      NOW_MS,
    );
    expect(view.groups[0].accounts[0]).toMatchObject({ name: 'ai41', blocked: false, availablePct: 63 });
    expect(view.groups[0].state).toBe('ok');
  });

  it('a long cooldown still blocks, and the account returns when it lifts', () => {
    const view = buildCapacityView(
      {
        current: null,
        accounts: [
          acct({
            name: 'claude:ai7@corp.example',
            group: 'claude',
            status: 'cooldown',
            blocked: 'cooldown 3d6h',
            cooldown_until: NOW_S + 3 * D + 6 * H,
            five_hour: w(0, 5 * H),
            seven_day: w(1, 3 * D + 6 * H),
          }),
        ],
      },
      {},
      NOW_MS,
    );
    expect(view.groups[0].accounts[0]).toMatchObject({ blocked: true, availablePct: 0 });
    expect(view.groups[0].nextReturn).toMatchObject({ account: 'ai7', at: NOW_S + 3 * D + 6 * H });
  });

  it('a pool with no accounts is no rows, still available', () => {
    expect(buildCapacityView({ current: null, accounts: [] }, {}, NOW_MS)).toMatchObject({
      available: true,
      groups: [],
    });
  });
});
