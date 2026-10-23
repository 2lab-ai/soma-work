/**
 * RED regression tests — context-window current-token selection (Issue: model
 * switch / llmux(codex) sessions showing `0/372k (100% available)`).
 *
 * Root cause (proven from dev logs 2026-07-13, `usageSource: "per-turn"` with
 * `currentContext: 0`): llmux/codex turns emit assistant messages whose
 * `usage` is ALL-ZERO. The mapper forwarded them as `lastTurn* = 0`, and the
 * executor treated "per-turn fields are defined" as "per-turn data is valid",
 * overwriting the current context with zeros. Result: `/context` shows an
 * empty window and the GPT fixed-token auto-compact trigger (340k) never
 * fires.
 *
 * The fix is a single pure decision function used by the executor:
 * per-turn values are only trusted when they carry information (sum > 0);
 * otherwise fall back to the billing aggregate (overstates in multi-call
 * agent loops, but is strictly safer than reporting an empty window).
 */

import { describe, expect, it } from 'vitest';
import { applyPostCompactOccupancy, selectCurrentContextTokens, toTurnUsage } from '../session-usage-math';

describe('selectCurrentContextTokens', () => {
  const aggregates = {
    inputTokens: 133_300,
    outputTokens: 381,
    cacheReadInputTokens: 2_000,
    cacheCreationInputTokens: 1_000,
    totalCostUsd: 2.6688,
  };

  it('uses per-turn values when they are present and non-zero', () => {
    const selected = selectCurrentContextTokens({
      ...aggregates,
      lastTurnInputTokens: 120_000,
      lastTurnOutputTokens: 500,
      lastTurnCacheReadTokens: 3_000,
      lastTurnCacheCreateTokens: 200,
    });

    expect(selected).toEqual({
      inputTokens: 120_000,
      outputTokens: 500,
      cacheReadTokens: 3_000,
      cacheCreateTokens: 200,
      source: 'per-turn',
    });
  });

  it('falls back to aggregates when per-turn fields are defined but ALL ZERO (llmux/codex)', () => {
    const selected = selectCurrentContextTokens({
      ...aggregates,
      lastTurnInputTokens: 0,
      lastTurnOutputTokens: 0,
      lastTurnCacheReadTokens: 0,
      lastTurnCacheCreateTokens: 0,
    });

    expect(selected).toEqual({
      inputTokens: 133_300,
      outputTokens: 381,
      cacheReadTokens: 2_000,
      cacheCreateTokens: 1_000,
      source: 'aggregate-fallback',
    });
  });

  it('falls back to aggregates when per-turn fields are missing', () => {
    const selected = selectCurrentContextTokens({ ...aggregates });

    expect(selected).toEqual({
      inputTokens: 133_300,
      outputTokens: 381,
      cacheReadTokens: 2_000,
      cacheCreateTokens: 1_000,
      source: 'aggregate-fallback',
    });
  });

  it('keeps per-turn when only output is non-zero (partial but informative)', () => {
    const selected = selectCurrentContextTokens({
      ...aggregates,
      lastTurnInputTokens: 0,
      lastTurnOutputTokens: 700,
      lastTurnCacheReadTokens: 0,
      lastTurnCacheCreateTokens: 0,
    });

    expect(selected.source).toBe('per-turn');
    expect(selected.outputTokens).toBe(700);
  });
});

/**
 * Issue #196 — `compact_boundary.post_tokens` is the only authoritative
 * statement of post-compaction window occupancy. It must be adoptable into
 * the same `current*` counters every context surface reads, and it must never
 * be invented when the SDK stays silent.
 *
 * ssot-task: T2.1
 */
