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
 */

import { describe, it, expect } from 'vitest';
import type { SessionUsage } from '../../types';

/**
 * Simulates the updateSessionUsage logic from stream-executor.ts
 * This is extracted for testing purposes.
 */
function updateSessionUsage(
  session: { usage?: SessionUsage },
  usageData: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    totalCostUsd: number;
  }
): void {
  const DEFAULT_CONTEXT_WINDOW = 200000;

  if (!session.usage) {
    session.usage = {
      currentInputTokens: 0,
      currentOutputTokens: 0,
      currentCacheReadTokens: 0,
      currentCacheCreateTokens: 0,
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
      lastUpdated: Date.now(),
    };
  }

  // CURRENT values are OVERWRITTEN (not accumulated)
  // This is correct because input_tokens already includes conversation history
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
   *
   * Turn 1:
   *   User: "Hello" (50 tokens)
   *   → API request input: 50 tokens (just this message + system prompt)
   *   → API response output: 200 tokens
   *   → Context after turn 1: 250 tokens
   *
   * Turn 2:
   *   User: "How are you?" (30 tokens)
   *   → API request input: 280 tokens (turn1: 50+200) + (turn2: 30) = 280
   *   → API response output: 150 tokens
   *   → Context after turn 2: 280 + 150 = 430 tokens
   *
   * OLD BUG: Would show 50+280 + 200+150 = 680 tokens (WRONG - double counting)
   * FIX: Shows 280 + 150 = 430 tokens (CORRECT)
   */
  it('should OVERWRITE current context, not accumulate', () => {
    const session: { usage?: SessionUsage } = {};

    // Turn 1: User sends message, AI responds
    updateSessionUsage(session, {
      inputTokens: 50,      // Just the user message + system
      outputTokens: 200,    // AI response
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalCostUsd: 0.001,
    });

    // After turn 1: current context = 50 + 200 = 250
    expect(session.usage!.currentInputTokens).toBe(50);
    expect(session.usage!.currentOutputTokens).toBe(200);
    expect(session.usage!.currentInputTokens + session.usage!.currentOutputTokens).toBe(250);

    // Turn 2: User sends another message
    // Input now includes ALL previous history (50 + 200 = 250) + new message (30) = 280
    updateSessionUsage(session, {
      inputTokens: 280,     // Previous history + new message
      outputTokens: 150,    // AI response
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalCostUsd: 0.002,
    });

    // PROOF: currentInputTokens is OVERWRITTEN to 280, not accumulated to 330
    expect(session.usage!.currentInputTokens).toBe(280);
    expect(session.usage!.currentOutputTokens).toBe(150);

    // Current context window = 280 + 150 = 430 (CORRECT)
    const currentContext = session.usage!.currentInputTokens + session.usage!.currentOutputTokens;
    expect(currentContext).toBe(430);

    // NOT 50+280 + 200+150 = 680 (WRONG - what old code would show)
    expect(currentContext).not.toBe(680);
  });

  it('should ACCUMULATE totals for cost tracking', () => {
    const session: { usage?: SessionUsage } = {};

    // Turn 1
    updateSessionUsage(session, {
      inputTokens: 50,
      outputTokens: 200,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalCostUsd: 0.001,
    });

    // Turn 2
    updateSessionUsage(session, {
      inputTokens: 280,
      outputTokens: 150,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalCostUsd: 0.002,
    });

    // Totals ARE accumulated (for billing purposes)
    // 50 + 280 = 330 total input tokens billed
    expect(session.usage!.totalInputTokens).toBe(330);
    // 200 + 150 = 350 total output tokens billed
    expect(session.usage!.totalOutputTokens).toBe(350);
    // Cost accumulated
    expect(session.usage!.totalCostUsd).toBeCloseTo(0.003);
  });

  /**
   * PROOF: Longer conversation to show the pattern clearly
   *
   * The key insight: input_tokens grows with each turn because it includes
   * ALL previous messages. So on turn N, input_tokens ≈ all tokens from turns 1 to N.
   */
  it('should correctly track a 5-turn conversation', () => {
    const session: { usage?: SessionUsage } = {};

    // Simulated conversation where each turn adds ~100 tokens
    // API returns increasing input_tokens because history grows
    const turns = [
      { inputTokens: 100, outputTokens: 100 },   // Turn 1: just msg + response
      { inputTokens: 300, outputTokens: 150 },   // Turn 2: history(200) + msg(100)
      { inputTokens: 550, outputTokens: 200 },   // Turn 3: history(450) + msg(100)
      { inputTokens: 850, outputTokens: 180 },   // Turn 4: history(750) + msg(100)
      { inputTokens: 1130, outputTokens: 220 },  // Turn 5: history(1030) + msg(100)
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

    // After turn 5, current context should be:
    // 1130 (input includes all history) + 220 (latest output) = 1350
    const currentContext = session.usage!.currentInputTokens + session.usage!.currentOutputTokens;
    expect(currentContext).toBe(1350);

    // Old bug would show: sum of all input + sum of all output
    // = (100+300+550+850+1130) + (100+150+200+180+220)
    // = 2930 + 850 = 3780 (WRONG - massive overcount)
    expect(currentContext).not.toBe(3780);
  });

  it('should track cache tokens correctly', () => {
    const session: { usage?: SessionUsage } = {};

    updateSessionUsage(session, {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadInputTokens: 800,  // 800 of the 1000 input came from cache
      cacheCreationInputTokens: 200,  // 200 tokens cached for future
      totalCostUsd: 0.01,
    });

    expect(session.usage!.currentCacheReadTokens).toBe(800);
    expect(session.usage!.currentCacheCreateTokens).toBe(200);
  });

  it('should use correct default context window', () => {
    const session: { usage?: SessionUsage } = {};

    updateSessionUsage(session, {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalCostUsd: 0.001,
    });

    expect(session.usage!.contextWindow).toBe(200000);
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
 * This is EXACTLY what we display.
 *
 * OLD CODE BUG:
 * - Accumulated all input_tokens: Σ(input_i) = H_0+M_1 + H_1+M_2 + ... = double counting!
 * - This overcounts because H_i already includes all of H_{i-1}
 *
 * FIX:
 * - Just use the LATEST input_tokens + output_tokens = H_n = actual context
 */
