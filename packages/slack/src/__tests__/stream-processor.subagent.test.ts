/**
 * Spec 12 (agent tree) §2.2 — the stream processor keeps a subagent's work
 * apart from the main agent's.
 *
 * Before spec 12 a subagent's TodoWrite replaced the main agent's task list
 * (Slack plan block and dashboard ledger), its tool calls were filed in the
 * main agent's work log, and its per-call usage was read as the main
 * agent's context occupancy. Every frame now carries `parentToolUseId`
 * (absent = main) and the processor routes by it:
 *
 *   - a main TodoWrite → `onTodoUpdate` (Slack plan + main ledger), as before;
 *     a subagent TodoWrite → `onAgentEvent({ kind: 'todos' })` only;
 *   - an `Agent` / `Task` call → `onAgentEvent({ kind: 'spawn' })` and a work
 *     log `tool` entry with `agentRef` = the new agent; its result → `returned`;
 *   - a subagent's tool / tool_result / narration → work log with `agentId`;
 *   - a subagent's per-call usage → live totals (`sidechain`), never the main
 *     agent's last-turn usage;
 *   - task lifecycle → `onAgentEvent({ kind: 'lifecycle' })`;
 *   - the turn's end → `onAgentEvent({ kind: 'turn_end' })`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentStreamEvent } from '../agent-stream-types';
import type { AgentTreeEvent } from '../agent-tree';
import { LOG_MINIMAL } from '../output-flags';
import { AgentStreamProcessor, type StreamCallbacks, type StreamContext } from '../stream-processor';
import type { WorkLogInput } from '../work-log';

async function* events(list: AgentStreamEvent[]): AsyncGenerator<AgentStreamEvent> {
  for (const event of list) yield event;
}

interface Run {
  log: WorkLogInput[];
  agentEvents: AgentTreeEvent[];
  todoUpdates: unknown[];
  live: unknown[];
  usage: unknown[];
  say: ReturnType<typeof vi.fn>;
  collectedText?: string;
}

async function run(list: AgentStreamEvent[], extra: Partial<StreamCallbacks> = {}): Promise<Run> {
  const r: Run = { log: [], agentEvents: [], todoUpdates: [], live: [], usage: [], say: vi.fn() };
  r.say.mockResolvedValue({ ts: 'm' });
  const context: StreamContext = {
    channel: 'C1',
    threadTs: 'T1',
    sessionKey: 'C1:T1',
    sessionId: 's1',
    incidentAttempt: false,
    logVerbosity: LOG_MINIMAL,
    say: r.say as unknown as StreamContext['say'],
    workLog: (entry) => {
      r.log.push(entry);
    },
  };
  const result = await new AgentStreamProcessor({
    onTodoUpdate: async (input) => {
      r.todoUpdates.push(input);
    },
    onAgentEvent: (e) => {
      r.agentEvents.push(e);
    },
    onLiveUsage: (c) => {
      r.live.push(c);
    },
    onUsageUpdate: (u) => {
      r.usage.push(u);
    },
    ...extra,
  }).process(events(list), context, new AbortController().signal);
  r.collectedText = (result as { collectedText?: string }).collectedText;
  return r;
}

const MAIN_TODOS = { todos: [{ content: 'Main plan step', status: 'in_progress', activeForm: 'Planning' }] };
const SUB_TODOS = { todos: [{ content: 'Sub step', status: 'in_progress', activeForm: 'Subbing' }] };
const SPAWN_INPUT = {
  description: 'Trace subagent frames',
  subagent_type: 'Explore',
  prompt: 'Find where parent_tool_use_id is dropped',
};

describe('stream-processor — subagent routing (spec 12 §2.2)', () => {
  it("a subagent's TodoWrite never reaches the main task list; it goes to that agent", async () => {
    const r = await run([
      { type: 'tool_call', toolCallId: 'tu_main_todo', name: 'TodoWrite', input: MAIN_TODOS },
      { type: 'tool_result', toolCallId: 'tu_main_todo', content: [{ type: 'text', text: 'ok' }] },
      { type: 'tool_call', toolCallId: 'toolu_agent_1', name: 'Agent', input: SPAWN_INPUT },
      {
        type: 'tool_call',
        toolCallId: 'tu_sub_todo',
        name: 'TodoWrite',
        input: SUB_TODOS,
        parentToolUseId: 'toolu_agent_1',
      },
      {
        type: 'tool_result',
        toolCallId: 'tu_sub_todo',
        content: [{ type: 'text', text: 'ok' }],
        parentToolUseId: 'toolu_agent_1',
      },
      { type: 'tool_result', toolCallId: 'toolu_agent_1', content: [{ type: 'text', text: 'Found it.' }] },
      { type: 'result', stopReason: 'end_turn', finalText: 'done' },
    ]);
    expect(r.todoUpdates).toEqual([MAIN_TODOS]);
    expect(r.agentEvents).toContainEqual(
      expect.objectContaining({ kind: 'todos', agentId: 'toolu_agent_1', todos: SUB_TODOS.todos }),
    );
  });

  it('an Agent call spawns an agent, and its own entries carry agentRef; the result returns it', async () => {
    const r = await run([
      { type: 'tool_call', toolCallId: 'toolu_agent_1', name: 'Agent', input: SPAWN_INPUT },
      { type: 'tool_result', toolCallId: 'toolu_agent_1', content: [{ type: 'text', text: 'Found it.' }] },
      { type: 'result', stopReason: 'end_turn', finalText: 'done' },
    ]);
    expect(r.agentEvents[0]).toMatchObject({
      kind: 'spawn',
      agentId: 'toolu_agent_1',
      agentType: 'Explore',
      description: 'Trace subagent frames',
      background: false,
    });
    expect((r.agentEvents[0] as { parentAgentId?: string }).parentAgentId).toBeUndefined();
    const spawnEntry = r.log.find((e) => e.kind === 'tool' && e.tool === 'Agent');
    expect(spawnEntry).toMatchObject({ agentRef: 'toolu_agent_1' });
    expect(spawnEntry?.agentId).toBeUndefined();
    const resultEntry = r.log.find((e) => e.kind === 'tool_result' && e.tool === 'Agent');
    expect(resultEntry).toMatchObject({ agentRef: 'toolu_agent_1', ok: true });
    expect(r.agentEvents).toContainEqual(
      expect.objectContaining({ kind: 'returned', agentId: 'toolu_agent_1', ok: true, ack: false }),
    );
  });

  it('the legacy Task tool name spawns too', async () => {
    const r = await run([
      { type: 'tool_call', toolCallId: 'toolu_task_1', name: 'Task', input: SPAWN_INPUT },
      { type: 'result', stopReason: 'end_turn', finalText: 'done' },
    ]);
    expect(r.agentEvents[0]).toMatchObject({ kind: 'spawn', agentId: 'toolu_task_1' });
  });

  it('the structured outcome decides: async_launched is an acknowledgement even without run_in_background', async () => {
    const r = await run([
      { type: 'tool_call', toolCallId: 'toolu_x', name: 'Agent', input: SPAWN_INPUT },
      {
        type: 'tool_result',
        toolCallId: 'toolu_x',
        content: [{ type: 'text', text: 'launched' }],
        agentOutcome: { status: 'async_launched' },
      },
      { type: 'result', stopReason: 'end_turn', finalText: 'done' },
    ]);
    expect(r.agentEvents).toContainEqual(expect.objectContaining({ kind: 'returned', agentId: 'toolu_x', ack: true }));
  });

  it('a completed outcome carries the run totals', async () => {
    const r = await run([
      { type: 'tool_call', toolCallId: 'toolu_y', name: 'Agent', input: SPAWN_INPUT },
      {
        type: 'tool_result',
        toolCallId: 'toolu_y',
        content: [{ type: 'text', text: 'report' }],
        agentOutcome: { status: 'completed', toolUses: 17, durationMs: 94300 },
      },
      { type: 'result', stopReason: 'end_turn', finalText: 'done' },
    ]);
    expect(r.agentEvents).toContainEqual(
      expect.objectContaining({
        kind: 'returned',
        agentId: 'toolu_y',
        ok: true,
        ack: false,
        toolUses: 17,
        durationMs: 94300,
      }),
    );
  });

  it("a background spawn's tool result is an acknowledgement, not the agent's result", async () => {
    const r = await run([
      {
        type: 'tool_call',
        toolCallId: 'toolu_bg',
        name: 'Agent',
        input: { ...SPAWN_INPUT, run_in_background: true },
      },
      {
        type: 'tool_result',
        toolCallId: 'toolu_bg',
        content: [{ type: 'text', text: 'Async agent launched successfully. The agent is working in the background.' }],
      },
      { type: 'result', stopReason: 'end_turn', finalText: 'done' },
    ]);
    expect(r.agentEvents[0]).toMatchObject({ kind: 'spawn', agentId: 'toolu_bg', background: true });
    expect(r.agentEvents).toContainEqual(expect.objectContaining({ kind: 'returned', agentId: 'toolu_bg', ack: true }));
  });

  it("a subagent's tool calls, results and narration are filed under that agent, nested spawns under their parent", async () => {
    const r = await run([
      { type: 'tool_call', toolCallId: 'toolu_agent_1', name: 'Agent', input: SPAWN_INPUT },
      {
        type: 'tool_call',
        toolCallId: 'tu_sub_grep',
        name: 'Grep',
        input: { pattern: 'parent_tool_use_id' },
        parentToolUseId: 'toolu_agent_1',
      },
      {
        type: 'tool_result',
        toolCallId: 'tu_sub_grep',
        content: [{ type: 'text', text: 'src/a.ts:1' }],
        parentToolUseId: 'toolu_agent_1',
      },
      { type: 'assistant_delta', text: 'Checking the mapper next.', parentToolUseId: 'toolu_agent_1' },
      {
        type: 'tool_call',
        toolCallId: 'toolu_nested',
        name: 'Agent',
        input: { description: 'Nested look', subagent_type: 'general-purpose', prompt: 'x' },
        parentToolUseId: 'toolu_agent_1',
      },
      { type: 'tool_call', toolCallId: 'tu_main_bash', name: 'Bash', input: { command: 'ls' } },
      { type: 'result', stopReason: 'end_turn', finalText: 'done' },
    ]);
    const grep = r.log.find((e) => e.kind === 'tool' && e.tool === 'Grep');
    expect(grep?.agentId).toBe('toolu_agent_1');
    const grepResult = r.log.find((e) => e.kind === 'tool_result' && e.tool === 'Grep');
    expect(grepResult?.agentId).toBe('toolu_agent_1');
    const narration = r.log.find((e) => e.kind === 'narration');
    expect(narration).toMatchObject({ text: 'Checking the mapper next.', agentId: 'toolu_agent_1' });
    const nestedSpawn = r.log.find((e) => e.kind === 'tool' && e.agentRef === 'toolu_nested');
    expect(nestedSpawn?.agentId).toBe('toolu_agent_1');
    expect(r.agentEvents).toContainEqual(
      expect.objectContaining({ kind: 'spawn', agentId: 'toolu_nested', parentAgentId: 'toolu_agent_1' }),
    );
    const bash = r.log.find((e) => e.kind === 'tool' && e.tool === 'Bash');
    expect(bash?.agentId).toBeUndefined();
  });

  it("a subagent's narration never reaches Slack or the turn's collected text", async () => {
    const r = await run([
      { type: 'tool_call', toolCallId: 'toolu_agent_1', name: 'Agent', input: SPAWN_INPUT },
      { type: 'assistant_delta', text: 'SUBAGENT-ONLY narration', parentToolUseId: 'toolu_agent_1' },
      { type: 'tool_result', toolCallId: 'toolu_agent_1', content: [{ type: 'text', text: 'Found it.' }] },
      { type: 'assistant_delta', text: 'Main answer.' },
      { type: 'result', stopReason: 'end_turn', finalText: 'Main answer.' },
    ]);
    const posted = JSON.stringify(r.say.mock.calls);
    expect(posted).not.toContain('SUBAGENT-ONLY');
    const finals = r.log.filter((e) => e.kind === 'final').map((e) => e.text);
    expect(finals.join('\n')).not.toContain('SUBAGENT-ONLY');
    expect(r.collectedText ?? '').not.toContain('SUBAGENT-ONLY');
    expect(r.collectedText).toContain('Main answer.');
    const mainNarration = r.log.filter((e) => e.kind === 'narration' && !e.agentId).map((e) => e.text);
    expect(mainNarration.join('\n')).not.toContain('SUBAGENT-ONLY');
  });

  it("a subagent's per-call usage counts as live usage (sidechain) but not as the main agent's last turn", async () => {
    const r = await run([
      {
        type: 'usage',
        usage: { lastTurnInputTokens: 100, lastTurnMessageId: 'msg_main' },
      },
      {
        type: 'usage',
        parentToolUseId: 'toolu_agent_1',
        usage: { lastTurnInputTokens: 90_000, lastTurnMessageId: 'msg_sub' },
      },
      { type: 'usage', usage: { inputTokens: 90_100, outputTokens: 10, totalCostUsd: 0.5 } },
      { type: 'result', stopReason: 'end_turn', finalText: 'done' },
    ]);
    expect(r.live).toEqual([
      { messageId: 'msg_main', inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
      {
        messageId: 'msg_sub',
        inputTokens: 90_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        sidechain: true,
      },
    ]);
    expect(r.usage).toHaveLength(1);
    expect(r.usage[0]).toMatchObject({ lastTurnInputTokens: 100 });
  });

  it('task lifecycle reaches the agent tree, and the end of the turn is announced', async () => {
    const r = await run([
      {
        type: 'agent_task_lifecycle',
        phase: 'progress',
        taskId: 'task_1',
        toolUseId: 'toolu_bg',
        usage: { totalTokens: 1200, toolUses: 7, durationMs: 41000 },
        lastToolName: 'Grep',
      },
      { type: 'result', stopReason: 'end_turn', finalText: 'done' },
    ]);
    expect(r.agentEvents[0]).toMatchObject({
      kind: 'lifecycle',
      agentId: 'toolu_bg',
      phase: 'progress',
      taskId: 'task_1',
      usage: { totalTokens: 1200, toolUses: 7, durationMs: 41000 },
      lastTool: 'Grep',
    });
    expect(r.agentEvents[r.agentEvents.length - 1]).toMatchObject({ kind: 'turn_end' });
  });

  it('a failed background spawn is not an acknowledgement — the agent never started (review P1)', async () => {
    const r = await run([
      { type: 'tool_call', toolCallId: 'toolu_bad', name: 'Agent', input: { ...SPAWN_INPUT, run_in_background: true } },
      {
        type: 'tool_result',
        toolCallId: 'toolu_bad',
        content: [{ type: 'text', text: 'Agent type not found' }],
        isError: true,
      },
      { type: 'result', stopReason: 'end_turn', finalText: 'done' },
    ]);
    expect(r.agentEvents).toContainEqual(
      expect.objectContaining({ kind: 'returned', agentId: 'toolu_bad', ok: false, ack: false }),
    );
  });

  it('a turn cut short (stopped by the user) still announces its end (review P1)', async () => {
    const agentEvents: AgentTreeEvent[] = [];
    const ctrl = new AbortController();
    ctrl.abort();
    await new AgentStreamProcessor({ onAgentEvent: (e) => agentEvents.push(e) }).process(
      events([{ type: 'tool_call', toolCallId: 'toolu_a', name: 'Agent', input: SPAWN_INPUT }]),
      {
        channel: 'C1',
        threadTs: 'T1',
        sessionKey: 'C1:T1',
        sessionId: 's1',
        incidentAttempt: false,
        logVerbosity: LOG_MINIMAL,
        say: vi.fn().mockResolvedValue({ ts: 'm' }) as unknown as StreamContext['say'],
      },
      ctrl.signal,
    );
    expect(agentEvents.map((e) => e.kind)).toContain('turn_end');
  });

  it("a subagent's tool calls and results travel on attributed and named — the executor keeps the Slack surfaces to main (review rounds 1–2)", async () => {
    const used: string[] = [];
    const results: string[] = [];
    await run(
      [
        { type: 'tool_call', toolCallId: 'toolu_agent_1', name: 'Agent', input: SPAWN_INPUT },
        {
          type: 'tool_call',
          toolCallId: 'tu_sub',
          name: 'Grep',
          input: { pattern: 'x' },
          parentToolUseId: 'toolu_agent_1',
        },
        {
          type: 'tool_result',
          toolCallId: 'tu_sub',
          content: [{ type: 'text', text: 'hit' }],
          parentToolUseId: 'toolu_agent_1',
        },
        { type: 'tool_call', toolCallId: 'tu_main', name: 'Bash', input: { command: 'ls' } },
        { type: 'tool_result', toolCallId: 'tu_main', content: [{ type: 'text', text: 'ok' }] },
        { type: 'result', stopReason: 'end_turn', finalText: 'done' },
      ],
      {
        onToolUse: async (uses) => {
          for (const u of uses) used.push(`${u.name}:${u.parentToolUseId ?? 'main'}`);
        },
        onToolResult: async (res) => {
          for (const t of res) results.push(`${t.toolUseId}:${t.toolName ?? '-'}:${t.parentToolUseId ?? 'main'}`);
        },
      },
    );
    expect(used).toEqual(['Agent:main', 'Grep:toolu_agent_1', 'Bash:main']);
    // A subagent's result is named here (the Slack tracker that names main results never sees it).
    expect(results).toEqual(['tu_sub:Grep:toolu_agent_1', 'tu_main:-:main']);
  });

  it('a session without subagents emits nothing new beyond the turn end', async () => {
    const r = await run([
      { type: 'tool_call', toolCallId: 'tu_1', name: 'Read', input: { file_path: '/a' } },
      { type: 'tool_result', toolCallId: 'tu_1', content: [{ type: 'text', text: 'x' }] },
      { type: 'result', stopReason: 'end_turn', finalText: 'done' },
    ]);
    expect(r.agentEvents.map((e) => e.kind)).toEqual(['turn_end']);
    for (const e of r.log) {
      expect(e.agentId).toBeUndefined();
      expect(e.agentRef).toBeUndefined();
    }
  });
});
