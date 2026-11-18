/**
 * `auth` infographic model — the numbers behind the two pictures.
 *
 * Summary picture answers two questions at a glance:
 *   1. How much is left right now (account-equivalents, the capacity view's unit)?
 *   2. When does more come back — the next step, the next 24 h, each day of the week ahead,
 *      and when the pool is full again (if nothing more is used)?
 * The account report lists every account with its own state, windows and reset time.
 */
import { describe, expect, it } from 'vitest';
import type { LlmuxAccount, LlmuxStatus } from '../../../auth/llmux-client';
import { buildCapacityView } from '../../../conversation/capacity-view';
import { buildAccountReport, buildAuthInfographic, formatKstMoment } from '../infographic-model';

// 2027-01-15 08:00 UTC = Friday 17:00 KST.
const NOW_S = 1_800_000_000;
const NOW_MS = NOW_S * 1000;
const H = 3600;
const D = 86400;
const w = (utilization: number, inSecs: number) => ({ utilization, resets_at: NOW_S + inSecs, resets_in_secs: inSecs });

function acct(over: Partial<LlmuxAccount> & { name: string }): LlmuxAccount {
  return { type: 'oauth', status: 'ok', order: 1, blocked: null, seven_day: null, ...over };
}

function build(accounts: LlmuxAccount[], extra: Partial<LlmuxStatus> = {}) {
  const status = { current: null, version: 'llmux 0.2.26', accounts, ...extra } as LlmuxStatus;
  const view = buildCapacityView(status, {}, NOW_MS);
  return { status, view, info: buildAuthInfographic(status, view, NOW_MS) };
}

const r1 = (x: number) => Math.round(x * 10) / 10;

describe('formatKstMoment', () => {
  it('names today and tomorrow, otherwise the date and weekday, always in KST', () => {
    expect(formatKstMoment(NOW_S + 4 * H, NOW_S)).toBe('오늘 21:00');
    expect(formatKstMoment(NOW_S + 13 * H, NOW_S)).toBe('내일 06:00');
    expect(formatKstMoment(NOW_S + 2 * D, NOW_S)).toBe('1/17 (일) 17:00');
  });
});

describe('buildAuthInfographic — how much is left', () => {
  it('splits the pool into usable now, held back by a block, and used', () => {
    const { info } = build([
      acct({ name: 'claude:ai1@c', group: 'claude', seven_day: w(0.25, 2 * D) }),
      acct({ name: 'claude:ai2@c', group: 'claude', seven_day: w(1, 1 * D), blocked: '7d 100.0% > 99%' }),
      acct({
        name: 'claude:ai3@c',
        group: 'claude',
        seven_day: w(0.5, 3 * D),
        fable_weekly: { ...w(0.99, 5 * H), scope_label: 'Fable' },
        blocked: 'fable 99.0% > 98%',
      }),
      acct({ name: 'claude:ai4@c', group: 'claude', seven_day: w(0.1, 4 * D), blocked: 'paused' }),
    ]);
    const [claude] = info.groups;
    expect(claude.label).toBe('Claude');
    expect(claude.accountCount).toBe(4);
    expect(claude.total).toBe(3); // ai4 is held: out of the totals
    expect(r1(claude.now)).toBe(0.8); // only ai1 runs now
    expect(r1(claude.waiting)).toBe(0.5); // ai3 has weekly quota behind the Fable ceiling
    expect(claude.used).toBeCloseTo(1.75, 6); // 3 − (0.75 + 0 + 0.5)
    expect(claude.counts).toEqual({ usable: 1, drained: 2, held: 1, noMeasure: 0, unknownTier: 0 });
  });

  it('sums a model-scoped window (Fable) over the accounts that can run, capped by their weekly remaining', () => {
    const { info } = build([
      acct({
        name: 'claude:ai1@c',
        group: 'claude',
        seven_day: w(0.2, 2 * D),
        fable_weekly: { ...w(0.5, 2 * D), scope_label: 'Fable' },
      }),
      acct({
        name: 'claude:ai2@c',
        group: 'claude',
        seven_day: w(0.9, 2 * D),
        fable_weekly: { ...w(0.1, 2 * D), scope_label: 'Fable' },
      }),
    ]);
    const [claude] = info.groups;
    expect(claude.scoped).toHaveLength(1);
    expect(claude.scoped[0].label).toBe('Fable');
    expect(r1(claude.scoped[0].now)).toBe(0.6); // min(.8,.5) + min(.1,.9)
    expect(claude.scoped[0].measured).toBe(2);
  });

  it('lists providers without plan windows apart, with their account count', () => {
    const { info } = build([
      acct({ name: 'claude:ai1@c', group: 'claude', seven_day: w(0.2, 2 * D) }),
      acct({ name: 'grok:ai@c', group: 'grok', type: 'grok' }),
      acct({ name: 'grok:z@c', group: 'grok', type: 'grok' }),
    ]);
    expect(info.groups.map((g) => g.group)).toEqual(['claude']);
    expect(info.others).toEqual([{ label: 'Grok', accounts: 2 }]);
  });
});

