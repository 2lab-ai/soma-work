/**
 * StreamProcessor tests
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PendingForm,
  type SayFunction,
  type StreamCallbacks,
  type StreamContext,
  StreamProcessor,
} from './stream-processor';

// Mock SDKMessage generator
function* createMockStream(messages: any[]): Generator<any> {
  for (const msg of messages) {
    yield msg;
  }
}

describe('StreamProcessor', () => {
  let mockSay: SayFunction;
  let mockContext: StreamContext;
  let abortController: AbortController;

  beforeEach(() => {
    mockSay = vi.fn().mockResolvedValue({ ts: 'msg_ts' }) as unknown as SayFunction;
    abortController = new AbortController();
    mockContext = {
      channel: 'C123',
      threadTs: 'thread_ts',
      sessionKey: 'session_key',
      sessionId: 'session_id',
      say: mockSay,
    };
  });

  describe('process', () => {
    it('should process assistant text messages', async () => {
      const messages = [
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Hello, world!' }],
          },
        },
      ];

      const processor = new StreamProcessor();
      const result = await processor.process(createMockStream(messages) as any, mockContext, abortController.signal);

      expect(result.success).toBe(true);
      expect(result.messageCount).toBe(1);
      expect(result.aborted).toBe(false);
      expect(mockSay).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'Hello, world!',
          thread_ts: 'thread_ts',
        }),
      );
    });

    it('should process tool use messages and call onToolUse callback', async () => {
      const onToolUse = vi.fn();
      const messages = [
        {
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 'tool_1', name: 'Read', input: { file_path: '/test.txt' } }],
          },
        },
      ];

      const callbacks: StreamCallbacks = { onToolUse };
      const processor = new StreamProcessor(callbacks);
      await processor.process(createMockStream(messages) as any, mockContext, abortController.signal);

      expect(onToolUse).toHaveBeenCalledWith(
        [{ id: 'tool_1', name: 'Read', input: { file_path: '/test.txt' } }],
        mockContext,
      );
    });

    it('should render Task tool details in tool use message', async () => {
      const messages = [
        {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'tool_task_1',
                name: 'Task',
                input: {
                  subagent_type: 'oh-my-claude:explore',
                  run_in_background: true,
                  prompt: 'Find code related to task logging',
                },
              },
            ],
          },
        },
      ];

      const processor = new StreamProcessor();
      await processor.process(createMockStream(messages) as any, mockContext, abortController.signal);

      expect(mockSay).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Using Subagent'),
          thread_ts: 'thread_ts',
        }),
      );
      expect(mockSay).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Explorer'),
          thread_ts: 'thread_ts',
        }),
      );
      expect(mockSay).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('model: *opus*'),
          thread_ts: 'thread_ts',
        }),
      );
    });

    it('should call onTodoUpdate for TodoWrite tool', async () => {
      const onTodoUpdate = vi.fn();
      const messages = [
        {
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 'tool_1', name: 'TodoWrite', input: { todos: [{ content: 'Test' }] } }],
          },
        },
      ];

      const callbacks: StreamCallbacks = { onTodoUpdate };
      const processor = new StreamProcessor(callbacks);
      await processor.process(createMockStream(messages) as any, mockContext, abortController.signal);

      expect(onTodoUpdate).toHaveBeenCalledWith({ todos: [{ content: 'Test' }] }, mockContext);
    });

    it('should process user messages with tool results', async () => {
      const onToolResult = vi.fn();
      const messages = [
        {
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'result data' }],
          },
        },
      ];

      const callbacks: StreamCallbacks = { onToolResult };
      const processor = new StreamProcessor(callbacks);
      await processor.process(createMockStream(messages) as any, mockContext, abortController.signal);

      expect(onToolResult).toHaveBeenCalledWith(
        [{ toolUseId: 'tool_1', result: 'result data', isError: undefined, toolName: undefined }],
        mockContext,
      );
    });

    it('should process result messages', async () => {
      const messages = [
        {
          type: 'result',
          subtype: 'success',
          result: 'Final response',
          total_cost_usd: 0.01,
          duration_ms: 1000,
        },
      ];

      const processor = new StreamProcessor();
      await processor.process(createMockStream(messages) as any, mockContext, abortController.signal);

      expect(mockSay).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'Final response',
          thread_ts: 'thread_ts',
        }),
      );
    });

    it('should append final response footer when callback is provided', async () => {
      const buildFinalResponseFooter = vi.fn().mockResolvedValue('```Ctx ▓▓▓░░ 42.0% +0.5```');
      const messages = [
        {
          type: 'result',
          subtype: 'success',
          result: 'Final response',
          duration_ms: 1200,
          usage: {
            input_tokens: 1200,
            output_tokens: 300,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      ];

      const processor = new StreamProcessor({ buildFinalResponseFooter });
      await processor.process(createMockStream(messages) as any, mockContext, abortController.signal);

      expect(buildFinalResponseFooter).toHaveBeenCalledWith(
        expect.objectContaining({
          context: mockContext,
          durationMs: 1200,
          usage: expect.objectContaining({
            inputTokens: 1200,
            outputTokens: 300,
          }),
        }),
      );
      expect(mockSay).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'Final response\n\n```Ctx ▓▓▓░░ 42.0% +0.5```',
          thread_ts: 'thread_ts',
        }),
      );
    });

    it('should stop processing on abort', async () => {
      const messages = [
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Message 1' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Message 2' }] } },
      ];

      // Abort before processing
      abortController.abort();

      const processor = new StreamProcessor();
      const result = await processor.process(createMockStream(messages) as any, mockContext, abortController.signal);

      expect(result.aborted).toBe(true);
      expect(mockSay).not.toHaveBeenCalled();
    });

    it('should extract user choice from text', async () => {
      const choice = {
        type: 'user_choice',
        question: 'Which option?',
        choices: [
          { id: '1', label: 'Option 1' },
          { id: '2', label: 'Option 2' },
        ],
      };

      const messages = [
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: `Some text\n\`\`\`json\n${JSON.stringify(choice)}\n\`\`\`` }],
          },
        },
      ];

      const processor = new StreamProcessor();
      await processor.process(createMockStream(messages) as any, mockContext, abortController.signal);

      // Should send both the text and the choice blocks
      expect(mockSay).toHaveBeenCalledTimes(2);
      expect(mockSay).toHaveBeenNthCalledWith(1, expect.objectContaining({ text: 'Some text' }));
      expect(mockSay).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          text: 'Which option?',
          attachments: expect.any(Array),
        }),
      );
    });

    it('should handle multi-choice forms', async () => {
      const onPendingFormCreate = vi.fn();
      const getPendingForm = vi.fn().mockReturnValue({ formId: 'form_1', messageTs: '' });

      const choices = {
        type: 'user_choices',
        title: 'Multiple questions',
        questions: [
          { id: 'q1', question: 'Question 1', choices: [{ id: '1', label: 'A' }] },
          { id: 'q2', question: 'Question 2', choices: [{ id: '2', label: 'B' }] },
        ],
      };

      const messages = [
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(choices)}\n\`\`\`` }],
          },
        },
      ];

      const callbacks: StreamCallbacks = { onPendingFormCreate, getPendingForm };
      const processor = new StreamProcessor(callbacks);
      await processor.process(createMockStream(messages) as any, mockContext, abortController.signal);

      expect(onPendingFormCreate).toHaveBeenCalledWith(
        expect.stringMatching(/^form_/),
        expect.objectContaining({
          sessionKey: 'session_key',
          channel: 'C123',
          questions: choices.questions,
        }),
      );
    });

    it('should detect channel_message directive and forward callback', async () => {
      const onChannelMessageDetected = vi.fn();
      const messages = [
        {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'text',
                text: `Deploy complete.
\`\`\`json
{"type":"channel_message","text":"## Release Notes\\n- Deployed"}
\`\`\``,
              },
            ],
          },
        },
      ];

      const processor = new StreamProcessor({ onChannelMessageDetected });
      await processor.process(createMockStream(messages) as any, mockContext, abortController.signal);

      expect(onChannelMessageDetected).toHaveBeenCalledWith('## Release Notes\n- Deployed', mockContext);
      expect(mockSay).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'Deploy complete.',
          thread_ts: 'thread_ts',
        }),
      );
    });

    it('should not send empty thread message for directive-only channel_message output', async () => {
      const onChannelMessageDetected = vi.fn();
      const messages = [
        {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'text',
                text: `\`\`\`json
{"type":"channel_message","text":"Root post only"}
\`\`\``,
              },
            ],
          },
        },
      ];

      const processor = new StreamProcessor({ onChannelMessageDetected });
      await processor.process(createMockStream(messages) as any, mockContext, abortController.signal);

      expect(onChannelMessageDetected).toHaveBeenCalledWith('Root post only', mockContext);
      expect(mockSay).not.toHaveBeenCalled();
    });

    it('should not duplicate final result if already in currentMessages', async () => {
      const messages = [
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Same message' }] } },
        { type: 'result', subtype: 'success', result: 'Same message' },
      ];

      const processor = new StreamProcessor();
      await processor.process(createMockStream(messages) as any, mockContext, abortController.signal);

      // Should only be called once for the assistant message
      expect(mockSay).toHaveBeenCalledTimes(1);
    });
  });

  describe('error handling', () => {
    it('should return aborted=true on AbortError', async () => {
      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';

      const failingStream = async function* () {
        throw abortError;
      };

      const processor = new StreamProcessor();
      const result = await processor.process(failingStream() as any, mockContext, abortController.signal);

      expect(result.aborted).toBe(true);
    });

    it('should rethrow non-AbortError errors', async () => {
      const error = new Error('Some other error');

      const failingStream = async function* () {
        throw error;
      };

      const processor = new StreamProcessor();
      await expect(processor.process(failingStream() as any, mockContext, abortController.signal)).rejects.toThrow(
        'Some other error',
      );
    });
  });

  // Issue #122: System message handling + SDK result error
  describe('system message handling (Issue #122)', () => {
    it('should handle compact_boundary system message without throwing', async () => {
      const messages = [
        {
          type: 'system',
          subtype: 'compact_boundary',
          compact_metadata: {
            trigger: 'auto',
            pre_tokens: 150000,
          },
        },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'After compact' }],
          },
        },
      ];

      const onStatusUpdate = vi.fn().mockResolvedValue(undefined);
      const processor = new StreamProcessor({ onStatusUpdate });
      const result = await processor.process(createMockStream(messages) as any, mockContext, abortController.signal);

      expect(result.success).toBe(true);
      expect(result.messageCount).toBe(1);
      expect(onStatusUpdate).toHaveBeenCalledWith('working');
    });

    it('should handle status compacting system message', async () => {
      const messages = [
        {
          type: 'system',
          subtype: 'status',
          status: 'compacting',
        },
      ];

      const onStatusUpdate = vi.fn().mockResolvedValue(undefined);
      const processor = new StreamProcessor({ onStatusUpdate });
      const result = await processor.process(createMockStream(messages) as any, mockContext, abortController.signal);

      expect(result.success).toBe(true);
      expect(onStatusUpdate).toHaveBeenCalledWith('working');
    });

    it('should handle init system message without error', async () => {
      const messages = [
        {
          type: 'system',
          subtype: 'init',
          session_id: 'test-session',
          model: 'claude-opus-4-6',
        },
      ];

      const processor = new StreamProcessor();
      const result = await processor.process(createMockStream(messages) as any, mockContext, abortController.signal);

      expect(result.success).toBe(true);
    });

    it('should handle unknown system subtypes gracefully', async () => {
      const messages = [
        {
          type: 'system',
          subtype: 'some_future_subtype',
        },
      ];

      const processor = new StreamProcessor();
      const result = await processor.process(createMockStream(messages) as any, mockContext, abortController.signal);

      expect(result.success).toBe(true);
    });
  });

  describe('SDK result error handling (Issue #122)', () => {
    it('should capture error_during_execution in sdkResultError', async () => {
      const messages = [
        {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          num_turns: 5,
          errors: ['context window exceeded', 'prompt too long'],
          duration_ms: 10000,
          total_cost_usd: 0.5,
          stop_reason: null,
        },
      ];

      const processor = new StreamProcessor();
      const result = await processor.process(createMockStream(messages) as any, mockContext, abortController.signal);

      expect(result.success).toBe(true);
      expect(result.sdkResultError).toBeDefined();
      expect(result.sdkResultError!.subtype).toBe('error_during_execution');
      expect(result.sdkResultError!.errors).toEqual(['context window exceeded', 'prompt too long']);
      expect(result.sdkResultError!.numTurns).toBe(5);
    });

    it('should capture error_max_turns in sdkResultError', async () => {
      const messages = [
        {
          type: 'result',
          subtype: 'error_max_turns',
          is_error: true,
          num_turns: 25,
          errors: ['exceeded maximum turns'],
          duration_ms: 60000,
          total_cost_usd: 2.0,
          stop_reason: null,
        },
      ];

      const processor = new StreamProcessor();
      const result = await processor.process(createMockStream(messages) as any, mockContext, abortController.signal);

      expect(result.sdkResultError).toBeDefined();
      expect(result.sdkResultError!.subtype).toBe('error_max_turns');
    });

    it('should not set sdkResultError on success result', async () => {
      const messages = [
        {
          type: 'result',
          subtype: 'success',
          result: 'Done',
          duration_ms: 1000,
          total_cost_usd: 0.01,
          stop_reason: 'end_turn',
        },
      ];

      const processor = new StreamProcessor();
      const result = await processor.process(createMockStream(messages) as any, mockContext, abortController.signal);

      expect(result.sdkResultError).toBeUndefined();
    });

    it('should capture error with empty errors[] and fallback subtype', async () => {
      const messages = [
        {
          type: 'result',
          subtype: 'error_max_turns',
          is_error: true,
          num_turns: 25,
          errors: [],
          duration_ms: 60000,
          total_cost_usd: 2.0,
          stop_reason: null,
        },
      ];
      const processor = new StreamProcessor();
      const result = await processor.process(createMockStream(messages) as any, mockContext, abortController.signal);
      expect(result.sdkResultError).toBeDefined();
      expect(result.sdkResultError!.subtype).toBe('error_max_turns');
      expect(result.sdkResultError!.errors).toEqual([]);
    });

    it('should capture error_ prefix subtype even when is_error is false', async () => {
      const messages = [
        {
          type: 'result',
          subtype: 'error_max_budget_usd',
          is_error: false,
          num_turns: 10,
          errors: ['budget exceeded'],
          duration_ms: 30000,
          total_cost_usd: 5.0,
          stop_reason: null,
        },
      ];
      const processor = new StreamProcessor();
      const result = await processor.process(createMockStream(messages) as any, mockContext, abortController.signal);
      expect(result.sdkResultError).toBeDefined();
      expect(result.sdkResultError!.subtype).toBe('error_max_budget_usd');
    });

    it('should default subtype to error_during_execution when subtype is missing', async () => {
      const messages = [
        {
          type: 'result',
          is_error: true,
          num_turns: 1,
          errors: ['unknown failure'],
          duration_ms: 100,
          stop_reason: null,
        },
      ];
      const processor = new StreamProcessor();
      const result = await processor.process(createMockStream(messages) as any, mockContext, abortController.signal);
      expect(result.sdkResultError).toBeDefined();
      expect(result.sdkResultError!.subtype).toBe('error_during_execution');
    });

    it('should not call say or increment messageCount on error result', async () => {
      const messages = [
        {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          num_turns: 3,
          errors: ['failed'],
          duration_ms: 5000,
          stop_reason: null,
        },
      ];
      const processor = new StreamProcessor();
      const result = await processor.process(createMockStream(messages) as any, mockContext, abortController.signal);
      expect(result.messageCount).toBe(0);
      expect(mockSay).not.toHaveBeenCalled();
    });
  });
});
