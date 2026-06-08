/**
 * Golden tests for the SDK → neutral event mapper (epic #1023 P3).
 *
 * Each case pins a real `SDKMessage` shape to its exact `AgentStreamEvent`
 * sequence, mirroring the extraction logic in `stream-processor.ts`. The cost
 * calculator is injected as a deterministic stub so the cost-source rule is
 * asserted without coupling to the real pricing tables.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import { createSdkMessageMapper } from '../claude-code/sdk-message-to-event';

// Deterministic stub: cost = inputTokens * 0.01 (so a non-zero call is visible).
const CALC = (_model: string | undefined, input: number) => input * 0.01;

function mapper(calc = CALC) {
  return createSdkMessageMapper({ calculateTokenCost: calc });
}

// Build a structurally-typed SDK message (the mapper reads structurally).
function sdk(obj: unknown): SDKMessage {
  return obj as SDKMessage;
}

describe('createSdkMessageMapper — golden (epic #1023 P3)', () => {
  describe('assistant', () => {
    it('text-only → per-turn usage event then assistant_delta', () => {
      const events = mapper().map(
        sdk({
          type: 'assistant',
          message: {
            model: 'claude-sonnet-4-5',
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
            content: [{ type: 'text', text: 'hello world' }],
          },
        }),
      );
      expect(events).toEqual([
        {
          type: 'usage',
          usage: {
            lastTurnInputTokens: 10,
            lastTurnOutputTokens: 5,
            lastTurnCacheReadTokens: 2,
            lastTurnCacheCreateTokens: 1,
          },
        },
        { type: 'assistant_delta', text: 'hello world' },
      ]);
    });

    it('thinking + text → thought_delta before assistant_delta', () => {
      const events = mapper().map(
        sdk({
          type: 'assistant',
          message: {
            content: [
              { type: 'thinking', thinking: 'let me reason' },
              { type: 'text', text: 'answer' },
            ],
          },
        }),
      );
      expect(events).toEqual([
        { type: 'thought_delta', text: 'let me reason' },
        { type: 'assistant_delta', text: 'answer' },
      ]);
    });

    it('tool_use present → tool_call emitted and coexisting text dropped (parity with handleToolUseMessage)', () => {
      const events = mapper().map(
        sdk({
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'this text must be dropped' },
              { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } },
            ],
          },
        }),
      );
      expect(events).toEqual([{ type: 'tool_call', toolCallId: 'tu_1', name: 'Bash', input: { command: 'ls' } }]);
    });

    it('thinking + tool_use → thought_delta then tool_call (text still dropped)', () => {
      const events = mapper().map(
        sdk({
          type: 'assistant',
          message: {
            content: [
              { type: 'thinking', thinking: 'plan' },
              { type: 'text', text: 'dropped' },
              { type: 'tool_use', id: 'tu_2', name: 'Read', input: { file_path: '/x' } },
            ],
          },
        }),
      );
      expect(events).toEqual([
        { type: 'thought_delta', text: 'plan' },
        { type: 'tool_call', toolCallId: 'tu_2', name: 'Read', input: { file_path: '/x' } },
      ]);
    });
  });

  describe('user (tool results)', () => {
    it('tool_result block → tool_result event with normalized content', () => {
      const events = mapper().map(
        sdk({
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu_1',
                is_error: false,
                content: [{ type: 'text', text: 'file contents' }],
              },
            ],
          },
        }),
      );
      expect(events).toEqual([
        {
          type: 'tool_result',
          toolCallId: 'tu_1',
          content: [{ type: 'text', text: 'file contents' }],
          isError: false,
          rawOutput: [{ type: 'text', text: 'file contents' }],
        },
      ]);
    });

    it('string tool_result content → single text AgentContent; is_error true preserved', () => {
      const events = mapper().map(
        sdk({
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 'tu_9', is_error: true, content: 'boom' }] },
        }),
      );
      expect(events).toEqual([
        {
          type: 'tool_result',
          toolCallId: 'tu_9',
          content: [{ type: 'text', text: 'boom' }],
          isError: true,
          rawOutput: 'boom',
        },
      ]);
    });
  });

  describe('result', () => {
    it('success → cumulative usage then result with finalText and stopReason', () => {
      const events = mapper().map(
        sdk({
          type: 'result',
          subtype: 'success',
          result: 'final answer',
          stop_reason: 'end_turn',
          duration_ms: 1234,
          total_cost_usd: 0.5,
          usage: { input_tokens: 100, output_tokens: 40 },
        }),
      );
      expect(events[0]).toEqual({
        type: 'usage',
        usage: {
          inputTokens: 100,
          outputTokens: 40,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          totalCostUsd: 0.5,
          costSource: 'sdk',
          modelName: undefined,
        },
      });
      expect(events[1]).toMatchObject({
        type: 'result',
        stopReason: 'end_turn',
        finalText: 'final answer',
        durationMs: 1234,
      });
    });

    it('error subtype → result.error populated, stopReason defaults end_turn', () => {
      const events = mapper().map(
        sdk({
          type: 'result',
          subtype: 'error_max_turns',
          is_error: true,
          num_turns: 12,
          errors: ['too many turns'],
          stop_reason: null,
        }),
      );
      const result = events.find((e) => e.type === 'result');
      expect(result).toEqual({
        type: 'result',
        stopReason: 'end_turn',
        durationMs: undefined,
        usage: undefined,
        error: { subtype: 'error_max_turns', errors: ['too many turns'], numTurns: 12 },
      });
    });

    it('unknown stop_reason falls back to end_turn; known tool_use preserved', () => {
      const a = mapper().map(sdk({ type: 'result', subtype: 'success', result: 'x', stop_reason: 'banana' }));
      expect(a.find((e) => e.type === 'result')).toMatchObject({ stopReason: 'end_turn' });
      const b = mapper().map(sdk({ type: 'result', subtype: 'success', result: 'x', stop_reason: 'tool_use' }));
      expect(b.find((e) => e.type === 'result')).toMatchObject({ stopReason: 'tool_use' });
    });
  });

  describe('usage cost-source rule', () => {
    it('modelUsage: all SDK-priced → costSource sdk; aggregates across models', () => {
      const events = mapper().map(
        sdk({
          type: 'result',
          subtype: 'success',
          result: 'x',
          modelUsage: {
            'claude-sonnet-4-5': {
              inputTokens: 10,
              outputTokens: 5,
              cacheReadInputTokens: 1,
              cacheCreationInputTokens: 0,
              costUSD: 0.2,
              contextWindow: 200000,
            },
            'claude-haiku-4-5': { inputTokens: 4, outputTokens: 2, costUSD: 0.05 },
          },
        }),
      );
      const usage = events.find((e) => e.type === 'usage');
      expect(usage).toMatchObject({
        type: 'usage',
        usage: {
          inputTokens: 14,
          outputTokens: 7,
          cacheReadInputTokens: 1,
          totalCostUsd: 0.25,
          costSource: 'sdk',
          contextWindow: 200000,
          modelName: 'claude-sonnet-4-5',
        },
      });
    });

    it('modelUsage: a model lacking costUSD → calculated path flips costSource to calculated', () => {
      const calc = vi.fn((_m: string | undefined, input: number) => input * 0.01);
      const events = mapper(calc).map(
        sdk({
          type: 'result',
          subtype: 'success',
          result: 'x',
          modelUsage: { 'claude-sonnet-4-5': { inputTokens: 100, outputTokens: 10 } },
        }),
      );
      const usage = events.find((e) => e.type === 'usage');
      expect(usage).toMatchObject({ usage: { costSource: 'calculated', totalCostUsd: 1 } });
      expect(calc).toHaveBeenCalledWith('claude-sonnet-4-5', 100, 10, 0, 0);
    });

    it('direct usage: total_cost_usd>0 → sdk; zero → calculated via injected calc and lastAssistantModelName', () => {
      const m = mapper();
      // Prime lastAssistantModelName via a prior assistant message.
      m.map(sdk({ type: 'assistant', message: { model: 'claude-opus-4-8', content: [] } }));
      const events = m.map(
        sdk({ type: 'result', subtype: 'success', result: 'x', usage: { input_tokens: 50, output_tokens: 5 } }),
      );
      const usage = events.find((e) => e.type === 'usage');
      expect(usage).toMatchObject({
        usage: { costSource: 'calculated', totalCostUsd: 0.5, modelName: 'claude-opus-4-8' },
      });
    });
  });

  describe('system', () => {
    it('compact_boundary → compact_boundary (snake→camel) then status compact_done', () => {
      const events = mapper().map(
        sdk({
          type: 'system',
          subtype: 'compact_boundary',
          compact_metadata: { trigger: 'auto', pre_tokens: 180000, post_tokens: 20000, preserved_segment: 'tail' },
        }),
      );
      expect(events).toEqual([
        {
          type: 'compact_boundary',
          metadata: {
            trigger: 'auto',
            preTokens: 180000,
            postTokens: 20000,
            preservedSegment: 'tail',
            raw: { trigger: 'auto', pre_tokens: 180000, post_tokens: 20000, preserved_segment: 'tail' },
          },
        },
        { type: 'status', status: 'compact_done' },
      ]);
    });

    it('status compacting → status compacting; other status → no event', () => {
      expect(mapper().map(sdk({ type: 'system', subtype: 'status', status: 'compacting' }))).toEqual([
        { type: 'status', status: 'compacting' },
      ]);
      expect(mapper().map(sdk({ type: 'system', subtype: 'status', status: 'thinking' }))).toEqual([]);
    });

    it('init → session_start with sessionId/model/tools', () => {
      expect(
        mapper().map(
          sdk({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-sonnet-4-5', tools: ['Bash'] }),
        ),
      ).toEqual([{ type: 'session_start', sessionId: 'sess-1', model: 'claude-sonnet-4-5', tools: ['Bash'] }]);
    });

    it('unhandled system subtype → no events', () => {
      expect(mapper().map(sdk({ type: 'system', subtype: 'something_else' }))).toEqual([]);
    });
  });

  describe('background task lifecycle (authoritative SDK signal)', () => {
    it('task_started → agent_task_lifecycle started (taskId/toolUseId/taskType)', () => {
      expect(
        mapper().map(
          sdk({
            type: 'system',
            subtype: 'task_started',
            task_id: 'bb818onz1',
            tool_use_id: 'toolu_1',
            task_type: 'bash',
          }),
        ),
      ).toEqual([
        { type: 'agent_task_lifecycle', phase: 'started', taskId: 'bb818onz1', toolUseId: 'toolu_1', taskType: 'bash' },
      ]);
    });

    it('task_started without task_id → no event', () => {
      expect(mapper().map(sdk({ type: 'system', subtype: 'task_started' }))).toEqual([]);
    });

    it('task_progress → agent_task_lifecycle progress', () => {
      expect(mapper().map(sdk({ type: 'system', subtype: 'task_progress', task_id: 'b1', tool_use_id: 'u1' }))).toEqual(
        [{ type: 'agent_task_lifecycle', phase: 'progress', taskId: 'b1', toolUseId: 'u1' }],
      );
    });

    it('task_notification (completed) → agent_task_lifecycle settled with outputFile/summary', () => {
      expect(
        mapper().map(
          sdk({
            type: 'system',
            subtype: 'task_notification',
            task_id: 'bb818onz1',
            tool_use_id: 'toolu_1',
            status: 'completed',
            output_file: '/tmp/bb818onz1.output',
            summary: 'done',
          }),
        ),
      ).toEqual([
        {
          type: 'agent_task_lifecycle',
          phase: 'settled',
          taskId: 'bb818onz1',
          toolUseId: 'toolu_1',
          status: 'completed',
          outputFile: '/tmp/bb818onz1.output',
          summary: 'done',
        },
      ]);
    });

    it('task_notification failed/stopped → settled; unknown status → no event', () => {
      expect(
        mapper().map(sdk({ type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'failed' }))[0],
      ).toMatchObject({ phase: 'settled', status: 'failed' });
      expect(
        mapper().map(sdk({ type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'stopped' }))[0],
      ).toMatchObject({ phase: 'settled', status: 'stopped' });
      expect(
        mapper().map(sdk({ type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'running' })),
      ).toEqual([]);
    });

    it('task_updated terminal patch.status → settled (killed → stopped); non-terminal → no event', () => {
      expect(
        mapper().map(sdk({ type: 'system', subtype: 'task_updated', task_id: 'b1', patch: { status: 'killed' } })),
      ).toEqual([{ type: 'agent_task_lifecycle', phase: 'settled', taskId: 'b1', status: 'stopped' }]);
      expect(
        mapper().map(
          sdk({ type: 'system', subtype: 'task_updated', task_id: 'b1', patch: { status: 'completed' } }),
        )[0],
      ).toMatchObject({ phase: 'settled', status: 'completed' });
      expect(
        mapper().map(sdk({ type: 'system', subtype: 'task_updated', task_id: 'b1', patch: { status: 'running' } })),
      ).toEqual([]);
    });
  });
});
