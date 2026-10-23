/**
 * Spec 12 (agent tree) §2.1 — the mapper keeps WHO made a frame.
 *
 * A subagent's frames carry `parent_tool_use_id` = the id of the `Agent` (or
 * legacy `Task`) tool call that started it. Before spec 12 the mapper dropped
 * it, so every consumer filed a subagent's tool calls, TodoWrite lists and
 * usage under the main agent. The neutral events now carry it as
 * `parentToolUseId`; a main-agent frame carries none (the key is absent).
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { createSdkMessageMapper } from '../claude-code/sdk-message-to-event';

const mapper = () => createSdkMessageMapper({ calculateTokenCost: () => 0 });
const sdk = (obj: unknown) => obj as SDKMessage;

describe('sdk-message-to-event — subagent attribution (spec 12 §2.1)', () => {
  it('stamps tool_call and per-call usage of a subagent frame with its parent tool use id', () => {
    const events = mapper().map(
      sdk({
        type: 'assistant',
        parent_tool_use_id: 'toolu_agent_1',
        message: {
          id: 'msg_sub',
          usage: { input_tokens: 4, output_tokens: 1 },
          content: [{ type: 'tool_use', id: 'tu_sub_read', name: 'Read', input: { file_path: '/a.ts' } }],
        },
      }),
    );
    const call = events.find((e) => e.type === 'tool_call');
    expect(call).toMatchObject({ toolCallId: 'tu_sub_read', name: 'Read', parentToolUseId: 'toolu_agent_1' });
    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toMatchObject({ parentToolUseId: 'toolu_agent_1' });
  });

  it('stamps a subagent tool_result', () => {
    const events = mapper().map(
      sdk({
        type: 'user',
        parent_tool_use_id: 'toolu_agent_1',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu_sub_read', content: 'file body' }] },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'tool_result',
      toolCallId: 'tu_sub_read',
      parentToolUseId: 'toolu_agent_1',
    });
  });

  it('stamps forwarded subagent text and thinking', () => {
    const events = mapper().map(
      sdk({
        type: 'assistant',
        parent_tool_use_id: 'toolu_agent_2',
        message: {
          content: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'text', text: 'Reading the parser next.' },
          ],
        },
      }),
    );
    expect(events).toEqual([
      { type: 'thought_delta', text: 'hmm', parentToolUseId: 'toolu_agent_2' },
      { type: 'assistant_delta', text: 'Reading the parser next.', parentToolUseId: 'toolu_agent_2' },
    ]);
  });

  it('carries the structured outcome of an Agent tool result (tool_use_result.status)', () => {
    const launched = mapper().map(
      sdk({
        type: 'user',
        parent_tool_use_id: null,
        tool_use_result: { status: 'async_launched', agentId: 'a1', description: 'x', prompt: 'p', outputFile: '/o' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_bg', content: 'Async agent launched' }] },
      }),
    );
    expect(launched[0]).toMatchObject({ type: 'tool_result', agentOutcome: { status: 'async_launched' } });
    const done = mapper().map(
      sdk({
        type: 'user',
        parent_tool_use_id: null,
        tool_use_result: {
          status: 'completed',
          agentId: 'a2',
          agentType: 'Explore',
          content: [{ type: 'text', text: 'report' }],
          totalToolUseCount: 17,
          totalDurationMs: 94300,
          totalTokens: 56600,
          prompt: 'p',
        },
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_fg', content: 'report' }] },
      }),
    );
    expect(done[0]).toMatchObject({ agentOutcome: { status: 'completed', toolUses: 17, durationMs: 94300 } });
    // Any other tool's structured output is not an agent outcome.
    const bash = mapper().map(
      sdk({
        type: 'user',
        parent_tool_use_id: null,
        tool_use_result: { stdout: 'x', stderr: '', interrupted: false },
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu_bash', content: 'x' }] },
      }),
    );
    expect('agentOutcome' in (bash[0] as object)).toBe(false);
  });

  it('a main-agent frame (null or absent parent) carries no parentToolUseId key', () => {
    for (const parent of [null, undefined, '']) {
      const events = mapper().map(
        sdk({
          type: 'assistant',
          ...(parent === undefined ? {} : { parent_tool_use_id: parent }),
          message: { content: [{ type: 'tool_use', id: 'tu_main', name: 'Bash', input: { command: 'ls' } }] },
        }),
      );
      const call = events.find((e) => e.type === 'tool_call') as Record<string, unknown>;
      expect(call).toBeDefined();
      expect('parentToolUseId' in call).toBe(false);
    }
  });

  it('task lifecycle carries the subagent type, description, background flag, usage and last tool', () => {
    const m = mapper();
    expect(
      m.map(
        sdk({
          type: 'system',
          subtype: 'task_started',
          task_id: 'task_1',
          tool_use_id: 'toolu_agent_1',
          description: 'Trace subagent frames',
          subagent_type: 'Explore',
          task_type: 'local_agent',
          is_backgrounded: true,
        }),
      ),
    ).toEqual([
      {
        type: 'agent_task_lifecycle',
        phase: 'started',
        taskId: 'task_1',
        toolUseId: 'toolu_agent_1',
        taskType: 'local_agent',
        subagentType: 'Explore',
        description: 'Trace subagent frames',
        background: true,
      },
    ]);
    expect(
      m.map(
        sdk({
          type: 'system',
          subtype: 'task_progress',
          task_id: 'task_1',
          tool_use_id: 'toolu_agent_1',
          description: 'Trace subagent frames',
          usage: { total_tokens: 1200, tool_uses: 7, duration_ms: 41000 },
          last_tool_name: 'Grep',
          summary: 'Reading the stream processor',
        }),
      ),
    ).toEqual([
      {
        type: 'agent_task_lifecycle',
        phase: 'progress',
        taskId: 'task_1',
        toolUseId: 'toolu_agent_1',
        description: 'Trace subagent frames',
        usage: { totalTokens: 1200, toolUses: 7, durationMs: 41000 },
        lastToolName: 'Grep',
        summary: 'Reading the stream processor',
      },
    ]);
    expect(
      m.map(
        sdk({
          type: 'system',
          subtype: 'task_notification',
          task_id: 'task_1',
          tool_use_id: 'toolu_agent_1',
          status: 'failed',
          output_file: '/tmp/o',
          summary: 'Agent failed',
          usage: { total_tokens: 1500, tool_uses: 9, duration_ms: 60000 },
        }),
      ),
    ).toEqual([
      {
        type: 'agent_task_lifecycle',
        phase: 'settled',
        taskId: 'task_1',
        toolUseId: 'toolu_agent_1',
        status: 'failed',
        outputFile: '/tmp/o',
        summary: 'Agent failed',
        usage: { totalTokens: 1500, toolUses: 9, durationMs: 60000 },
      },
    ]);
  });
});