describe('buildAuthInfographic — when more comes back', () => {
  const accounts = [
    acct({ name: 'claude:ai1@c', group: 'claude', seven_day: w(0.5, 2 * D) }), // +0.5 in 2 days
    acct({ name: 'claude:ai2@c', group: 'claude', seven_day: w(1, 13 * H), blocked: '7d 100.0% > 99%' }), // +1 tomorrow 06:00
    acct({ name: 'claude:ai3@c', group: 'claude', seven_day: w(1, 13 * H), blocked: '7d 100.0% > 99%' }), // +1 same instant
    acct({ name: 'claude:ai4@c', group: 'claude', seven_day: w(0.2, 5 * D) }), // +0.2 in 5 days
  ];

  it('steps the usable amount up at every event, starting from now', () => {
    const [claude] = build(accounts).info.groups;
    expect(claude.points[0]).toEqual({ at: NOW_S, value: claude.now });
    // ai2 and ai3 come back at the same instant: one step of +2.
    expect(claude.points.map((p) => r1(p.value))).toEqual([1.3, 3.3, 3.8, 4]);
    expect(claude.points[claude.points.length - 1]?.at).toBe(NOW_S + 5 * D);
  });

  it('names the next recovery, merging events at the same instant', () => {
    const [claude] = build(accounts).info.groups;
    expect(claude.next).toEqual({ at: NOW_S + 13 * H, gain: 2, accounts: ['ai2', 'ai3'] });
    expect(r1(claude.within24h)).toBe(2);
    expect(claude.fullAt).toBe(NOW_S + 5 * D);
  });

  it('buckets the gains by KST day: today first, then one bucket per day, adding up to the whole return', () => {
    const [claude] = build(accounts).info.groups;
    expect(claude.days[0]).toMatchObject({ label: '오늘', start: NOW_S, gain: 0 });
    expect(claude.days[1]).toMatchObject({ label: '토 16', gain: 2 });
    expect(claude.days[2]).toMatchObject({ label: '일 17', gain: 0.5 });
    expect(claude.days.length).toBe(8); // today's remainder + 7 days, the last cut at now + 7 d
    expect(claude.days[claude.days.length - 1]?.end).toBe(NOW_S + 7 * D);
    expect(r1(claude.days.reduce((t, d) => t + d.gain, 0))).toBe(r1(claude.total - claude.now));
  });

  it('has no next step and no full time when the pool is already full', () => {
    const [claude] = build([acct({ name: 'claude:ai1@c', group: 'claude', seven_day: w(0, 2 * D) })]).info.groups;
    expect(claude.next).toBeUndefined();
    expect(claude.fullAt).toBeUndefined();
    expect(claude.points).toHaveLength(1);
  });

  it('reports the oldest measurement over the counted accounts', () => {
    const { info } = build([
      acct({ name: 'claude:ai1@c', group: 'claude', seven_day: w(0.1, D), last_refresh_ms: (NOW_S - 2 * H) * 1000 }),
      acct({ name: 'claude:ai2@c', group: 'claude', seven_day: w(0.1, D), last_refresh_ms: (NOW_S - 9 * D) * 1000 }),
    ]);
    expect(info.groups[0].oldestRefreshAt).toBe(NOW_S - 9 * D);
  });
});