describe('applyPostCompactOccupancy', () => {
  const freshOccupancy = () => ({
    currentInputTokens: 640_000,
    currentOutputTokens: 5_000,
    currentCacheReadTokens: 25_000,
    currentCacheCreateTokens: 4_800,
    lastUpdated: 0,
  });

  it('replaces the whole occupancy with post_tokens', () => {
    const usage = freshOccupancy();

    expect(applyPostCompactOccupancy(usage, 30_000)).toBe(true);

    const occupied =
      usage.currentInputTokens +
      usage.currentOutputTokens +
      usage.currentCacheReadTokens +
      usage.currentCacheCreateTokens;
    expect(occupied).toBe(30_000);
    // Occupancy encoding: post_tokens carries no per-bucket breakdown, so the
    // other three are cleared rather than left holding pre-compact residue.
    expect(usage.currentCacheReadTokens).toBe(0);
    expect(usage.lastUpdated).toBeGreaterThan(0);
  });

  it('accepts a fully compacted-away window (0 tokens)', () => {
    const usage = freshOccupancy();
    expect(applyPostCompactOccupancy(usage, 0)).toBe(true);
    expect(usage.currentInputTokens).toBe(0);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a negative count', -1],
    ['NaN', Number.NaN],
    ['a string', '30000'],
  ])('refuses to invent a number from %s', (_label, input) => {
    const usage = freshOccupancy();
    expect(applyPostCompactOccupancy(usage, input)).toBe(false);
    // Untouched — the pre-existing accounting stands rather than a guess.
    expect(usage.currentInputTokens).toBe(640_000);
    expect(usage.lastUpdated).toBe(0);
  });
});

/**
 * RED — the SDK result's `modelUsage` is a RUNNING TOTAL for the SDK session
 * (sdk.d.ts: "cumulative across turns … a resumed session continues from the
 * totals its transcript saved … read the latest result rather than summing
 * across results"). soma-work resumes the same SDK session every turn, so
 * adding each result straight into the session/goal/metrics totals re-counts
 * every earlier turn (dev 2026-10-24, conversation 4a22fff8: true total
 * $213.45, summed $2,500+). `toTurnUsage` turns the running total into the
 * turn's own spend against the last total seen for that SDK session.
 */
