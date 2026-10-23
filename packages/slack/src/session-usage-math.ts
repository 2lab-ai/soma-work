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

/** One model's counters as a result's `modelUsage` reports them (and as `modelBreakdown` carries them). */
export interface ModelUsageCounters {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
}

/**
 * The last per-model running total seen for one SDK session. Persisted on the
 * session: `session.usage` is runtime-only, but the goal's spend is not, so a
 * restart must not forget where the running total stood.
 */
export interface SdkUsageBaseline {
  /** SDK session id the totals belong to; a different id means a new running total. */
  sdkSessionId: string | null;
  models: Record<string, ModelUsageCounters>;
}

const COUNTER_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
  'costUsd',
] as const satisfies readonly (keyof ModelUsageCounters)[];

/** Float slack for cost comparisons: an unchanged running total must never read as a drop. */
const COST_EPSILON = 1e-9;

/** The slice of a turn's usage `toTurnUsage` rewrites. */
export interface TurnUsageInput {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalCostUsd: number;
  modelBreakdown?: Record<string, ModelUsageCounters>;
}

/**
 * Turn a result's usage into THIS turn's spend.
 *
 * A result's `modelUsage` (→ `modelBreakdown` and the aggregates summed from
 * it) is the SDK session's running total — "cumulative across turns … a
 * resumed session continues from the totals its transcript saved … read the
 * latest result rather than summing across results" (sdk.d.ts,
 * `SDKResultSuccess.modelUsage`). soma-work resumes the same SDK session every
 * turn, so the turn's spend is the growth since the last total seen for that
 * SDK session (`baseline`).
 *
 * - No breakdown (per-turn shapes, ACP): returned unchanged, baseline kept.
 * - All-zero breakdown (crash/startup-error result): nothing spent, baseline
 *   kept — the next resumed result continues from the saved total.
 * - Different SDK session id: a new running total — counts from zero.
 * - A model's total went down: that model's total restarted — it counts in
 *   full. When EVERY model seen before went down (mid-session `/clear`), the
 *   whole running total restarted and this result becomes the baseline.
 *
 * Models that did not grow are left out of the turn's breakdown. Everything
 * else on `usage` (per-turn context fields, model name, cost source) is kept.
 */
export function toTurnUsage<U extends TurnUsageInput>(
  usage: U,
  baseline: SdkUsageBaseline | undefined,
  sdkSessionId: string | undefined,
): { turn: U; baseline: SdkUsageBaseline | undefined } {
  const current = usage.modelBreakdown;
  if (!current) return { turn: usage, baseline };
  const entries = Object.entries(current);
  if (entries.every(([, c]) => COUNTER_FIELDS.every((f) => !c[f]))) return { turn: usage, baseline };

  const id = sdkSessionId ?? null;
  const previous = baseline && baseline.sdkSessionId === id ? baseline.models : {};
  const seen = entries.filter(([model]) => previous[model]);
  const dropped = new Set(
    seen
      .filter(([model, c]) =>
        COUNTER_FIELDS.some((f) => previous[model][f] - c[f] > (f === 'costUsd' ? COST_EPSILON : 0)),
      )
      .map(([model]) => model),
  );
  const cleared = seen.length > 0 && dropped.size === seen.length;
  const base = cleared ? {} : previous;

  const breakdown: Record<string, ModelUsageCounters> = {};
  for (const [model, c] of entries) {
    const b = dropped.has(model) ? undefined : base[model];
    const d = {
      inputTokens: Math.max(0, c.inputTokens - (b?.inputTokens ?? 0)),
      outputTokens: Math.max(0, c.outputTokens - (b?.outputTokens ?? 0)),
      cacheReadInputTokens: Math.max(0, c.cacheReadInputTokens - (b?.cacheReadInputTokens ?? 0)),
      cacheCreationInputTokens: Math.max(0, c.cacheCreationInputTokens - (b?.cacheCreationInputTokens ?? 0)),
      costUsd: Math.max(0, c.costUsd - (b?.costUsd ?? 0)),
    };
    if (COUNTER_FIELDS.some((f) => d[f] > 0)) breakdown[model] = d;
  }
  const all = Object.values(breakdown);
  const sum = (f: keyof ModelUsageCounters) => all.reduce((acc, d) => acc + d[f], 0);
  return {
    turn: {
      ...usage,
      inputTokens: sum('inputTokens'),
      outputTokens: sum('outputTokens'),
      cacheReadInputTokens: sum('cacheReadInputTokens'),
      cacheCreationInputTokens: sum('cacheCreationInputTokens'),
      totalCostUsd: sum('costUsd'),
      modelBreakdown: breakdown,
    },
    baseline: { sdkSessionId: id, models: { ...base, ...current } },
  };
}

/** Restore a persisted baseline; anything malformed is dropped rather than trusted. */
export function sanitizeSdkUsageBaseline(raw: unknown): SdkUsageBaseline | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { sdkSessionId, models } = raw as { sdkSessionId?: unknown; models?: unknown };
  if (sdkSessionId !== null && typeof sdkSessionId !== 'string') return undefined;
  if (!models || typeof models !== 'object') return undefined;
  const out: Record<string, ModelUsageCounters> = {};
  for (const [model, c] of Object.entries(models as Record<string, unknown>)) {
    if (!c || typeof c !== 'object') return undefined;
    const counters = c as Record<string, unknown>;
    if (!COUNTER_FIELDS.every((f) => typeof counters[f] === 'number' && Number.isFinite(counters[f]))) return undefined;
    out[model] = Object.fromEntries(COUNTER_FIELDS.map((f) => [f, counters[f]])) as unknown as ModelUsageCounters;
  }
  return { sdkSessionId, models: out };
}
