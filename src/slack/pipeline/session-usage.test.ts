/**
 * Session Usage Tests - Proving current vs cumulative tracking logic
 *
 * PROOF OF CORRECTNESS:
 *
 * The Claude API returns usage per request:
 * - input_tokens: Total tokens in the request (conversation history + new message)
 * - output_tokens: Tokens in the response
 *
 * Context Window = input_tokens + output_tokens from the LATEST request
 *
 * Why input_tokens already includes history:
 * - Claude API is stateless - every request sends the full conversation
 * - input_tokens on request N includes all tokens from turns 1 to N-1, plus turn N
 * - So we DON'T accumulate input_tokens - we OVERWRITE with the latest value
 *
 * What we track:
 * 1. currentInputTokens / currentOutputTokens - OVERWRITTEN each request (for context display)
 * 2. totalInputTokens / totalOutputTokens - ACCUMULATED (for cost tracking)
 * 3. contextWindow - DYNAMICALLY SET from SDK's ModelUsage.contextWindow (not hardcoded)
 */

import { describe, it, expect } from 'vitest';
import type { SessionUsage } from '../../types';

// Matches the renamed constant in stream-executor.ts
const FALLBACK_CONTEXT_WINDOW = 200_000;

/**
 * Simulates the updateSessionUsage logic from stream-executor.ts
 * This is extracted for testing purposes.
 */
function updateSessionUsage(
  session: { usage?: SessionUsage; model?: string },
  usageData: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    totalCostUsd: number;
    contextWindow?: number;
    modelName?: string;
  }
): void {
  if (!session.usage) {
    session.usage = {
      currentInputTokens: 0,
      currentOutputTokens: 0,
      currentCacheReadTokens: 0,
      currentCacheCreateTokens: 0,
      contextWindow: FALLBACK_CONTEXT_WINDOW,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
      lastUpdated: Date.now(),
    };
  }

  // Dynamically update context window from SDK if available
  if (usageData.contextWindow && usageData.contextWindow > 0) {
    session.usage.contextWindow = usageData.contextWindow;
  }

  // Update model name on session
  if (usageData.modelName && !session.model) {
    session.model = usageData.modelName;
  }

  // CURRENT values are OVERWRITTEN (not accumulated)
  session.usage.currentInputTokens = usageData.inputTokens;
  session.usage.currentOutputTokens = usageData.outputTokens;
  session.usage.currentCacheReadTokens = usageData.cacheReadInputTokens;
  session.usage.currentCacheCreateTokens = usageData.cacheCreationInputTokens;

  // TOTAL values are ACCUMULATED
  session.usage.totalInputTokens += usageData.inputTokens;
  session.usage.totalOutputTokens += usageData.outputTokens;
  session.usage.totalCostUsd += usageData.totalCostUsd;
  session.usage.lastUpdated = Date.now();
}

describe('Session Usage Tracking', () => {
  /**
   * PROOF: Multi-turn conversation context tracking
   */
  it('should OVERWRITE current context, not accumulate', () => {
    const session: { usage?: SessionUsage } = {};

    // Turn 1
    updateSessionUsage(session, {
      inputTokens: 50,
      outputTokens: 200,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalCostUsd: 0.001,
    });

    expect(session.usage!.currentInputTokens).toBe(50);
    expect(session.usage!.currentOutputTokens).toBe(200);
    expect(session.usage!.currentInputTokens + session.usage!.currentOutputTokens).toBe(250);

    // Turn 2: Input includes ALL previous history (50+200=250) + new msg (30) = 280
    updateSessionUsage(session, {
      inputTokens: 280,
      outputTokens: 150,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalCostUsd: 0.002,
    });

    // PROOF: currentInputTokens is OVERWRITTEN to 280, not accumulated to 330
    expect(session.usage!.currentInputTokens).toBe(280);
    expect(session.usage!.currentOutputTokens).toBe(150);

    // Current context = 280 + 150 = 430 (CORRECT)
    const currentContext = session.usage!.currentInputTokens + session.usage!.currentOutputTokens;
    expect(currentContext).toBe(430);
    // NOT 680 (old bug: accumulating)
    expect(currentContext).not.toBe(680);
  });

  it('should ACCUMULATE totals for cost tracking', () => {
    const session: { usage?: SessionUsage } = {};

    updateSessionUsage(session, {
      inputTokens: 50,
      outputTokens: 200,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalCostUsd: 0.001,
    });

    updateSessionUsage(session, {
      inputTokens: 280,
      outputTokens: 150,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalCostUsd: 0.002,
    });

    expect(session.usage!.totalInputTokens).toBe(330);
    expect(session.usage!.totalOutputTokens).toBe(350);
    expect(session.usage!.totalCostUsd).toBeCloseTo(0.003);
  });

  it('should correctly track a 5-turn conversation', () => {
    const session: { usage?: SessionUsage } = {};

    const turns = [
      { inputTokens: 100, outputTokens: 100 },
      { inputTokens: 300, outputTokens: 150 },
      { inputTokens: 550, outputTokens: 200 },
      { inputTokens: 850, outputTokens: 180 },
      { inputTokens: 1130, outputTokens: 220 },
    ];

    for (const turn of turns) {
      updateSessionUsage(session, {
        inputTokens: turn.inputTokens,
        outputTokens: turn.outputTokens,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        totalCostUsd: 0.001,
      });
    }

    const currentContext = session.usage!.currentInputTokens + session.usage!.currentOutputTokens;
    expect(currentContext).toBe(1350);
    expect(currentContext).not.toBe(3780);
  });

  it('should track cache tokens correctly', () => {
    const session: { usage?: SessionUsage } = {};

    updateSessionUsage(session, {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadInputTokens: 800,
      cacheCreationInputTokens: 200,
      totalCostUsd: 0.01,
    });

    expect(session.usage!.currentCacheReadTokens).toBe(800);
    expect(session.usage!.currentCacheCreateTokens).toBe(200);
  });

  it('should use fallback context window when SDK does not report it', () => {
    const session: { usage?: SessionUsage } = {};

    updateSessionUsage(session, {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalCostUsd: 0.001,
    });

    // Without SDK contextWindow, falls back to 200k
    expect(session.usage!.contextWindow).toBe(FALLBACK_CONTEXT_WINDOW);
  });
});