describe('buildAccountReport — every account, one row', () => {
  it('orders rows usable → blocked → drained → held, and marks the current account', () => {
    const { status, view } = build(
      [
        acct({ name: 'claude:ai1@c', group: 'claude', seven_day: w(0.6, 2 * D) }),
        acct({ name: 'claude:ai2@c', group: 'claude', seven_day: w(1, 1 * D), blocked: '7d 100.0% > 99%' }),
        acct({ name: 'claude:ai3@c', group: 'claude', seven_day: w(0.1, 3 * D) }),
        acct({ name: 'claude:ai4@c', group: 'claude', seven_day: w(0.1, 4 * D), blocked: 'paused' }),
        acct({
          name: 'claude:ai5@c',
          group: 'claude',
          seven_day: w(0.5, 3 * D),
          fable_weekly: { ...w(0.99, 5 * H), scope_label: 'Fable' },
          blocked: 'fable 99.0% > 98%',
          in_flight: 2,
        }),
      ],
      { current_by_group: { claude: 'claude:ai3@c' } },
    );
    const report = buildAccountReport(status, view, NOW_MS);
    const [claude] = report.groups;
    expect(claude.rows.map((r) => r.name)).toEqual(['ai3', 'ai1', 'ai5', 'ai2', 'ai4']);
    expect(claude.rows.map((r) => r.state)).toEqual(['usable', 'usable', 'blocked', 'drained', 'held']);
    expect(claude.rows[0].current).toBe(true);
    expect(claude.rows[0].plan).toBe('x20*'); // untiered Claude counted as Max x20 — flagged
    const ai5 = claude.rows[2];
    expect(ai5.returnAt).toBe(NOW_S + 5 * H);
    expect(ai5.scoped).toEqual({ label: 'Fable', remaining: expect.closeTo(0.01, 6) });
    expect(ai5.inFlight).toBe(2);
    expect(claude.rows[3].resetAt).toBe(NOW_S + D);
    expect(claude.rows[4].stateLabel).toBe('일시정지');
  });

  it('reads providers without plan windows straight from llmux', () => {
    const { status, view } = build([
      acct({ name: 'grok:ai@c', group: 'grok', type: 'grok', seven_day: w(0.3, 2 * D) }),
      acct({ name: 'grok:z@c', group: 'grok', type: 'grok', blocked: 'paused' }),
    ]);
    const [grok] = buildAccountReport(status, view, NOW_MS).groups;
    expect(grok.label).toBe('Grok');
    expect(grok.rows.map((r) => [r.name, r.state])).toEqual([
      ['ai', 'usable'],
      ['z', 'held'],
    ]);
    expect(grok.rows[0].week).toBeCloseTo(0.7, 6);
    expect(grok.rows[0].plan).toBeUndefined();
  });

  it('keeps a blocked account with an unknown plan apart from a drained one', () => {
    // Codex accounts without a configured or reported plan stay out of the totals (unknownTier).
    const { status, view } = build([
      acct({ name: 'codex:x1@c', group: 'codex', type: 'codex', seven_day: w(0.5, 3 * D) }),
      acct({
        name: 'codex:x2@c',
        group: 'codex',
        type: 'codex',
        seven_day: w(0.5, 3 * D),
        blocked: 'cooldown',
        cooldown_until: NOW_S + 2 * H,
      }),
      acct({ name: 'codex:x3@c', group: 'codex', type: 'codex', seven_day: w(1, D), blocked: '7d 100.0% > 99%' }),
    ]);
    const [codex] = buildAccountReport(status, view, NOW_MS).groups;
    expect(codex.rows.map((r) => [r.name, r.state, r.stateLabel])).toEqual([
      ['x1', 'usable', '사용 가능 (플랜 미상)'],
      ['x2', 'blocked', '쿨다운'],
      ['x3', 'drained', '주간 소진'],
    ]);
    expect(codex.rows[1].returnAt).toBe(NOW_S + 2 * H);
  });

  it('holds a provider account paused by status alone (no blocked reason)', () => {
    const { status, view } = build([
      acct({ name: 'grok:ai@c', group: 'grok', type: 'grok', seven_day: w(0.3, 2 * D) }),
      acct({ name: 'grok:z@c', group: 'grok', type: 'grok', status: 'paused', seven_day: w(0.1, 2 * D) }),
    ]);
    const [grok] = buildAccountReport(status, view, NOW_MS).groups;
    expect(grok.rows.map((r) => [r.name, r.state, r.stateLabel])).toEqual([
      ['ai', 'usable', '사용 가능'],
      ['z', 'held', '일시정지'],
    ]);
  });
});
