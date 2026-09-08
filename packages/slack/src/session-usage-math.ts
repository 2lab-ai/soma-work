/**
 * Pure decision math for session usage tracking — extracted from
 * `pipeline/stream-executor.ts` so the per-turn vs aggregate selection rule is
 * unit-testable against the REAL production code path.
 *
 * Background: the "current context" display must reflect the LAST API call's
 * token counts (per-turn), not the billing aggregate summed across every call
 * of the agent loop. But llmux/codex-backed models (gpt-5.6 family) attach
 * all-zero `usage` objects to assistant messages, so "per-turn fields are
 * defined" is NOT the same as "per-turn data is valid". Trusting a zeroed
 * per-turn value blanks the context display (`0/372k (100% available)`) and
 * silently disables the fixed-token auto-compact trigger for those models.
 */

/** Minimal structural slice of `UsageData` this module needs. */
export interface CurrentContextTokensInput {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  lastTurnInputTokens?: number;
  lastTurnOutputTokens?: number;
  lastTurnCacheReadTokens?: number;
  lastTurnCacheCreateTokens?: number;
}

export interface CurrentContextTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  source: 'per-turn' | 'aggregate-fallback';
}

/**
 * Select the token set representing the CURRENT context-window occupancy.
 *
 * Per-turn values win only when they are present AND carry information
 * (sum > 0). All-zero per-turn usage — the llmux/codex signature — falls back
 * to the billing aggregate. The aggregate overstates occupancy on multi-call
 * agent loops (it sums every round-trip), but overstating is strictly safer
 * than reporting an empty window: the display clamps at 100% used and the
 * auto-compact trigger fires early instead of never.
 */
export function selectCurrentContextTokens(usage: CurrentContextTokensInput): CurrentContextTokens {
  const hasPerTurn = usage.lastTurnInputTokens !== undefined;
  if (hasPerTurn) {
    const input = usage.lastTurnInputTokens ?? 0;
    const output = usage.lastTurnOutputTokens ?? 0;
    const cacheRead = usage.lastTurnCacheReadTokens ?? 0;
    const cacheCreate = usage.lastTurnCacheCreateTokens ?? 0;
    if (input + output + cacheRead + cacheCreate > 0) {
      return {
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheCreateTokens: cacheCreate,
        source: 'per-turn',
      };
    }
  }
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadInputTokens,
    cacheCreateTokens: usage.cacheCreationInputTokens,
    source: 'aggregate-fallback',
  };
}

/** The four live context-occupancy counters, as a mutable structural slice. */
export interface MutableContextOccupancy {
  currentInputTokens: number;
  currentOutputTokens: number;
  currentCacheReadTokens: number;
  currentCacheCreateTokens: number;
  lastUpdated?: number;
}

/**
 * Adopt the SDK's `compact_boundary.post_tokens` as the live context
 * occupancy. Returns `false` (and mutates nothing) when the SDK did not
 * supply a usable count — we never invent a number.
 *
 * The whole total lands in `currentInputTokens` with the other three zeroed.
 * That is an OCCUPANCY ENCODING, not token-category attribution: `post_tokens`
 * is a single "how full is the window" figure with no input/cache/output
 * breakdown, and every consumer of `current*` sums all four
 * (`ContextWindowManager.computeUsedTokens`). Billing lives on `total*` and is
 * deliberately untouched here — the compaction request really did spend those
 * tokens.
 */
export function applyPostCompactOccupancy(usage: MutableContextOccupancy, postTokens: unknown): boolean {
  if (typeof postTokens !== 'number' || !Number.isFinite(postTokens) || postTokens < 0) return false;
  usage.currentInputTokens = Math.round(postTokens);
  usage.currentOutputTokens = 0;
  usage.currentCacheReadTokens = 0;
  usage.currentCacheCreateTokens = 0;
  usage.lastUpdated = Date.now();
  return true;
}

/** Per-model cumulative totals bucket stored on `SessionUsage.modelTotals`. */
export interface SessionModelTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  costUsd: number;
}

/**
 * Accumulate a turn's per-model billing breakdown into the session-level
 * `modelTotals` map (mutates and returns `totals`). When the producer did not
 * supply a breakdown (older shapes, ACP), the aggregate is credited to
 * `fallbackModel` so the per-model view stays complete.
 */
export function accumulateModelTotals(
  totals: Record<string, SessionModelTotals>,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    totalCostUsd: number;
    modelBreakdown?: Record<
      string,
      {
        inputTokens: number;
        outputTokens: number;
        cacheReadInputTokens: number;
        cacheCreationInputTokens: number;
        costUsd: number;
      }
    >;
  },
  fallbackModel: string | undefined,
): Record<string, SessionModelTotals> {
  const entries = usage.modelBreakdown
    ? Object.entries(usage.modelBreakdown).map(
        ([model, u]) =>
          [
            model,
            {
              inputTokens: u.inputTokens,
              outputTokens: u.outputTokens,
              cacheReadTokens: u.cacheReadInputTokens,
              cacheCreateTokens: u.cacheCreationInputTokens,
              costUsd: u.costUsd,
            },
          ] as const,
      )
    : ([
        [
          fallbackModel ?? 'unknown',
          {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadInputTokens,
            cacheCreateTokens: usage.cacheCreationInputTokens,
            costUsd: usage.totalCostUsd,
          },
        ],
      ] as const);

  for (const [model, delta] of entries) {
    const bucket = totals[model] ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      costUsd: 0,
    };
    bucket.inputTokens += delta.inputTokens;
    bucket.outputTokens += delta.outputTokens;
    bucket.cacheReadTokens += delta.cacheReadTokens;
    bucket.cacheCreateTokens += delta.cacheCreateTokens;
    bucket.costUsd += delta.costUsd;
    totals[model] = bucket;
  }
  return totals;
}
