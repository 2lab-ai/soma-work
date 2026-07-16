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
import { selectCurrentContextTokens } from '../session-usage-math';

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
