/**
 * OpenAIProvider tests (Issue #413)
 */

import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from './agent-provider.js';
import { type OpenAIClientInterface, OpenAIProvider, type OpenAIStreamEvent } from './openai-provider.js';

// ─── Helpers ────────────────────────────────────────────────────

async function* mockStream(events: OpenAIStreamEvent[]): AsyncIterable<OpenAIStreamEvent> {
  for (const event of events) {
    yield event;
  }
}

function createMockClient(events: OpenAIStreamEvent[] = []): OpenAIClientInterface {
  return {
    stream: vi.fn().mockReturnValue(mockStream(events)),
    create: vi.fn().mockResolvedValue({
      id: 'resp-1',
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'One-shot result' }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
  };
}

// ─── Tests ───────────────────────────────────────────────────────

describe('OpenAIProvider', () => {
  it('reports name as openai', () => {
    const client = createMockClient();
    const provider = new OpenAIProvider(client);
    expect(provider.name).toBe('openai');
  });

  describe('query', () => {
    it('yields init event from response.created', async () => {
      const client = createMockClient([
        {
          type: 'response.created',
          response: { id: 'resp-123', model: 'gpt-4o', usage: undefined },
        },
      ]);
      const provider = new OpenAIProvider(client);
      const events: AgentEvent[] = [];

      for await (const event of provider.query({ prompt: 'Hello' })) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: 'init',
        model: 'gpt-4o',
        sessionId: 'resp-123',
      });
    });

    it('yields text event from output_text delta', async () => {
      const client = createMockClient([{ type: 'response.output_text.delta', delta: 'Hello back!' }]);
      const provider = new OpenAIProvider(client);
      const events: AgentEvent[] = [];

      for await (const event of provider.query({ prompt: 'Hello' })) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: 'text', text: 'Hello back!' });
    });

    it('yields tool_use from function_call output item', async () => {
      const client = createMockClient([
        {
          type: 'response.output_item.done',
          item: {
            type: 'function_call',
            name: 'get_weather',
            call_id: 'call-1',
            arguments: '{"location":"Seoul"}',
          },
        },
      ]);
      const provider = new OpenAIProvider(client);
      const events: AgentEvent[] = [];

      for await (const event of provider.query({ prompt: 'Weather?' })) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: 'tool_use',
        toolName: 'get_weather',
        toolInput: { location: 'Seoul' },
        toolCallId: 'call-1',
      });
    });

    it('yields turn_complete from response.completed', async () => {
      const client = createMockClient([
        {
          type: 'response.completed',
          response: {
            id: 'resp-456',
            model: 'gpt-4o',
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        },
      ]);
      const provider = new OpenAIProvider(client);
      const events: AgentEvent[] = [];

      for await (const event of provider.query({ prompt: 'Done' })) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'turn_complete',
        stopReason: 'end_turn',
        sessionId: 'resp-456',
        usage: {
          inputTokens: 100,
          outputTokens: 50,
        },
      });
    });

    it('yields error event from error stream event', async () => {
      const client = createMockClient([
        {
          type: 'error',
          error: { message: 'Rate limit exceeded', code: 'rate_limit_exceeded' },
        },
      ]);
      const provider = new OpenAIProvider(client);
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

    it('yields error event on stream exception', async () => {
      const client: OpenAIClientInterface = {
        stream: vi.fn().mockImplementation(async function* () {
          throw new Error('network_error');
        }),
        create: vi.fn().mockResolvedValue({ id: '', output: [] }),
      };
      const provider = new OpenAIProvider(client);
      const events: AgentEvent[] = [];

      for await (const event of provider.query({ prompt: 'Crash' })) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('error');
    });

    it('passes model to stream params', async () => {
      const client = createMockClient([]);
      const provider = new OpenAIProvider(client, 'o3');

      for await (const _ of provider.query({ prompt: 'test' })) {
        // noop
      }

      expect(client.stream).toHaveBeenCalledWith(expect.objectContaining({ model: 'o3' }));
    });

    it('uses custom model from params', async () => {
      const client = createMockClient([]);
      const provider = new OpenAIProvider(client);

      for await (const _ of provider.query({ prompt: 'test', model: 'gpt-4o-mini' })) {
        // noop
      }

      expect(client.stream).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-4o-mini' }));
    });

    it('handles full realistic turn', async () => {
      const client = createMockClient([
        {
          type: 'response.created',
          response: { id: 'resp-full', model: 'gpt-4o' },
        },
        { type: 'response.output_text.delta', delta: 'The answer ' },
        { type: 'response.output_text.delta', delta: 'is 42.' },
        {
          type: 'response.completed',
          response: {
            id: 'resp-full',
            model: 'gpt-4o',
            usage: { input_tokens: 50, output_tokens: 20 },
          },
        },
      ]);
      const provider = new OpenAIProvider(client);
      const events: AgentEvent[] = [];

      for await (const event of provider.query({ prompt: 'What is the answer?' })) {
        events.push(event);
      }

      expect(events).toHaveLength(4);
      expect(events[0].type).toBe('init');
      expect(events[1]).toEqual({ type: 'text', text: 'The answer ' });
      expect(events[2]).toEqual({ type: 'text', text: 'is 42.' });
      expect(events[3].type).toBe('turn_complete');
    });
  });

  describe('queryOneShot', () => {
    it('returns text from non-streaming response', async () => {
      const client = createMockClient();
      const provider = new OpenAIProvider(client);

      const result = await provider.queryOneShot({ prompt: 'classify this' }, 'You are a classifier');

      expect(result).toBe('One-shot result');
      expect(client.create).toHaveBeenCalledWith(
        expect.objectContaining({
          input: 'classify this',
          instructions: 'You are a classifier',
        }),
      );
    });
  });

  describe('validateCredentials', () => {
    it('returns true (validation happens inside query)', async () => {
      const client = createMockClient();
      const provider = new OpenAIProvider(client);

      const valid = await provider.validateCredentials();
      expect(valid).toBe(true);
    });
  });
});
