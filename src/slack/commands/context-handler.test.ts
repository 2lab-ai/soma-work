/**
 * ContextHandler tests - Proving context window calculation is correct
 *
 * KEY INSIGHT: Context Window = input_tokens + output_tokens from most recent request
 *
 * Why? Because input_tokens already includes:
 * - All previous conversation history
 * - The current new message
 *
 * So after each API call, the context usage is simply:
 *   currentInputTokens + currentOutputTokens
 *
 * This is what we display to the user - NOT the cumulative total.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContextHandler } from './context-handler';
import type { CommandDependencies, CommandContext, SayFn } from './types';
import type { SessionUsage } from '../../types';

describe('ContextHandler', () => {
  let handler: ContextHandler;
  let mockDeps: CommandDependencies;
  let mockSay: SayFn;

  beforeEach(() => {
    mockSay = vi.fn().mockResolvedValue({ ts: 'msg_ts' }) as unknown as SayFn;
    mockDeps = {
      claudeHandler: {
        getSession: vi.fn(),
      },
      slackApi: {
        postSystemMessage: vi.fn().mockResolvedValue({ ts: 'msg_ts' }),
      },
    } as unknown as CommandDependencies;
    handler = new ContextHandler(mockDeps);
  });

  describe('canHandle', () => {
    it('should handle "context" command', () => {
      expect(handler.canHandle('context')).toBe(true);
      expect(handler.canHandle('/context')).toBe(true);
      expect(handler.canHandle('  context  ')).toBe(true);
    });

    it('should not handle other commands', () => {
      expect(handler.canHandle('help')).toBe(false);
      expect(handler.canHandle('cwd')).toBe(false);
    });
  });

  describe('execute - context window calculation', () => {
    /**
     * This test proves the core fix: context window displays CURRENT context,
     * not cumulative totals.
     *
     * Scenario:
     * - Request 1: input=1000, output=500 → context = 1500
     * - Request 2: input=2000 (includes history), output=800 → context = 2800
     *
     * OLD (WRONG): Would show 1000+2000 + 500+800 = 4300 (cumulative)
     * NEW (CORRECT): Shows 2000 + 800 = 2800 (current context window)
     */
    it('should display CURRENT context window usage, not cumulative', async () => {
      // After 2 requests, current context is 2000 + 800 = 2800
      // Cumulative totals are 3000 input, 1300 output
      const usage: SessionUsage = {
        currentInputTokens: 2000,    // Current request input (includes history!)
        currentOutputTokens: 800,    // Current response output
        currentCacheReadTokens: 0,
        currentCacheCreateTokens: 0,
        contextWindow: 200000,
        totalInputTokens: 3000,      // Sum of all requests (1000 + 2000)
        totalOutputTokens: 1300,     // Sum of all responses (500 + 800)
        totalCostUsd: 0.05,
        lastUpdated: Date.now(),
      };

      (mockDeps.claudeHandler.getSession as any).mockReturnValue({
        usage,
        model: 'claude-sonnet-4-20250514',
      });

      const ctx: CommandContext = {
        channel: 'C123',
        threadTs: 'thread_ts',
        user: 'U123',
        text: 'context',
        say: mockSay,
      };

      await handler.execute(ctx);

      const postSystemMessage = mockDeps.slackApi.postSystemMessage as ReturnType<typeof vi.fn>;
      expect(postSystemMessage).toHaveBeenCalledTimes(1);
      const message = postSystemMessage.mock.calls[0][1];

      // PROOF: Context window shows 2.8k (2000 + 800), NOT 4.3k (cumulative)
      expect(message).toContain('*Context Window:* 2.8k / 200.0k');

      // Session totals show cumulative values correctly
      expect(message).toContain('• Input: 3.0k');   // cumulative
      expect(message).toContain('• Output: 1.3k'); // cumulative
    });

    /**
     * PROOF: Why current context matters more than cumulative
     *
     * The user needs to know: "How much of my 200k context is being used?"
     * This is determined by the LAST request's input (which includes history)
     * plus the LAST response's output.
     *
     * Example conversation:
     * - Turn 1: User sends 500 tokens → AI responds 1000 tokens
     *   Input: 500 (just user message)
     *   Output: 1000
     *   Context after turn 1: 1500 tokens
     *
     * - Turn 2: User sends 300 tokens
     *   Input: 1500 (turn 1) + 300 (new) = 1800 tokens
     *   Output: 800 tokens
     *   Context after turn 2: 2600 tokens (NOT 1500 + 1800 + 800)
     *
     * The API always sends the FULL conversation as input, so:
     *   current_context = last_input + last_output
     */
    it('should show correct percentage available', async () => {
      // Context: 50k used out of 200k = 75% available
      const usage: SessionUsage = {
        currentInputTokens: 40000,
        currentOutputTokens: 10000,
        currentCacheReadTokens: 0,
        currentCacheCreateTokens: 0,
        contextWindow: 200000,
        totalInputTokens: 60000,  // higher due to multiple requests
        totalOutputTokens: 15000,
        totalCostUsd: 0.10,
        lastUpdated: Date.now(),
      };

      (mockDeps.claudeHandler.getSession as any).mockReturnValue({ usage });

      await handler.execute({
        channel: 'C123',
        threadTs: 'ts',
        user: 'U123',
        text: 'context',
        say: mockSay,
      });

      const postSystemMessage = mockDeps.slackApi.postSystemMessage as ReturnType<typeof vi.fn>;
      const message = postSystemMessage.mock.calls[0][1];
      // (200000 - 50000) / 200000 * 100 = 75%
      expect(message).toContain('75% available');
    });

    it('should show warning when context is nearly full', async () => {
      // 180k used out of 200k = only 10% available
      const usage: SessionUsage = {
        currentInputTokens: 150000,
        currentOutputTokens: 30000,
        currentCacheReadTokens: 5000,
        currentCacheCreateTokens: 2000,
        contextWindow: 200000,
        totalInputTokens: 200000,
        totalOutputTokens: 50000,
        totalCostUsd: 0.50,
        lastUpdated: Date.now(),
      };

      (mockDeps.claudeHandler.getSession as any).mockReturnValue({ usage });

      await handler.execute({
        channel: 'C123',
        threadTs: 'ts',
        user: 'U123',
        text: 'context',
        say: mockSay,
      });

      const postSystemMessage = mockDeps.slackApi.postSystemMessage as ReturnType<typeof vi.fn>;
      const message = postSystemMessage.mock.calls[0][1];
      expect(message).toContain('10% available');
      expect(message).toContain('⚠️ Context running low');
      expect(message).toContain('/renew');
    });

    it('should show cache info when caching is used', async () => {
      const usage: SessionUsage = {
        currentInputTokens: 5000,
        currentOutputTokens: 1000,
        currentCacheReadTokens: 3000,  // Read from cache
        currentCacheCreateTokens: 500, // Created new cache
        contextWindow: 200000,
        totalInputTokens: 10000,
        totalOutputTokens: 2000,
        totalCostUsd: 0.02,
        lastUpdated: Date.now(),
      };

      (mockDeps.claudeHandler.getSession as any).mockReturnValue({ usage });

      await handler.execute({
        channel: 'C123',
        threadTs: 'ts',
        user: 'U123',
        text: 'context',
        say: mockSay,
      });

      const postSystemMessage = mockDeps.slackApi.postSystemMessage as ReturnType<typeof vi.fn>;
      const message = postSystemMessage.mock.calls[0][1];
      expect(message).toContain('Cache read: 3.0k');
      expect(message).toContain('Cache created: 500');
    });
  });

  describe('edge cases', () => {
    it('should handle no active session', async () => {
      (mockDeps.claudeHandler.getSession as any).mockReturnValue(null);

      await handler.execute({
        channel: 'C123',
        threadTs: 'ts',
        user: 'U123',
        text: 'context',
        say: mockSay,
      });

      const postSystemMessage = mockDeps.slackApi.postSystemMessage as ReturnType<typeof vi.fn>;
      expect(postSystemMessage).toHaveBeenCalledWith(
        'C123',
        expect.stringContaining('No active session'),
        expect.objectContaining({ threadTs: 'ts' }),
      );
    });

    it('should handle session without usage data', async () => {
      (mockDeps.claudeHandler.getSession as any).mockReturnValue({
        usage: null,
      });

      await handler.execute({
        channel: 'C123',
        threadTs: 'ts',
        user: 'U123',
        text: 'context',
        say: mockSay,
      });

      const postSystemMessage = mockDeps.slackApi.postSystemMessage as ReturnType<typeof vi.fn>;
      expect(postSystemMessage).toHaveBeenCalledWith(
        'C123',
        expect.stringContaining('No usage data available'),
        expect.objectContaining({ threadTs: 'ts' }),
      );
    });
  });
});