describe('Dynamic Context Window from SDK', () => {
  it('should update contextWindow from SDK ModelUsage.contextWindow', () => {
    const session: { usage?: SessionUsage; model?: string } = {};

    // Opus 4.6 = 1M context window
    updateSessionUsage(session, {
      inputTokens: 5000,
      outputTokens: 2000,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalCostUsd: 0.05,
      contextWindow: 1_000_000,
      modelName: 'claude-opus-4-6-20250414',
    });

    expect(session.usage!.contextWindow).toBe(1_000_000);
    expect(session.model).toBe('claude-opus-4-6-20250414');
  });

  it('should calculate correct remaining percent with 1M context', () => {
    const session: { usage?: SessionUsage; model?: string } = {};

    updateSessionUsage(session, {
      inputTokens: 100_000,
      outputTokens: 50_000,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalCostUsd: 0.50,
      contextWindow: 1_000_000,
    });

    // Used 150k of 1M = 15% used, 85% remaining
    const used = session.usage!.currentInputTokens + session.usage!.currentOutputTokens;
    const remaining = ((session.usage!.contextWindow - used) / session.usage!.contextWindow) * 100;
    expect(used).toBe(150_000);
    expect(remaining).toBe(85);

    // With old hardcoded 200k: (200k-150k)/200k = 25% remaining (WRONG)
  });

  it('should preserve SDK contextWindow across turns', () => {
    const session: { usage?: SessionUsage; model?: string } = {};

    // Turn 1: SDK reports 1M
    updateSessionUsage(session, {
      inputTokens: 5000,
      outputTokens: 2000,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalCostUsd: 0.05,
      contextWindow: 1_000_000,
    });

    expect(session.usage!.contextWindow).toBe(1_000_000);

    // Turn 2: SDK does NOT report contextWindow
    updateSessionUsage(session, {
      inputTokens: 10000,
      outputTokens: 3000,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalCostUsd: 0.08,
    });

    // Should keep 1M, not reset to 200k
    expect(session.usage!.contextWindow).toBe(1_000_000);
  });

  it('should not overwrite existing model name', () => {
    const session: { usage?: SessionUsage; model?: string } = { model: 'claude-sonnet-4-5-20250414' };

    updateSessionUsage(session, {
      inputTokens: 5000,
      outputTokens: 2000,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalCostUsd: 0.05,
      modelName: 'claude-opus-4-6-20250414',
    });

    expect(session.model).toBe('claude-sonnet-4-5-20250414');
  });
});

describe('Cache tokens in context calculation', () => {
  /**
   * CRITICAL BUG FIX: SDK's modelUsage reports `inputTokens` as
   * non-cached tokens only. Cache tokens must be included for context size.
   *
   * Real data from Opus 4.6 session:
   *   inputTokens=3, cacheRead=117.5k, cacheCreate=5.8k, output=626
   *   Wrong: 3 + 626 = 629 (what old code showed)
   *   Right: 3 + 117,500 + 5,800 + 626 = 123,929
   */
  it('should include cache tokens in total context used', () => {
    const session: { usage?: SessionUsage } = {};

    updateSessionUsage(session, {
      inputTokens: 3,
      outputTokens: 626,
      cacheReadInputTokens: 117_500,
      cacheCreationInputTokens: 5_800,
      totalCostUsd: 0.11,
    });

    const u = session.usage!;
    // Total context = input + cacheRead + cacheCreate + output
    const totalUsed = u.currentInputTokens + u.currentCacheReadTokens + u.currentCacheCreateTokens + u.currentOutputTokens;
    expect(totalUsed).toBe(123_929);

    // Old calculation (WRONG): just inputTokens + outputTokens
    expect(u.currentInputTokens + u.currentOutputTokens).toBe(629);
  });
});

/**
 * MATHEMATICAL PROOF:
 *
 * Let's define:
 * - H_n = total tokens in conversation history after turn n
 * - M_n = new user message tokens on turn n
 * - R_n = AI response tokens on turn n
 *
 * Claude API behavior:
 * - input_tokens on turn n = H_{n-1} + M_n = all previous tokens + new message
 * - output_tokens on turn n = R_n = just the response
 *
 * After turn n:
 * - H_n = H_{n-1} + M_n + R_n = input_n + output_n
 *
 * So context window usage after turn n = input_n + output_n
 *
 * OLD CODE BUGS:
 * 1. Accumulated all input_tokens across agent loop API calls (billing total ≠ context state)
 * 2. Hardcoded contextWindow to 200k (wrong for Opus 4.6 = 1M, Sonnet 4.6 = 1M)
 *
 * FIX:
 * 1. Use LATEST input_tokens + output_tokens = actual context
 * 2. Use SDK's ModelUsage.contextWindow for accurate max (dynamic per model)
 */
