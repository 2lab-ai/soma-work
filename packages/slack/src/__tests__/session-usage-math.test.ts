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
import {
  adoptSdkSessionId,
  applyPostCompactOccupancy,
  sanitizeSessionUsage,
  selectCurrentContextTokens,
  settleFoldedLiveUsage,
  toTurnUsage,
} from '../session-usage-math';

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

  it('one model whose total went down restarts only that model', () => {
    const t1 = toTurnUsage(
      resultUsage({ opus: counters(10_000, 1000, 0, 0, 10), astra: counters(3000, 300, 0, 0, 3) }),
      undefined,
      'sdk-A',
    );
    const t2 = toTurnUsage(
      resultUsage({ opus: counters(11_000, 1100, 0, 0, 11), astra: counters(100, 10, 0, 0, 0.1) }),
      t1.baseline,
      'sdk-A',
    );

    // opus counts its growth (1), astra restarted and counts in full (0.1) — opus is NOT re-counted.
    expect(t2.turn.modelBreakdown?.opus.costUsd).toBeCloseTo(1);
    expect(t2.turn.modelBreakdown?.astra.costUsd).toBeCloseTo(0.1);
    expect(t2.turn.totalCostUsd).toBeCloseTo(1.1);
    expect(t2.baseline?.models.astra.costUsd).toBeCloseTo(0.1);
    expect(t2.baseline?.models.opus.costUsd).toBeCloseTo(11);
  });

  // review #472 r2: an llmux model's cost switched from the SDK's default rate
  // to the host table mid-session (deploy). Its running total grew in tokens
  // but its cost may read lower than the saved baseline — that is a repricing,
  // not a restart: counting the model in full again would double its tokens.
  it('a model whose cost went down while every token count grew is repriced, not restarted', () => {
    const t1 = toTurnUsage(
      resultUsage({ opus: counters(10_000, 1000, 0, 0, 10), grok: counters(2000, 100, 50_000, 0, 20) }),
      undefined,
      'sdk-A',
    );
    const t2 = toTurnUsage(
      resultUsage({ opus: counters(11_000, 1100, 0, 0, 11), grok: counters(2500, 120, 60_000, 0, 15) }),
      t1.baseline,
      'sdk-A',
    );

    expect(t2.turn.modelBreakdown?.grok.inputTokens).toBe(500);
    expect(t2.turn.modelBreakdown?.grok.cacheReadInputTokens).toBe(10_000);
    expect(t2.turn.modelBreakdown?.grok.costUsd).toBe(0);
    expect(t2.turn.inputTokens).toBe(1500);
    expect(t2.baseline?.models.grok.costUsd).toBe(15);
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

describe('settleFoldedLiveUsage', () => {
  const turn = (input: number, cost: number, breakdown = true) => ({
    inputTokens: input,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalCostUsd: cost,
    ...(breakdown
      ? {
          modelBreakdown: {
            opus: {
              inputTokens: input,
              outputTokens: 0,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              costUsd: cost,
            },
          },
        }
      : {}),
  });
  const folded = { inputTokens: 200, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: 0.2 };

  it('takes the turn spend minus what was already folded, and settles the fold', () => {
    const { spend, folded: rest } = settleFoldedLiveUsage(turn(300, 0.3), folded);
    expect(spend.inputTokens).toBe(100);
    expect(spend.totalCostUsd).toBeCloseTo(0.1);
    expect(rest).toBeUndefined();
  });

  it('takes back what the fold over-counted when the result carries less (a signed correction; review r3)', () => {
    // The fold was an estimate at the session model rate; the result is the authority.
    const { spend, folded: rest } = settleFoldedLiveUsage(turn(50, 0.05), folded);
    expect(spend.inputTokens).toBe(-150);
    expect(spend.totalCostUsd).toBeCloseTo(-0.15);
    expect(rest).toBeUndefined();
  });

  it('keeps the fold across a zero-spend (crash) result', () => {
    const { spend, folded: rest } = settleFoldedLiveUsage(turn(0, 0), folded);
    expect(spend.totalCostUsd).toBe(0);
    expect(rest).toBe(folded);
  });

  it('keeps the fold across a zero result with no breakdown (empty modelUsage)', () => {
    const { folded: rest } = settleFoldedLiveUsage(turn(0, 0, false), folded);
    expect(rest).toBe(folded);
  });

  it('per-turn usage (no breakdown) is taken whole and drops the fold', () => {
    const { spend, folded: rest } = settleFoldedLiveUsage(turn(300, 0.3, false), folded);
    expect(spend.inputTokens).toBe(300);
    expect(rest).toBeUndefined();
  });
});

describe('adoptSdkSessionId', () => {
  it('a new SDK session id seeds an empty baseline for it', () => {
    const session: { sessionId?: string; sdkUsageBaseline?: any } = {
      sessionId: undefined,
      sdkUsageBaseline: {
        sdkSessionId: 'old',
        models: {
          opus: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 9 },
        },
      },
    };
    adoptSdkSessionId(session, 'new');
    expect(session).toEqual({ sessionId: 'new', sdkUsageBaseline: { sdkSessionId: 'new', models: {} } });
  });

  it('a resumed id leaves the baseline alone — including a missing one (pre-baseline session)', () => {
    const legacy: { sessionId?: string; sdkUsageBaseline?: any } = { sessionId: 'A' };
    adoptSdkSessionId(legacy, 'A');
    expect(legacy.sdkUsageBaseline).toBeUndefined();

    const baseline = { sdkSessionId: 'A', models: {} };
    const resumed = { sessionId: 'A', sdkUsageBaseline: baseline };
    adoptSdkSessionId(resumed, 'A');
    expect(resumed.sdkUsageBaseline).toBe(baseline);
  });
});

describe('creditTaskSpend — a fold priced at the parent rate is corrected by the result (review r2)', () => {
  it('a folded estimate above the authoritative growth is taken back, never kept', async () => {
    const { creditTaskSpend } = await import('../session-usage-math');
    const holder: any = {
      sessionId: 'sdk-A',
      taskUsage: {
        inputTokens: 1000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        costUsd: 25,
        pendingFold: {
          inputTokens: 1000,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
          costUsd: 25,
          sdkSessionId: 'sdk-A',
        },
      },
    };
    creditTaskSpend(holder, {
      inputTokens: 1000,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalCostUsd: 6,
      modelBreakdown: {
        'claude-haiku-4-5': {
          inputTokens: 1000,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUsd: 6,
        },
      },
    });
    expect(holder.taskUsage.inputTokens).toBe(1000);
    expect(holder.taskUsage.costUsd).toBeCloseTo(6);
    expect(holder.taskUsage.pendingFold).toBeUndefined();
  });
});

/**
 * ssot-task: T2 — a saved occupancy above its window is not a reading
 * (a dev deployment, 2026-10-30: sessions.json carried `current*` = the session's
 * whole running total, 187,891,067 against a 1M window). Restoring it kept
 * the dashboard at `187.9M/1M` and re-fired the compact announcement after
 * every restart until the next real reading.
 */
describe('sanitizeSessionUsage — occupancy above the window', () => {
  const totals = {
    totalInputTokens: 3_868_187,
    totalOutputTokens: 426_418,
    totalCacheReadTokens: 172_893_178,
    totalCacheCreateTokens: 10_703_284,
    totalCostUsd: 134.57,
  };

  it('drops the impossible occupancy and keeps the billing totals', () => {
    const restored = sanitizeSessionUsage(
      {
        currentInputTokens: 3_868_187,
        currentOutputTokens: 426_418,
        currentCacheReadTokens: 172_893_178,
        currentCacheCreateTokens: 10_703_284,
        contextWindow: 1_000_000,
        ...totals,
        lastUpdated: 1793342535410,
      },
      1_000_000,
    );
    expect(restored).toBeDefined();
    const u = restored!;
    expect(u.currentInputTokens + u.currentOutputTokens + u.currentCacheReadTokens + u.currentCacheCreateTokens).toBe(
      0,
    );
    expect(u.totalInputTokens).toBe(totals.totalInputTokens);
    expect(u.totalCacheReadTokens).toBe(totals.totalCacheReadTokens);
    expect(u.totalCostUsd).toBe(totals.totalCostUsd);
    expect(u.contextWindow).toBe(1_000_000);
  });

  it('does not judge against a fallback window — a guessed window may be the base 200k of a 1M session', () => {
    const restored = sanitizeSessionUsage(
      {
        currentInputTokens: 32_960,
        currentOutputTokens: 1_000,
        currentCacheReadTokens: 354_320,
        currentCacheCreateTokens: 0,
        contextWindow: 0,
        ...totals,
        lastUpdated: 1,
      },
      200_000,
    );
    expect(restored!.contextWindow).toBe(200_000);
    expect(restored!.currentCacheReadTokens).toBe(354_320);
  });

  it('keeps an occupancy within the window as saved', () => {
    const restored = sanitizeSessionUsage(
      {
        currentInputTokens: 2_000,
        currentOutputTokens: 1_000,
        currentCacheReadTokens: 400_000,
        currentCacheCreateTokens: 7_000,
        contextWindow: 1_000_000,
        ...totals,
        lastUpdated: 1,
      },
      1_000_000,
    );
    expect(restored!.currentCacheReadTokens).toBe(400_000);
    expect(restored!.currentInputTokens).toBe(2_000);
  });
});
