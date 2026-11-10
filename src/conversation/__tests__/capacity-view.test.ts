/**
 * LLM capacity v2 (2026-10-25): the weekly window, account-equivalents, a replayed forecast.
 * There is no 5-hour window since 2026-11 (owner, 2026-11-10): no provider reports one.
 *
 * The user's two questions:
 *   1. How many max accounts' worth is left — usable now and this week (7d)?
 *   2. What comes back, when, and through which reset (weekly, or a block lifting)?
 *
 * Per account: now = rem7 unless a blocker is active (then 0); week = rem7 unless held.
 * Blockers are tracked on their own (7d ceiling, cooldown > 120 s, model-scoped, held).
 * Totals are weighted by tier (x20 = 1, x5 = ¼, $500 = 1, $200 = 0.4); unknown tiers,
 * held accounts and accounts with no weekly measurement stay out of the totals.
 * Events (weekly reset, block release) are replayed in time order — at one instant a
 * release first, then weekly; nothing is merged — and each delta is the weighted
 * before/after difference. A block with no known lift time is held.
 */
import { describe, expect, it } from 'vitest';
import type { LlmuxAccount, LlmuxStatus } from '../../auth/llmux-client';
import { buildCapacityView, type CapacityGroupView } from '../capacity-view';

const NOW_S = 1_800_000_000;
const NOW_MS = NOW_S * 1000;
const H = 3600;
const D = 86400;
const w = (utilization: number, inSecs: number) => ({ utilization, resets_at: NOW_S + inSecs, resets_in_secs: inSecs });

function acct(over: Partial<LlmuxAccount> & { name: string }): LlmuxAccount {
  return { type: 'oauth', status: 'ok', order: 1, blocked: null, seven_day: null, ...over };
}
const X20 = { 'claude:ai1': 'claude-max-20x', 'claude:ai2': 'claude-max-20x', 'claude:ai3': 'claude-max-20x' } as const;

function group(accounts: LlmuxAccount[], tiers: Record<string, string> = X20, g = 'claude'): CapacityGroupView {
  const view = buildCapacityView({ current: null, accounts } as LlmuxStatus, tiers as never, NOW_MS);
  const found = view.groups.find((x) => x.group === g);
  if (!found) throw new Error(`no ${g} group`);
  return found;
}
const r1 = (x: number) => Math.round(x * 10) / 10;

describe('capacity v2 — the two measures', () => {
  it('now = weekly remaining of the unblocked accounts, week = weekly; both as max-account equivalents', () => {
    const g = group([
      acct({ name: 'claude:ai1@corp.example', group: 'claude', seven_day: w(0.5, 3 * D) }),
      acct({ name: 'claude:ai2@corp.example', group: 'claude', seven_day: w(0.3, 4 * D) }),
    ]);
    expect(g.total).toBe(2);
    expect(r1(g.now)).toBe(1.2); // .5 + .7
    expect(r1(g.week)).toBe(1.2);
  });

  it('weights by tier: Max x5 is a quarter of x20, Pro $200 is 0.4 of $500', () => {
    const claude = group(
      [
        acct({ name: 'claude:ai1@c', group: 'claude', seven_day: w(0, D) }),
        acct({ name: 'claude:ai2@c', group: 'claude', seven_day: w(0, D) }),
      ],
      { 'claude:ai1': 'claude-max-20x', 'claude:ai2': 'claude-max-5x' },
    );
    expect(claude.total).toBe(1.25);
    const codex = group(
      [
        acct({ name: 'codex:ai5@c', group: 'codex', type: 'codex', seven_day: w(0, D) }),
        acct({ name: 'codex:ai2@c', group: 'codex', type: 'codex', seven_day: w(0.5, D) }),
      ],
      {},
      'codex',
    );
    expect(codex.total).toBe(1.4);
    expect(r1(codex.week)).toBe(1.2);
  });

  it('every provider has the weekly measure only: nothing blocked → now equals week', () => {
    const g = group([acct({ name: 'codex:ai5@c', group: 'codex', type: 'codex', seven_day: w(0.25, D) })], {}, 'codex');
    expect(g).not.toHaveProperty('has5h');
    expect(g.now).toBe(g.week);
  });

  it('held (paused / auth) and no weekly measurement stay out of the totals, counted apart', () => {
    const g = group([
      acct({ name: 'claude:ai1@c', group: 'claude', seven_day: w(0.5, D) }),
      acct({ name: 'claude:ai9@c', group: 'claude', seven_day: w(0, D) }),
      acct({ name: 'claude:ai2@c', group: 'claude', blocked: 'paused', seven_day: w(0, D) }),
      acct({ name: 'claude:ai3@c', group: 'claude', status: 'auth_failed', seven_day: w(0, D) }),
    ]);
    // ai9 has no tier: a Claude account is assumed Max x20 (operator, 2026-10-26)
    expect(g.total).toBe(2);
    expect(r1(g.week)).toBe(1.5);
    expect(g.excluded).toEqual({ unknownTier: 0, held: 2, noMeasure: 0 });
    expect(g.tierAssumed).toBe(1);
    const nm = group([acct({ name: 'claude:ai1@c', group: 'claude' })]);
    expect(nm.excluded.noMeasure).toBe(1);
    expect(nm.total).toBe(0);
    expect(nm.state).toBe('unknown');
  });
});

