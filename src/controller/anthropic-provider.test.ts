/**
 * AnthropicProvider tests (Issue #410)
 */

import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from './agent-provider.js';
import { AnthropicProvider, type ClaudeHandlerQueryInterface } from './anthropic-provider.js';

// ─── Mock ClaudeHandler ──────────────────────────────────────────

function createMockClaudeHandler(): ClaudeHandlerQueryInterface {
  return {
    streamQuery: vi.fn(),
    dispatchOneShot: vi.fn().mockResolvedValue('dispatch result'),
  };
}

/** Create a mock async generator that yields SDK messages. */
async function* mockSdkStream(messages: any[]): AsyncGenerator<any, void, unknown> {
  for (const msg of messages) {
    yield msg;
  }
}

// ─── Tests ───────────────────────────────────────────────────────

describe('AnthropicProvider', () => {
  it('reports name as anthropic', () => {
    const handler = createMockClaudeHandler();
    const provider = new AnthropicProvider(handler);
    expect(provider.name).toBe('anthropic');
  });

  describe('query', () => {
    it('yields init event from system message', async () => {
      const handler = createMockClaudeHandler();
      (handler.streamQuery as any).mockReturnValue(
        mockSdkStream([{ type: 'system', subtype: 'init', model: 'claude-opus-4-6', session_id: 'sess-123' }]),
      );

      const provider = new AnthropicProvider(handler);
      const events: AgentEvent[] = [];

      for await (const event of provider.query({ prompt: 'Hello' })) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: 'init',
        model: 'claude-opus-4-6',
        sessionId: 'sess-123',
      });
    });

    it('yields text event from assistant message', async () => {
      const handler = createMockClaudeHandler();
      (handler.streamQuery as any).mockReturnValue(
        mockSdkStream([
          {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'Hello back!' }] },
          },
        ]),
      );

      const provider = new AnthropicProvider(handler);
      const events: AgentEvent[] = [];

      for await (const event of provider.query({ prompt: 'Hello' })) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: 'text', text: 'Hello back!' });
    });

    it('yields tool_use event from assistant message', async () => {
      const handler = createMockClaudeHandler();
      (handler.streamQuery as any).mockReturnValue(
        mockSdkStream([
          {
            type: 'assistant',
            message: {
              content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' }, id: 'tc-1' }],
            },
          },
        ]),
      );

      const provider = new AnthropicProvider(handler);
      const events: AgentEvent[] = [];

      for await (const event of provider.query({ prompt: 'List files' })) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: 'tool_use',
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        toolCallId: 'tc-1',
      });
    });

    it('yields turn_complete event from result message', async () => {
      const handler = createMockClaudeHandler();
      (handler.streamQuery as any).mockReturnValue(
        mockSdkStream([
          {
            type: 'result',
            subtype: 'success',
            stop_reason: 'end_turn',
            session_id: 'sess-456',
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              cache_read_input_tokens: 10,
            },
          },
        ]),
      );

      const provider = new AnthropicProvider(handler);
      const events: AgentEvent[] = [];

      for await (const event of provider.query({ prompt: 'Done' })) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'turn_complete',
        stopReason: 'end_turn',
        sessionId: 'sess-456',
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 10,
        },
      });
    });

    it('yields error event on SDK exception', async () => {
      const handler = createMockClaudeHandler();
      (handler.streamQuery as any).mockImplementation(function* () {
        throw new Error('overloaded_error');
      });

      const provider = new AnthropicProvider(handler);
      const events: AgentEvent[] = [];

      for await (const event of provider.query({ prompt: 'Fail' })) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('error');
      if (events[0].type === 'error') {
        expect(events[0].isRecoverable).toBe(true);
        expect(events[0].retryAfterMs).toBe(5000);
      }
    });

    it('passes parameters to streamQuery', async () => {
      const handler = createMockClaudeHandler();
      (handler.streamQuery as any).mockReturnValue(mockSdkStream([]));

      const provider = new AnthropicProvider(handler);
      const ac = new AbortController();

      // Consume the stream
      for await (const _ of provider.query({
        prompt: 'test',
        workingDirectory: '/tmp/work',
        abortController: ac,
      })) {
        // noop
      }

      expect(handler.streamQuery).toHaveBeenCalledWith('test', undefined, ac, '/tmp/work', undefined);
    });
  });

  describe('queryOneShot', () => {
    it('delegates to dispatchOneShot', async () => {
      const handler = createMockClaudeHandler();
      const provider = new AnthropicProvider(handler);

      const result = await provider.queryOneShot({ prompt: 'classify this', model: 'haiku' }, 'You are a classifier');

      expect(result).toBe('dispatch result');
      expect(handler.dispatchOneShot).toHaveBeenCalledWith(
        'classify this',
        'You are a classifier',
        'haiku',
        undefined,
        undefined,
        undefined,
      );
    });
  });

  describe('validateCredentials', () => {
    it('returns true (validation happens inside query)', async () => {
      const handler = createMockClaudeHandler();
      const provider = new AnthropicProvider(handler);

      const valid = await provider.validateCredentials();
      expect(valid).toBe(true);
    });
  });
});
