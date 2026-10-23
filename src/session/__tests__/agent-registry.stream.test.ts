/**
 * Spec 12 — the stream processor and the agent registry together, in the order
 * the SDK really delivers frames (review round 2, astra repro). A tool call
 * waits in the processor's render buffer; the SDK's task lifecycle does not.
 */
import { AgentStreamProcessor } from '@soma/slack/stream-processor';
import { describe, expect, it } from 'vitest';
import {
  AGENT_REGISTRY_MAX,
  type AgentRegistry,
  agentById,
  applyAgentEvent,
  stampWorkLogAgent,
} from '../agent-registry';

// biome-ignore lint/suspicious/noExplicitAny: neutral events as plain objects
type Ev = any;

async function run(events: Ev[], abortAfter?: number) {
  const holder: { agents?: AgentRegistry } = {};
  const abort = new AbortController();
  async function* stream() {
    let i = 0;
    for (const e of events) {
      yield e;
      if (++i === abortAfter) abort.abort();
    }
  }
  await new AgentStreamProcessor({ onAgentEvent: (e) => applyAgentEvent(holder, e) }).process(
    stream(),
    {
      channel: 'C',
      threadTs: 'T',
      sessionKey: 'C:T',
      sessionId: 's',
      incidentAttempt: false,
      logVerbosity: 0,
      say: async () => ({ ts: 'm' }),
      workLog: (e: Ev) => {
        stampWorkLogAgent(holder, e, Date.now());
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal StreamContext
    } as any,
    abort.signal,
  );
  return holder.agents;
}

const SPAWN: Ev = {
  type: 'tool_call',
  name: 'Agent',
  toolCallId: 'agent',
  input: { description: 'x', run_in_background: true },
};
const RESULT: Ev = { type: 'result', stopReason: 'end_turn', finalText: 'done' };

describe('agent tree end to end (review round 2)', () => {
  it('task_started that overtakes the buffered spawn call still links the task — the later settle lands', async () => {
    const reg = await run([
      SPAWN,
      { type: 'agent_task_lifecycle', phase: 'started', taskId: 'task', toolUseId: 'agent', taskType: 'local_agent' },
      { type: 'tool_result', toolCallId: 'agent', content: [], agentOutcome: { status: 'async_launched' } },
      { type: 'agent_task_lifecycle', phase: 'settled', taskId: 'task', status: 'stopped' },
      RESULT,
    ]);
    expect(agentById(reg, 'agent')).toMatchObject({ taskId: 'task', status: 'stopped' });
  });

  it('one tool call counted by both the log and the SDK is one call', async () => {
    const reg = await run([
      SPAWN,
      { type: 'tool_result', toolCallId: 'agent', content: [], agentOutcome: { status: 'async_launched' } },
      { type: 'tool_call', toolCallId: 'read1', name: 'Read', input: { file_path: '/a' }, parentToolUseId: 'agent' },
      {
        type: 'agent_task_lifecycle',
        phase: 'progress',
        taskId: 'task',
        toolUseId: 'agent',
        usage: { totalTokens: 10, toolUses: 1, durationMs: 20 },
      },
      { type: 'tool_result', toolCallId: 'read1', content: [], parentToolUseId: 'agent' },
      RESULT,
    ]);
    expect(agentById(reg, 'agent')?.toolCalls).toBe(1);
  });

  it('a failed background launch reads failed', async () => {
    const reg = await run([
      SPAWN,
      {
        type: 'tool_result',
        toolCallId: 'agent',
        isError: true,
        content: [{ type: 'text', text: 'No agent of that type' }],
      },
      RESULT,
    ]);
    expect(agentById(reg, 'agent')?.status).toBe('failed');
  });

  it('a stopped turn leaves its foreground agent out of sight, not running', async () => {
    const reg = await run(
      [
        { ...SPAWN, input: {} },
        { type: 'usage', usage: { lastTurnInputTokens: 1 } },
      ],
      2,
    );
    expect(agentById(reg, 'agent')?.status).toBe('unknown');
  });

  it('once the agents that held the bound open finish, the excess is released', () => {
    const h: { agents?: AgentRegistry } = {};
    for (let i = 0; i < AGENT_REGISTRY_MAX + 5; i++) applyAgentEvent(h, { kind: 'spawn', agentId: `a${i}`, ts: 100 });
    expect(h.agents?.agents.length).toBe(AGENT_REGISTRY_MAX + 5);
    for (let i = 0; i < AGENT_REGISTRY_MAX + 5; i++)
      applyAgentEvent(h, { kind: 'returned', agentId: `a${i}`, ok: true, ack: false, ts: 200 });
    expect(h.agents?.agents.length).toBe(AGENT_REGISTRY_MAX);
  });

  it('a child spawned after its parent finished keeps the parent', () => {
    const h: { agents?: AgentRegistry } = {};
    for (let i = 0; i < AGENT_REGISTRY_MAX; i++) {
      applyAgentEvent(h, { kind: 'spawn', agentId: `a${i}`, ts: 100 + i });
      applyAgentEvent(h, { kind: 'returned', agentId: `a${i}`, ok: true, ack: false, ts: 200 + i });
    }
    applyAgentEvent(h, { kind: 'spawn', agentId: 'child', parentAgentId: 'a0', background: true, ts: 900 });
    expect(agentById(h.agents, 'a0')).toBeDefined();
    expect(agentById(h.agents, 'child')?.parentId).toBe('a0');
  });
});