// A dev host (2026-10-26): llmux reports no plan and the host had no SOMA_LLMUX_ACCOUNT_TIERS,
// so every Claude account was "티어 미지정" and the provider read "계산 불가". The operator's
// rule: an untiered Claude account counts as Max x20, disclosed as an assumption.
describe('capacity v2 — an untiered Claude account is assumed Max x20', () => {
  it('a pool with no tier map is counted, every account flagged as assumed', () => {
    const g = group(
      [
        acct({ name: 'claude:ai1@c', group: 'claude', seven_day: w(0.5, D) }),
        acct({ name: 'claude:ai2@c', group: 'claude', seven_day: w(0.2, D) }),
      ],
      {},
    );
    expect(g.total).toBe(2);
    expect(r1(g.now)).toBe(1.3); // min(.5,.5) + min(1,.8)
    expect(r1(g.week)).toBe(1.3);
    expect(g.state).not.toBe('unknown');
    expect(g.excluded.unknownTier).toBe(0);
    expect(g.tierAssumed).toBe(2);
    expect(g.units.map((u) => [u.tier, u.weight, u.tierAssumed])).toEqual([
      ['claude-max-20x', 1, true],
      ['claude-max-20x', 1, true],
    ]);
  });

  it('a mapped account is not an assumption; a held untiered one is not counted as one either', () => {
    const g = group(
      [
        acct({ name: 'claude:ai1@c', group: 'claude', seven_day: w(0, D) }),
        acct({ name: 'claude:ai7@c', group: 'claude', seven_day: w(0, D) }),
        acct({ name: 'claude:ai8@c', group: 'claude', blocked: 'paused', seven_day: w(0, D) }),
      ],
      { 'claude:ai1': 'claude-max-5x' },
    );
    expect(g.total).toBe(1.25); // x5 ¼ + assumed x20 1
    expect(g.tierAssumed).toBe(1);
    expect(g.units[0].tierAssumed).toBeUndefined();
    // a held untiered account is not counted, so nothing is assumed about it (review P2)
    expect(g.units[2]).toMatchObject({ excluded: 'held', weight: null });
    expect(g.units[2].tier).toBeUndefined();
    expect(g.units[2].tierAssumed).toBeUndefined();
  });

  it('Codex has no assumption: an untiered Codex account stays out of the totals', () => {
    const g = group([acct({ name: 'codex:ai9@c', group: 'codex', type: 'codex', seven_day: w(0, D) })], {}, 'codex');
    expect(g.total).toBe(0);
    expect(g.excluded.unknownTier).toBe(1);
    expect(g.tierAssumed).toBe(0);
  });
});

