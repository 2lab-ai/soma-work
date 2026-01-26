/**
 * StreamProcessor tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StreamProcessor, StreamContext, StreamCallbacks, PendingForm, SayFunction } from './stream-processor';

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
      const result = await processor.process(
        createMockStream(messages) as any,
        mockContext,
        abortController.signal
      );

      expect(result.success).toBe(true);
      expect(result.messageCount).toBe(1);
      expect(result.aborted).toBe(false);
      expect(mockSay).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'Hello, world!',
          thread_ts: 'thread_ts',
        })
      );
    });

    it('should process tool use messages and call onToolUse callback', async () => {
      const onToolUse = vi.fn();
      const messages = [
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 'tool_1', name: 'Read', input: { file_path: '/test.txt' } },
            ],
          },
        },
      ];

      const callbacks: StreamCallbacks = { onToolUse };
      const processor = new StreamProcessor(callbacks);
      await processor.process(
        createMockStream(messages) as any,
        mockContext,
        abortController.signal
      );

      expect(onToolUse).toHaveBeenCalledWith(
        [{ id: 'tool_1', name: 'Read', input: { file_path: '/test.txt' } }],
        mockContext
      );
    });

    it('should call onTodoUpdate for TodoWrite tool', async () => {
      const onTodoUpdate = vi.fn();
      const messages = [
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 'tool_1', name: 'TodoWrite', input: { todos: [{ content: 'Test' }] } },
            ],
          },
        },
      ];

      const callbacks: StreamCallbacks = { onTodoUpdate };
      const processor = new StreamProcessor(callbacks);
      await processor.process(
        createMockStream(messages) as any,
        mockContext,
        abortController.signal
      );

      expect(onTodoUpdate).toHaveBeenCalledWith(
        { todos: [{ content: 'Test' }] },
        mockContext
      );
    });

    it('should process user messages with tool results', async () => {
      const onToolResult = vi.fn();
      const messages = [
        {
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'tool_1', content: 'result data' },
            ],
          },
        },
      ];

      const callbacks: StreamCallbacks = { onToolResult };
      const processor = new StreamProcessor(callbacks);
      await processor.process(
        createMockStream(messages) as any,
        mockContext,
        abortController.signal
      );

      expect(onToolResult).toHaveBeenCalledWith(
        [{ toolUseId: 'tool_1', result: 'result data', isError: undefined, toolName: undefined }],
        mockContext
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
      await processor.process(
        createMockStream(messages) as any,
        mockContext,
        abortController.signal
      );

      expect(mockSay).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'Final response',
          thread_ts: 'thread_ts',
        })
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
      const result = await processor.process(
        createMockStream(messages) as any,
        mockContext,
        abortController.signal
      );

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
      await processor.process(
        createMockStream(messages) as any,
        mockContext,
        abortController.signal
      );

      // Should send both the text and the choice blocks
      expect(mockSay).toHaveBeenCalledTimes(2);
      expect(mockSay).toHaveBeenNthCalledWith(1, expect.objectContaining({ text: 'Some text' }));
      expect(mockSay).toHaveBeenNthCalledWith(2, expect.objectContaining({
        text: 'Which option?',
        attachments: expect.any(Array),
      }));
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
      await processor.process(
        createMockStream(messages) as any,
        mockContext,
        abortController.signal
      );

      expect(onPendingFormCreate).toHaveBeenCalledWith(
        expect.stringMatching(/^form_/),
        expect.objectContaining({
          sessionKey: 'session_key',
          channel: 'C123',
          questions: choices.questions,
        })
      );
    });

    it('should not duplicate final result if already in currentMessages', async () => {
      const messages = [
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Same message' }] } },
        { type: 'result', subtype: 'success', result: 'Same message' },
      ];

      const processor = new StreamProcessor();
      await processor.process(
        createMockStream(messages) as any,
        mockContext,
        abortController.signal
      );

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
      const result = await processor.process(
        failingStream() as any,
        mockContext,
        abortController.signal
      );

      expect(result.aborted).toBe(true);
    });

    it('should rethrow non-AbortError errors', async () => {
      const error = new Error('Some other error');

      const failingStream = async function* () {
        throw error;
      };

      const processor = new StreamProcessor();
      await expect(
        processor.process(failingStream() as any, mockContext, abortController.signal)
      ).rejects.toThrow('Some other error');
    });
  });
});