describe('toTurnUsage', () => {
  const counters = (
    inputTokens: number,
    outputTokens: number,
    cacheRead: number,
    cacheCreate: number,
    costUsd: number,
  ) => ({
    inputTokens,
    outputTokens,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreate,
    costUsd,
  });
  const resultUsage = (breakdown: Record<string, ReturnType<typeof counters>>) => {
    const all = Object.values(breakdown);
    const sum = (k: keyof ReturnType<typeof counters>) => all.reduce((a, c) => a + c[k], 0);
    return {
      inputTokens: sum('inputTokens'),
      outputTokens: sum('outputTokens'),
      cacheReadInputTokens: sum('cacheReadInputTokens'),
      cacheCreationInputTokens: sum('cacheCreationInputTokens'),
      totalCostUsd: sum('costUsd'),
      costSource: 'sdk' as const,
      modelName: 'claude-opus-5-5[1m]',
      lastTurnInputTokens: 7,
      modelBreakdown: breakdown,
    };
  };

  it('first result of an SDK session counts in full and becomes the baseline', () => {
    const first = resultUsage({ opus: counters(1000, 100, 10_000, 500, 1) });
    const { turn, baseline } = toTurnUsage(first, undefined, 'sdk-A');

    expect(turn.totalCostUsd).toBeCloseTo(1);
    expect(turn.inputTokens).toBe(1000);
    expect(baseline).toEqual({ sdkSessionId: 'sdk-A', models: { opus: first.modelBreakdown.opus } });
  });

  it('a later result of the same SDK session counts only what grew since the baseline', () => {
    const t1 = toTurnUsage(resultUsage({ opus: counters(1000, 100, 10_000, 500, 1) }), undefined, 'sdk-A');
    const t2 = toTurnUsage(
      resultUsage({ opus: counters(1500, 160, 25_000, 700, 1.6), astra: counters(300, 20, 0, 0, 0.2) }),
      t1.baseline,
      'sdk-A',
    );

    expect(t2.turn.totalCostUsd).toBeCloseTo(0.8);
    expect(t2.turn.inputTokens).toBe(800);
    expect(t2.turn.outputTokens).toBe(80);
    expect(t2.turn.cacheReadInputTokens).toBe(15_000);
    expect(t2.turn.cacheCreationInputTokens).toBe(200);
    expect(t2.turn.modelBreakdown?.opus.costUsd).toBeCloseTo(0.6);
    expect(t2.turn.modelBreakdown?.astra.costUsd).toBeCloseTo(0.2);
    // Per-turn context fields and identity are untouched.
    expect(t2.turn.lastTurnInputTokens).toBe(7);
    expect(t2.turn.modelName).toBe('claude-opus-5-5[1m]');
    expect(t2.turn.costSource).toBe('sdk');
  });

  it('a model that did not spend this turn drops out of the turn breakdown but stays in the baseline', () => {
    const t1 = toTurnUsage(
      resultUsage({ opus: counters(1000, 100, 0, 0, 1), astra: counters(300, 20, 0, 0, 0.2) }),
      undefined,
      'sdk-A',
    );
    const t2 = toTurnUsage(
      resultUsage({ opus: counters(1200, 150, 0, 0, 1.3), astra: counters(300, 20, 0, 0, 0.2) }),
      t1.baseline,
      'sdk-A',
    );

    expect(Object.keys(t2.turn.modelBreakdown ?? {})).toEqual(['opus']);
    expect(t2.turn.totalCostUsd).toBeCloseTo(0.3);
    expect(t2.baseline?.models.astra.costUsd).toBeCloseTo(0.2);
  });

  it('a different SDK session id starts from zero (a new conversation after /new or reset)', () => {
    const t1 = toTurnUsage(resultUsage({ opus: counters(1000, 100, 0, 0, 5) }), undefined, 'sdk-A');
    const t2 = toTurnUsage(resultUsage({ opus: counters(2000, 200, 0, 0, 6) }), t1.baseline, 'sdk-B');

    expect(t2.turn.totalCostUsd).toBeCloseTo(6);
    expect(t2.baseline?.sdkSessionId).toBe('sdk-B');
  });

  it('a running total that went DOWN (mid-session /clear) restarts the baseline from this result', () => {
    const t1 = toTurnUsage(
      resultUsage({ opus: counters(9000, 900, 0, 0, 9), astra: counters(500, 50, 0, 0, 0.5) }),
      undefined,
      'sdk-A',
    );
    const t2 = toTurnUsage(resultUsage({ opus: counters(100, 10, 0, 0, 0.1) }), t1.baseline, 'sdk-A');

    expect(t2.turn.totalCostUsd).toBeCloseTo(0.1);
    expect(t2.baseline).toEqual({ sdkSessionId: 'sdk-A', models: { opus: counters(100, 10, 0, 0, 0.1) } });
  });

  it('a zeroed result (crash/startup error) counts nothing and keeps the baseline', () => {
    const t1 = toTurnUsage(resultUsage({ opus: counters(1000, 100, 0, 0, 1) }), undefined, 'sdk-A');
    const zeroed = toTurnUsage(resultUsage({ opus: counters(0, 0, 0, 0, 0) }), t1.baseline, 'sdk-A');
    const t3 = toTurnUsage(resultUsage({ opus: counters(1100, 110, 0, 0, 1.1) }), zeroed.baseline, 'sdk-A');

    expect(zeroed.turn.totalCostUsd).toBe(0);
    expect(zeroed.baseline).toEqual(t1.baseline);
    expect(t3.turn.totalCostUsd).toBeCloseTo(0.1);
  });

  it('usage without a per-model breakdown (per-turn shapes, ACP) passes through unchanged', () => {
    const perTurn = {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalCostUsd: 0.01,
    };
    const baseline = { sdkSessionId: 'sdk-A', models: { opus: counters(1, 1, 0, 0, 1) } };
    const { turn, baseline: next } = toTurnUsage(perTurn, baseline, 'sdk-A');

    expect(turn).toBe(perTurn);
    expect(next).toBe(baseline);
  });
});