// llmux 0.2.26 (.prd/25) reports each account's plan: with it, no tier map is needed and
// nothing is assumed — Claude via rate_limit_tier, Codex via plan_type.
describe('capacity v2 — plans llmux reports need no tier map', () => {
  it('Claude rate_limit_tier and Codex plan_type weigh the accounts, nothing assumed', () => {
    const claude = group(
      [
        acct({
          name: 'claude:ai1@c',
          group: 'claude',
          rate_limit_tier: 'default_claude_max_20x',
          seven_day: w(0, D),
        }),
        acct({
          name: 'claude:ai2@c',
          group: 'claude',
          rate_limit_tier: 'default_claude_max_5x',
          seven_day: w(0, D),
        }),
      ],
      {},
    );
    expect(claude.total).toBe(1.25);
    expect(claude.tierAssumed).toBe(0);
    const codex = group(
      [
        acct({ name: 'codex:ai@c', group: 'codex', type: 'codex', plan_type: 'pro', seven_day: w(0, D) }),
        acct({ name: 'codex:ai9@c', group: 'codex', type: 'codex', plan_type: 'promax', seven_day: w(0, D) }),
      ],
      {},
      'codex',
    );
    expect(codex.total).toBe(1.4);
    expect(codex.excluded.unknownTier).toBe(0);
  });
});

describe('capacity v2 — estimates and stale blocks', () => {
  it('the per-account estimate flag and the estimate count use one rule', () => {
    const g = group([
      acct({ name: 'claude:ai1@c', group: 'claude', seven_day: w(0.6, -60) }),
      acct({ name: 'claude:ai2@c', group: 'claude', seven_day: w(0.7, 3 * D) }),
      acct({
        name: 'claude:ai3@c',
        group: 'claude',
        blocked: '7d 100.0% > 99%',
        seven_day: w(1, 2 * D),
      }),
    ]);
    expect(g.units.filter((u) => u.estimated).length).toBe(g.estimated);
  });

  it('a weekly reset that already passed counts as full and is flagged', () => {
    const g = group([acct({ name: 'claude:ai1@c', group: 'claude', seven_day: w(1, -60) })]);
    expect(g.week).toBe(1);
    expect(g.estimated).toBe(1);
  });

  it('a cooldown of 120 s or less, or one already over, does not block', () => {
    const g = group([
      acct({
        name: 'claude:ai1@c',
        group: 'claude',
        status: 'cooldown',
        blocked: 'cooldown 6s',
        cooldown_until: NOW_S + 6,
        seven_day: w(0.5, D),
      }),
      acct({
        name: 'claude:ai2@c',
        group: 'claude',
        status: 'cooldown',
        blocked: 'cooldown 5s',
        cooldown_until: NOW_S - 3,
        seven_day: w(0.5, D),
      }),
    ]);
    expect(r1(g.now)).toBe(1);
    expect(g.units.every((u) => !u.blocks.cooldownUntil)).toBe(true);
  });
});

