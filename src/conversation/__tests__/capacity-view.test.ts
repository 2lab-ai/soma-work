/**
 * LLM capacity v2 (2026-10-25): two windows, account-equivalents, a replayed forecast.
 *
 * The user's two questions:
 *   1. How many max accounts' worth is left — usable now (5h ∧ 7d) and this week (7d)?
 *   2. What comes back, when, and through which reset (5h vs weekly)?
 *
 * Per account: now = min(rem5, rem7) unless a blocker is active; week = rem7 unless held.
 * Blockers are tracked on their own (7d ceiling, 5h ceiling, cooldown > 120 s, held).
 * Totals are weighted by tier (x20 = 1, x5 = ¼, $500 = 1, $200 = 0.4); unknown tiers,
 * held accounts and accounts with no weekly measurement stay out of the totals.
 * Events (5h reset, weekly reset, block release) are replayed in time order — at one
 * instant a release first, then 5h, then weekly; nothing is merged — and each delta is
 * the weighted before/after difference. A block with no known lift time is held.
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
  return { type: 'oauth', status: 'ok', order: 1, blocked: null, five_hour: null, seven_day: null, ...over };
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
  it('now = min(5h, weekly) per account, week = weekly; both as max-account equivalents', () => {
    const g = group([
      acct({ name: 'claude:ai1@corp.example', group: 'claude', five_hour: w(0.2, 2 * H), seven_day: w(0.5, 3 * D) }),
      acct({ name: 'claude:ai2@corp.example', group: 'claude', five_hour: w(0.9, H), seven_day: w(0.3, 4 * D) }),
    ]);
    expect(g.has5h).toBe(true);
    expect(g.total).toBe(2);
    expect(r1(g.now)).toBe(0.6); // min(.8,.5) + min(.1,.7)
    expect(r1(g.week)).toBe(1.2); // .5 + .7
    expect(g.binding).toEqual({ fiveHour: 1, weekly: 1 });
  });

  it('weights by tier: Max x5 is a quarter of x20, Pro $200 is 0.4 of $500', () => {
    const claude = group(
      [
        acct({ name: 'claude:ai1@c', group: 'claude', five_hour: w(0, H), seven_day: w(0, D) }),
        acct({ name: 'claude:ai2@c', group: 'claude', five_hour: w(0, H), seven_day: w(0, D) }),
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

  it('a group with no five_hour data shows the weekly measure only (Codex today)', () => {
    const g = group([acct({ name: 'codex:ai5@c', group: 'codex', type: 'codex', seven_day: w(0.25, D) })], {}, 'codex');
    expect(g.has5h).toBe(false);
    expect(g.now).toBe(g.week);
  });

  it('unknown tier, held (paused / auth) and no weekly measurement stay out of the totals, counted apart', () => {
    const g = group([
      acct({ name: 'claude:ai1@c', group: 'claude', seven_day: w(0.5, D), five_hour: w(0, H) }),
      acct({ name: 'claude:ai9@c', group: 'claude', seven_day: w(0, D), five_hour: w(0, H) }),
      acct({ name: 'claude:ai2@c', group: 'claude', blocked: 'paused', seven_day: w(0, D) }),
      acct({ name: 'claude:ai3@c', group: 'claude', status: 'auth_failed', seven_day: w(0, D) }),
    ]);
    expect(g.total).toBe(1);
    expect(r1(g.week)).toBe(0.5);
    expect(g.excluded).toEqual({ unknownTier: 1, held: 2, noMeasure: 0 });
    const nm = group([acct({ name: 'claude:ai1@c', group: 'claude', five_hour: w(0, H) })]);
    expect(nm.excluded.noMeasure).toBe(1);
    expect(nm.total).toBe(0);
    expect(nm.state).toBe('unknown');
  });
});

describe('capacity v2 — estimates and stale blocks', () => {
  it('a 5h window whose reset already passed counts as full, flagged only where it moves "now"', () => {
    const g = group([
      // reset passed, weekly full → the estimate decides "now"
      acct({ name: 'claude:ai1@c', group: 'claude', five_hour: w(0.6, -60), seven_day: w(0, 3 * D) }),
      // reset passed, weekly binds → the estimate moves nothing
      acct({ name: 'claude:ai2@c', group: 'claude', five_hour: w(0.6, -60), seven_day: w(0.7, 3 * D) }),
    ]);
    expect(r1(g.now)).toBe(1.3);
    expect(g.estimated).toBe(1);
  });

  it('the per-account estimate flag and the estimate count use one rule', () => {
    const g = group([
      acct({ name: 'claude:ai1@c', group: 'claude', five_hour: w(0.6, -60), seven_day: w(0, 3 * D) }),
      acct({ name: 'claude:ai2@c', group: 'claude', five_hour: w(0.6, -60), seven_day: w(0.7, 3 * D) }),
      acct({
        name: 'claude:ai3@c',
        group: 'claude',
        blocked: '7d 100.0% > 99%',
        five_hour: w(0.6, -60),
        seven_day: w(1, 2 * D),
      }),
    ]);
    expect(g.units.filter((u) => u.estimated).length).toBe(g.estimated);
  });

  it('a weekly reset that already passed counts as full and is flagged', () => {
    const g = group([acct({ name: 'claude:ai1@c', group: 'claude', five_hour: w(0, H), seven_day: w(1, -60) })]);
    expect(g.week).toBe(1);
    expect(g.estimated).toBe(1);
  });

  it('a 5h-ceiling block whose 5h reset already passed is lifted at once', () => {
    const g = group([
      acct({
        name: 'claude:ai1@c',
        group: 'claude',
        blocked: '5h 100.0% > 99%',
        five_hour: w(1, -60),
        seven_day: w(0.4, D),
      }),
    ]);
    expect(r1(g.now)).toBe(0.6);
  });

  it('a cooldown of 120 s or less, or one already over, does not block', () => {
    const g = group([
      acct({
        name: 'claude:ai1@c',
        group: 'claude',
        status: 'cooldown',
        blocked: 'cooldown 6s',
        cooldown_until: NOW_S + 6,
        five_hour: w(0.2, H),
        seven_day: w(0.5, D),
      }),
      acct({
        name: 'claude:ai2@c',
        group: 'claude',
        status: 'cooldown',
        blocked: 'cooldown 5s',
        cooldown_until: NOW_S - 3,
        five_hour: w(0.2, H),
        seven_day: w(0.5, D),
      }),
    ]);
    expect(r1(g.now)).toBe(1);
    expect(g.units.every((u) => !u.blocks.cooldownUntil)).toBe(true);
  });
});

describe('capacity v2 — blockers tracked on their own', () => {
  it('a 5h ceiling blocks "now" but not the week; its 5h reset lifts it', () => {
    const g = group([
      acct({
        name: 'claude:ai1@c',
        group: 'claude',
        blocked: '5h 100.0% > 99%',
        five_hour: w(1, 2 * H),
        seven_day: w(0.4, 3 * D),
      }),
    ]);
    expect(g.now).toBe(0);
    expect(r1(g.week)).toBe(0.6);
    const e = g.events[0];
    expect(e).toMatchObject({ cause: '5h', account: 'ai1', at: NOW_S + 2 * H });
    expect(r1(e.dNow)).toBe(0.6);
    expect(e.dWeek).toBe(0);
  });

  it('a long cooldown blocks "now"; its release lifts "now" only and adds no quota (cause release)', () => {
    const g = group([
      acct({
        name: 'claude:ai1@c',
        group: 'claude',
        status: 'cooldown',
        blocked: 'cooldown 2h',
        cooldown_until: NOW_S + 2 * H,
        five_hour: w(0, 5 * H),
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
        five_hour: w(0, H),
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
        five_hour: w(0, H),
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
        five_hour: w(0, H),
        seven_day: w(1, 2 * D),
      }),
    ]);
    expect(g.events.map((e) => [e.cause, r1(e.dNow), r1(e.dWeek)])).toEqual([
      ['release', 0, 0],
      ['7d', 1, 1],
    ]);
  });

  it('a 5h reset and a weekly reset 30 s apart keep their own deltas', () => {
    // now 0.1 (5h binds: rem5 0.1, rem7 0.9) → 5h reset +0.8 → weekly reset +0.1
    const g = group([acct({ name: 'claude:ai1@c', group: 'claude', five_hour: w(0.9, H), seven_day: w(0.1, H + 30) })]);
    expect(g.events.map((e) => [e.cause, r1(e.dNow)])).toEqual([
      ['5h', 0.8],
      ['7d', 0.1],
    ]);
  });

  it('a model-scoped block ("fable …") holds the account until that window resets', () => {
    const g = group([
      acct({
        name: 'claude:ai1@c',
        group: 'claude',
        blocked: 'fable 99.0% > 98%',
        five_hour: w(0, H),
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
        five_hour: w(0, H),
        seven_day: w(0.2, 5 * D),
      }),
    ]);
    expect(unknown.excluded.held).toBe(1);
  });

  it('an unblocked account with no 5h measurement in a 5h group: week counts, "now" does not', () => {
    const g = group([
      acct({ name: 'claude:ai1@c', group: 'claude', five_hour: null, seven_day: w(0.5, D) }),
      acct({ name: 'claude:ai2@c', group: 'claude', five_hour: w(0, H), seven_day: w(0, D) }),
    ]);
    expect(r1(g.week)).toBe(1.5);
    expect(r1(g.now)).toBe(1);
    expect(g.unmeasured5h).toBe(1);
  });

  // trinity r3 (grok): a block with no known lift time is held, never a silent pass.
  it('a 5h ceiling with no 5h reset time is held (no lift known), not usable', () => {
    const g = group([
      acct({
        name: 'claude:ai1@c',
        group: 'claude',
        blocked: '5h 100.0% > 99%',
        five_hour: null,
        seven_day: w(0.4, D),
      }),
      acct({ name: 'claude:ai2@c', group: 'claude', five_hour: w(0, H), seven_day: w(0, D) }),
    ]);
    expect(g.excluded.held).toBe(1);
    expect(g.total).toBe(1);
  });

  it('a cooldown with no cooldown_until (status or reason) is held, with no return drawn', () => {
    const g = group([
      acct({ name: 'claude:ai1@c', group: 'claude', status: 'cooldown', five_hour: w(0.2, H), seven_day: w(0.2, D) }),
      acct({
        name: 'claude:ai2@c',
        group: 'claude',
        blocked: 'cooldown ?',
        five_hour: w(0.2, H),
        seven_day: w(0.2, D),
      }),
      acct({ name: 'claude:ai3@c', group: 'claude', five_hour: w(0, H), seven_day: w(0, D) }),
    ]);
    expect(g.excluded.held).toBe(2);
    expect(g.events.some((e) => e.account === 'ai1' || e.account === 'ai2')).toBe(false);
  });

  // trinity r4 (grok P3): a paused status with no reason string is held too.
  it('a paused status with no reason is held', () => {
    const g = group([
      acct({ name: 'claude:ai1@c', group: 'claude', status: 'paused', five_hour: w(0, H), seven_day: w(0, D) }),
      acct({ name: 'claude:ai2@c', group: 'claude', five_hour: w(0, H), seven_day: w(0, D) }),
    ]);
    expect(g.excluded.held).toBe(1);
    expect(g.units[0].held).toBe('paused');
  });

  it('held accounts never get a scheduled recovery', () => {
    const g = group([
      acct({ name: 'claude:ai1@c', group: 'claude', five_hour: w(0, H), seven_day: w(0, D) }),
      acct({ name: 'claude:ai2@c', group: 'claude', blocked: 'paused', five_hour: w(0.5, H), seven_day: w(0.5, D) }),
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
        five_hour: w(0, H),
        seven_day: w(0.2, 5 * D),
        scoped_limits: [{ scope_label: 'Fable', utilization: 0.99, resets_at: NOW_S - 60, resets_in_secs: 0 }],
      }),
    ]);
    expect(g.excluded.held).toBe(0);
    expect(r1(g.now)).toBe(0.8);
  });

  it('a block lifting within 5h does not prove a full 5h window: the account stays unmeasured', () => {
    const g = group([
      acct({
        name: 'claude:ai1@c',
        group: 'claude',
        status: 'cooldown',
        blocked: 'cooldown 3m',
        cooldown_until: NOW_S + 180,
        five_hour: null,
        seven_day: w(0.2, 3 * D),
      }),
      acct({ name: 'claude:ai2@c', group: 'claude', five_hour: w(0, H), seven_day: w(0, D) }),
    ]);
    const release = g.events.find((e) => e.account === 'ai1' && e.cause === 'release');
    expect(release?.dNow).toBe(0);
  });

  it('a block lifting after a whole idle 5h window counts that window full', () => {
    const g = group([
      acct({
        name: 'claude:ai1@c',
        group: 'claude',
        blocked: '7d 100.0% > 99%',
        five_hour: null,
        seven_day: w(1, 8 * H),
      }),
    ]);
    const reset = g.events.find((e) => e.cause === '7d');
    expect(r1(reset?.dNow ?? 0)).toBe(1);
  });

  it('a Claude pool with no 5h reading at all keeps its "now" measure', () => {
    const g = group([acct({ name: 'claude:ai1@c', group: 'claude', five_hour: null, seven_day: w(0.5, D) })]);
    expect(g.has5h).toBe(true);
    expect(g.now).toBe(0);
    expect(g.unmeasured5h).toBe(1);
    // PR #417 review (fable P3): unmeasured reads "unknown", never "empty" (소진)
    expect(g.state).toBe('unknown');
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
        five_hour: w(0, H),
        seven_day: w(0, D),
      }),
      acct({ name: 'claude:ai2@c', group: 'claude', five_hour: w(0, H), seven_day: w(0, D) }),
    ]);
    expect(g.excluded.held).toBe(1);
  });

  it('a passed 5h reset that lifts "now" from the stale reading to the weekly is an estimate', () => {
    // stale 5h said 0.1 left, weekly 0.5 left: the guess moves now 0.1 → 0.5
    const g = group([
      acct({ name: 'claude:ai1@c', group: 'claude', five_hour: w(0.9, -60), seven_day: w(0.5, 3 * D) }),
    ]);
    expect(r1(g.now)).toBe(0.5);
    expect(g.estimated).toBe(1);
  });

  it('an exhausted, unblocked account is not counted as usable', () => {
    const g = group([
      acct({ name: 'claude:ai1@c', group: 'claude', five_hour: w(0, H), seven_day: w(1, 2 * D) }),
      acct({ name: 'claude:ai2@c', group: 'claude', five_hour: w(0.5, H), seven_day: w(0, D) }),
    ]);
    expect(g.binding).toEqual({ fiveHour: 1, weekly: 0 });
  });

  it('no return is promised when the account lifts into an exhausted window with no known reset', () => {
    const g = group([
      acct({
        name: 'claude:ai1@c',
        group: 'claude',
        status: 'cooldown',
        blocked: 'cooldown 2h',
        cooldown_until: NOW_S + 2 * H,
        five_hour: w(0, H),
        seven_day: { utilization: 1, resets_at: 0, resets_in_secs: 0 },
      }),
    ]);
    expect(g.units[0].returnAt).toBeUndefined();
  });
});

describe('capacity v2 — the replayed forecast', () => {
  it('replays in time order: a weekly reset before a 5h reset lifts "now" to the 5h remainder first', () => {
    // rem5 0.2, rem7 0.1; weekly reset at +1h, 5h reset at +4h → now 0.1 → 0.2 → 1.0
    const g = group([acct({ name: 'claude:ai1@c', group: 'claude', five_hour: w(0.8, 4 * H), seven_day: w(0.9, H) })]);
    expect(r1(g.now)).toBe(0.1);
    expect(g.events.map((e) => [e.cause, r1(e.dNow)])).toEqual([
      ['7d', 0.1],
      ['5h', 0.8],
    ]);
  });

  it('keeps small gains (they are summed; only labels may hide them) and stays within 7 days', () => {
    const g = group([
      acct({ name: 'claude:ai1@c', group: 'claude', five_hour: w(0.01, H), seven_day: w(0, 3 * D) }),
      acct({ name: 'claude:ai2@c', group: 'claude', five_hour: w(0, H), seven_day: w(0.5, 9 * D) }),
    ]);
    const fiveH = g.events.find((e) => e.account === 'ai1');
    expect(fiveH?.dNow).toBeGreaterThan(0);
    expect(fiveH?.dNow).toBeLessThan(0.05);
    expect(g.events.some((e) => e.account === 'ai2' && e.cause === '7d')).toBe(false);
  });

  it('labels accounts by their short name and carries the tier on events', () => {
    const g = group([
      acct({ name: 'claude:ai1@corp.example', group: 'claude', five_hour: w(0.5, H), seven_day: w(0, D) }),
    ]);
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
          acct({ name: 'claude:ai1@c', group: 'claude', five_hour: w(0, H), seven_day: w(0, D) }),
          acct({ name: 'grok:key1', group: 'grok', type: 'grok', five_hour: w(0, H) }),
        ],
      } as LlmuxStatus,
      X20 as never,
      NOW_MS,
    );
    expect(view.groups.map((g) => g.group)).toEqual(['claude']);
  });

  it('state reads the primary measure: low under 20%, empty at 0 with capacity counted', () => {
    const low = group([acct({ name: 'claude:ai1@c', group: 'claude', five_hour: w(0.9, H), seven_day: w(0.2, D) })]);
    expect(low.state).toBe('low');
    const ok = group([acct({ name: 'claude:ai1@c', group: 'claude', five_hour: w(0.1, H), seven_day: w(0.2, D) })]);
    expect(ok.state).toBe('ok');
  });

  it('reports the oldest llmux measurement of the counted accounts', () => {
    const g = group([
      acct({
        name: 'claude:ai1@c',
        group: 'claude',
        five_hour: w(0, H),
        seven_day: w(0, D),
        last_refresh_ms: (NOW_S - 3 * H) * 1000,
      }),
      acct({
        name: 'claude:ai2@c',
        group: 'claude',
        five_hour: w(0, H),
        seven_day: w(0, D),
        last_refresh_ms: (NOW_S - H) * 1000,
      }),
    ]);
    expect(g.oldestRefreshAt).toBe(NOW_S - 3 * H);
  });
});