describe('capacity v2 — blockers tracked on their own', () => {
  it('a "5h …" block from an older llmux has no window to lift it: held, never a 5h refill', () => {
    const g = group([
      acct({
        name: 'claude:ai1@c',
        group: 'claude',
        blocked: '5h 100.0% > 99%',
        seven_day: w(0.4, 3 * D),
        ...({ five_hour: w(1, 2 * H) } as object),
      }),
      acct({ name: 'claude:ai2@c', group: 'claude', seven_day: w(0, D) }),
    ]);
    expect(g.excluded.held).toBe(1);
    expect(g.units[0].blocks).not.toHaveProperty('fiveHour');
    expect(g.events.map((e) => e.cause)).not.toContain('5h');
  });

  it('a long cooldown blocks "now"; its release lifts "now" only and adds no quota (cause release)', () => {
    const g = group([
      acct({
        name: 'claude:ai1@c',
        group: 'claude',
        status: 'cooldown',
        blocked: 'cooldown 2h',
        cooldown_until: NOW_S + 2 * H,
        seven_day: w(0.3, 3 * D),
      }),
    ]);
    expect(g.now).toBe(0);
    expect(r1(g.week)).toBe(0.7);
    const release = g.events.find((e) => e.cause === 'release');
    expect(release).toBeDefined();
    expect(r1(release?.dNow ?? 0)).toBe(0.7);
    expect(release?.dWeek).toBe(0);
  });

  it('a weekly reset during a cooldown is credited to the reset; the release only lifts "now"', () => {
    const g = group([
      acct({
        name: 'claude:ai1@c',
        group: 'claude',
        status: 'cooldown',
        blocked: 'cooldown 2d',
        cooldown_until: NOW_S + 2 * D,
        seven_day: w(1, D),
      }),
    ]);
    const reset = g.events.find((e) => e.cause === '7d');
    const release = g.events.find((e) => e.cause === 'release');
    expect(r1(reset?.dWeek ?? 0)).toBe(1);
    expect(reset?.dNow).toBe(0);
    expect(r1(release?.dNow ?? 0)).toBe(1);
    expect(release?.dWeek).toBe(0);
  });

  it('a weekly ceiling ("7d …") blocks until its weekly reset', () => {
    const g = group([
      acct({
        name: 'claude:ai1@c',
        group: 'claude',
        blocked: '7d 100.0% > 99%',
        seven_day: w(1, 2 * D),
      }),
    ]);
    expect(g.now).toBe(0);
    expect(g.state).toBe('empty');
    expect(g.events).toHaveLength(1);
    expect(g.events[0]).toMatchObject({ cause: '7d', at: NOW_S + 2 * D });
    expect(r1(g.events[0].dNow)).toBe(1);
    expect(r1(g.events[0].dWeek)).toBe(1);
  });

  // trinity r3 (astra): never merge accounting — each cause keeps its own delta.
  it('a cooldown that ends one second before the weekly reset: the reset gets the gain', () => {
    const g = group([
      acct({
        name: 'claude:ai1@c',
        group: 'claude',
        status: 'cooldown',
        blocked: 'cooldown 2d',
        cooldown_until: NOW_S + 2 * D - 1,
        seven_day: w(1, 2 * D),
      }),
    ]);
    expect(g.events.map((e) => [e.cause, r1(e.dNow), r1(e.dWeek)])).toEqual([
      ['release', 0, 0],
      ['7d', 1, 1],
    ]);
  });

  it('a model-scoped block ("fable …") holds the account until that window resets', () => {
    const g = group([
      acct({
        name: 'claude:ai1@c',
        group: 'claude',
        blocked: 'fable 99.0% > 98%',
        seven_day: w(0.2, 5 * D),
        scoped_limits: [{ scope_label: 'Fable', utilization: 0.99, resets_at: NOW_S + 2 * D, resets_in_secs: 2 * D }],
      }),
    ]);
    expect(g.now).toBe(0);
    const lift = g.events.find((e) => e.cause === 'release');
    expect(lift?.at).toBe(NOW_S + 2 * D);
    expect(r1(lift?.dNow ?? 0)).toBe(0.8);
    const unknown = group([
      acct({
        name: 'claude:ai1@c',
        group: 'claude',
        blocked: 'fable 99.0% > 98%',
        seven_day: w(0.2, 5 * D),
      }),
    ]);
    expect(unknown.excluded.held).toBe(1);
  });

  // trinity r3 (grok): a block with no known lift time is held, never a silent pass.
  it('a block with an unknown reason and no window to lift it is held, not usable', () => {
    const g = group([
      acct({ name: 'claude:ai1@c', group: 'claude', blocked: 'mystery 1', seven_day: w(0.4, D) }),
      acct({ name: 'claude:ai2@c', group: 'claude', seven_day: w(0, D) }),
    ]);
    expect(g.excluded.held).toBe(1);
    expect(g.total).toBe(1);
  });

  it('a cooldown with no cooldown_until (status or reason) is held, with no return drawn', () => {
    const g = group([
      acct({ name: 'claude:ai1@c', group: 'claude', status: 'cooldown', seven_day: w(0.2, D) }),
      acct({
        name: 'claude:ai2@c',
        group: 'claude',
        blocked: 'cooldown ?',
        seven_day: w(0.2, D),
      }),
      acct({ name: 'claude:ai3@c', group: 'claude', seven_day: w(0, D) }),
    ]);
    expect(g.excluded.held).toBe(2);
    expect(g.events.some((e) => e.account === 'ai1' || e.account === 'ai2')).toBe(false);
  });

  // trinity r4 (grok P3): a paused status with no reason string is held too.
  it('a paused status with no reason is held', () => {
    const g = group([
      acct({ name: 'claude:ai1@c', group: 'claude', status: 'paused', seven_day: w(0, D) }),
      acct({ name: 'claude:ai2@c', group: 'claude', seven_day: w(0, D) }),
    ]);
    expect(g.excluded.held).toBe(1);
    expect(g.units[0].held).toBe('paused');
  });

  it('held accounts never get a scheduled recovery', () => {
    const g = group([
      acct({ name: 'claude:ai1@c', group: 'claude', seven_day: w(0, D) }),
      acct({ name: 'claude:ai2@c', group: 'claude', blocked: 'paused', seven_day: w(0.5, D) }),
    ]);
    expect(g.events.every((e) => e.account !== 'ai2')).toBe(true);
  });
});

describe('capacity v2 — trinity r4 (astra): no capacity without evidence', () => {
  it('an expired model-scoped block is lifted, not held', () => {
    const g = group([
      acct({
        name: 'claude:ai1@c',
        group: 'claude',
        blocked: 'fable 99.0% > 98%',
        seven_day: w(0.2, 5 * D),
        scoped_limits: [{ scope_label: 'Fable', utilization: 0.99, resets_at: NOW_S - 60, resets_in_secs: 0 }],
      }),
    ]);
    expect(g.excluded.held).toBe(0);
    expect(r1(g.now)).toBe(0.8);
  });

  it('a short cooldown over 120 s blocks "now"; its release gives back the weekly remainder', () => {
    const g = group([
      acct({
        name: 'claude:ai1@c',
        group: 'claude',
        status: 'cooldown',
        blocked: 'cooldown 3m',
        cooldown_until: NOW_S + 180,
        seven_day: w(0.2, 3 * D),
      }),
      acct({ name: 'claude:ai2@c', group: 'claude', seven_day: w(0, D) }),
    ]);
    const release = g.events.find((e) => e.account === 'ai1' && e.cause === 'release');
    expect(r1(release?.dNow ?? 0)).toBe(0.8);
  });

  it('a Claude pool with weekly readings only is measured: no 5h to wait for (2026-11)', () => {
    const g = group([acct({ name: 'claude:ai1@c', group: 'claude', seven_day: w(0.5, D) })]);
    expect(g.now).toBe(0.5);
    expect(g).not.toHaveProperty('unmeasured5h');
    expect(g.state).toBe('ok');
  });
});

describe('capacity v2 — PR #417 review gate (astra) edge cases', () => {
  it('cooldown_until 0 is no end time: a cooldown with it is held, not expired', () => {
    const g = group([
      acct({
        name: 'claude:ai1@c',
        group: 'claude',
        status: 'cooldown',
        cooldown_until: 0,
        seven_day: w(0, D),
      }),
      acct({ name: 'claude:ai2@c', group: 'claude', seven_day: w(0, D) }),
    ]);
    expect(g.excluded.held).toBe(1);
  });

  it('an exhausted, unblocked account adds nothing usable', () => {
    const g = group([
      acct({ name: 'claude:ai1@c', group: 'claude', seven_day: w(1, 2 * D) }),
      acct({ name: 'claude:ai2@c', group: 'claude', seven_day: w(0, D) }),
    ]);
    expect(g.units.map((u) => [u.blocked, u.now])).toEqual([
      [false, 0],
      [false, 1],
    ]);
  });

  it('no return is promised when the account lifts into an exhausted window with no known reset', () => {
    const g = group([
      acct({
        name: 'claude:ai1@c',
        group: 'claude',
        status: 'cooldown',
        blocked: 'cooldown 2h',
        cooldown_until: NOW_S + 2 * H,
        seven_day: { utilization: 1, resets_at: 0, resets_in_secs: 0 },
      }),
    ]);
    expect(g.units[0].returnAt).toBeUndefined();
  });
});

describe('capacity v2 — the replayed forecast', () => {
  it('keeps small gains (they are summed; only labels may hide them) and stays within 7 days', () => {
    const g = group([
      acct({ name: 'claude:ai1@c', group: 'claude', seven_day: w(0.01, 3 * D) }),
      acct({ name: 'claude:ai2@c', group: 'claude', seven_day: w(0.5, 9 * D) }),
    ]);
    const small = g.events.find((e) => e.account === 'ai1');
    expect(small?.dWeek).toBeGreaterThan(0);
    expect(small?.dWeek).toBeLessThan(0.05);
    expect(g.events.some((e) => e.account === 'ai2' && e.cause === '7d')).toBe(false);
  });

  it('labels accounts by their short name and carries the tier on events', () => {
    const g = group([acct({ name: 'claude:ai1@corp.example', group: 'claude', seven_day: w(0.5, D) })]);
    expect(g.units[0]).toMatchObject({ name: 'ai1', tier: 'claude-max-20x', weight: 1 });
    expect(g.events[0]).toMatchObject({ account: 'ai1', tier: 'claude-max-20x' });
  });
});

describe('capacity v2 — state and freshness', () => {
  it('shows subscription providers only: an API-key pool has no max-account unit', () => {
    const view = buildCapacityView(
      {
        current: null,
        accounts: [
          acct({ name: 'claude:ai1@c', group: 'claude', seven_day: w(0, D) }),
          acct({ name: 'grok:key1', group: 'grok', type: 'grok' }),
        ],
      } as LlmuxStatus,
      X20 as never,
      NOW_MS,
    );
    expect(view.groups.map((g) => g.group)).toEqual(['claude']);
  });

  // trinity PR #1180 review (grok P1): the state says what can run now, not what the week still holds.
  it('a pool whose every account is held back by a block is empty even with weekly quota left', () => {
    const g = group([
      acct({
        name: 'claude:ai1@c',
        group: 'claude',
        status: 'cooldown',
        blocked: 'cooldown 2h',
        cooldown_until: NOW_S + 2 * H,
        seven_day: w(0.3, 3 * D),
      }),
      acct({
        name: 'claude:ai2@c',
        group: 'claude',
        blocked: 'fable 99.0% > 98%',
        seven_day: w(0.2, 5 * D),
        scoped_limits: [{ scope_label: 'Fable', utilization: 0.99, resets_at: NOW_S + D, resets_in_secs: D }],
      }),
    ]);
    expect(g.now).toBe(0);
    expect(r1(g.week)).toBe(1.5);
    expect(g.state).toBe('empty');
    // one of the two held back: half the pool usable now → ok; a sliver usable → low
    const half = group([
      acct({ name: 'claude:ai1@c', group: 'claude', seven_day: w(0.3, 3 * D) }),
      acct({
        name: 'claude:ai2@c',
        group: 'claude',
        status: 'cooldown',
        blocked: 'cooldown 2h',
        cooldown_until: NOW_S + 2 * H,
        seven_day: w(0, 3 * D),
      }),
    ]);
    expect(half.state).toBe('ok');
    const sliver = group([
      acct({ name: 'claude:ai1@c', group: 'claude', seven_day: w(0.9, 3 * D) }),
      acct({
        name: 'claude:ai2@c',
        group: 'claude',
        status: 'cooldown',
        blocked: 'cooldown 2h',
        cooldown_until: NOW_S + 2 * H,
        seven_day: w(0, 3 * D),
      }),
    ]);
    expect(sliver.state).toBe('low');
  });

  it('state: low under 20% of the pool usable now, ok above', () => {
    const low = group([acct({ name: 'claude:ai1@c', group: 'claude', seven_day: w(0.9, D) })]);
    expect(low.state).toBe('low');
    const ok = group([acct({ name: 'claude:ai1@c', group: 'claude', seven_day: w(0.2, D) })]);
    expect(ok.state).toBe('ok');
  });

  it('reports the oldest llmux measurement of the counted accounts', () => {
    const g = group([
      acct({
        name: 'claude:ai1@c',
        group: 'claude',
        seven_day: w(0, D),
        last_refresh_ms: (NOW_S - 3 * H) * 1000,
      }),
      acct({
        name: 'claude:ai2@c',
        group: 'claude',
        seven_day: w(0, D),
        last_refresh_ms: (NOW_S - H) * 1000,
      }),
    ]);
    expect(g.oldestRefreshAt).toBe(NOW_S - 3 * H);
  });
});
