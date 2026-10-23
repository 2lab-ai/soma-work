/**
 * Spec 12 (agent tree) §2.3 — the session's agent registry.
 *
 * One record per subagent the session started, keyed by the id of the tool
 * call that started it. Each has its own task ledger (its TodoWrite lists) and
 * its own tool-call count; the main agent keeps the session's task ledger.
 * Status rules (review M2): the SDK's settle is authoritative; a foreground
 * agent's tool result ends it; a background acknowledgement does not; losing
 * sight of a running agent (turn cut off, restart) is `unknown`, not
 * `stopped`; nothing moves a settled agent back to running.
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_LEDGER_KEEP,
  AGENT_REGISTRY_MAX,
  type AgentRegistry,
  agentById,
  applyAgentEvent,
  loseRunningAgents,
  sanitizeAgentRegistry,
  stampWorkLogAgent,
} from '../agent-registry';
import { applyTodoList, ledgerTasks } from '../task-ledger';

const T0 = 1_700_000_000_000;

function holder(): { agents?: AgentRegistry; taskLedger?: ReturnType<typeof applyTodoList> } {
  return {};
}

describe('agent registry — spawn and identity', () => {
  it('a spawn creates one record with a spawn number; a repeat fills gaps only', () => {
    const h = holder();
    expect(
      applyAgentEvent(h, {
        kind: 'spawn',
        agentId: 'toolu_a',
        agentType: 'Explore',
        description: 'Trace frames',
        background: false,
        ts: T0,
      }),
    ).toBe(true);
    applyAgentEvent(h, { kind: 'spawn', agentId: 'toolu_b', parentAgentId: 'toolu_a', ts: T0 + 5 });
    const a = agentById(h.agents, 'toolu_a');
    expect(a).toMatchObject({ id: 'toolu_a', n: 1, type: 'Explore', description: 'Trace frames', status: 'running' });
    expect(a?.startedAt).toBe(T0);
    expect(agentById(h.agents, 'toolu_b')).toMatchObject({ n: 2, parentId: 'toolu_a' });

    // A placeholder spawn of a known agent (a later turn's processor) never resets it.
    applyAgentEvent(h, { kind: 'returned', agentId: 'toolu_a', ok: true, ack: false, ts: T0 + 60_000 });
    applyAgentEvent(h, { kind: 'spawn', agentId: 'toolu_a', ts: T0 + 70_000 });
    expect(agentById(h.agents, 'toolu_a')).toMatchObject({ n: 1, status: 'completed', startedAt: T0 });
    expect(h.agents?.nextN).toBe(3);
  });

  it('lifecycle never creates an agent, and non-agent tasks (background Bash) are ignored', () => {
    const h = holder();
    expect(
      applyAgentEvent(h, {
        kind: 'lifecycle',
        agentId: 'toolu_bash',
        phase: 'started',
        taskId: 'task_bash',
        taskType: 'local_bash',
        ts: T0,
      }),
    ).toBe(false);
    expect(h.agents?.agents.length ?? 0).toBe(0);
    applyAgentEvent(h, { kind: 'spawn', agentId: 'toolu_a', ts: T0 });
    expect(
      applyAgentEvent(h, {
        kind: 'lifecycle',
        agentId: 'toolu_a',
        phase: 'started',
        taskId: 'task_a',
        taskType: 'local_bash',
        ts: T0,
      }),
    ).toBe(false);
  });
});

describe('agent registry — status rules', () => {
  function spawned(background = false) {
    const h = holder();
    applyAgentEvent(h, { kind: 'spawn', agentId: 'toolu_a', background, ts: T0 });
    return h;
  }

  it('a foreground result ends the agent: ok → completed, error → failed', () => {
    const ok = spawned();
    applyAgentEvent(ok, {
      kind: 'returned',
      agentId: 'toolu_a',
      ok: true,
      ack: false,
      toolUses: 17,
      durationMs: 94_300,
      ts: T0 + 94_300,
    });
    expect(agentById(ok.agents, 'toolu_a')).toMatchObject({
      status: 'completed',
      endedAt: T0 + 94_300,
      durationMs: 94_300,
    });
    const bad = spawned();
    applyAgentEvent(bad, { kind: 'returned', agentId: 'toolu_a', ok: false, ack: false, ts: T0 + 1 });
    expect(agentById(bad.agents, 'toolu_a')?.status).toBe('failed');
  });

  it('a background acknowledgement keeps it running; the settle ends it', () => {
    const h = spawned();
    applyAgentEvent(h, { kind: 'returned', agentId: 'toolu_a', ok: true, ack: true, ts: T0 + 1 });
    expect(agentById(h.agents, 'toolu_a')).toMatchObject({ status: 'running', background: true });
    applyAgentEvent(h, {
      kind: 'lifecycle',
      agentId: 'toolu_a',
      phase: 'started',
      taskId: 'task_a',
      taskType: 'local_agent',
      background: true,
      ts: T0 + 2,
    });
    applyAgentEvent(h, {
      kind: 'lifecycle',
      agentId: 'toolu_a',
      phase: 'progress',
      taskId: 'task_a',
      usage: { totalTokens: 1200, toolUses: 7, durationMs: 41_000 },
      lastTool: 'Grep',
      summary: 'Reading the parser',
      ts: T0 + 41_000,
    });
    expect(agentById(h.agents, 'toolu_a')).toMatchObject({
      status: 'running',
      tokens: 1200,
      lastTool: 'Grep',
      summary: 'Reading the parser',
    });
    applyAgentEvent(h, {
      kind: 'lifecycle',
      agentId: 'toolu_a',
      phase: 'settled',
      taskId: 'task_a',
      status: 'completed',
      summary: 'Found it',
      usage: { totalTokens: 1500, toolUses: 9, durationMs: 60_000 },
      ts: T0 + 60_000,
    });
    expect(agentById(h.agents, 'toolu_a')).toMatchObject({ status: 'completed', summary: 'Found it', tokens: 1500 });
  });

  it('a settle that names only the SDK task id (task_updated) still reaches the agent', () => {
    const h = spawned(true);
    applyAgentEvent(h, {
      kind: 'lifecycle',
      agentId: 'toolu_a',
      phase: 'started',
      taskId: 'task_a',
      taskType: 'local_agent',
      ts: T0,
    });
    applyAgentEvent(h, { kind: 'lifecycle', phase: 'settled', taskId: 'task_a', status: 'stopped', ts: T0 + 9 });
    expect(agentById(h.agents, 'toolu_a')?.status).toBe('stopped');
  });

  it('nothing moves a settled agent back to running; a late settle corrects an inferred end', () => {
    const h = spawned();
    applyAgentEvent(h, { kind: 'returned', agentId: 'toolu_a', ok: true, ack: false, ts: T0 + 10 });
    applyAgentEvent(h, { kind: 'lifecycle', agentId: 'toolu_a', phase: 'progress', taskId: 'task_a', ts: T0 + 11 });
    expect(agentById(h.agents, 'toolu_a')?.status).toBe('completed');
    applyAgentEvent(h, {
      kind: 'lifecycle',
      agentId: 'toolu_a',
      phase: 'settled',
      taskId: 'task_a',
      status: 'failed',
      ts: T0 + 12,
    });
    expect(agentById(h.agents, 'toolu_a')?.status).toBe('failed');
  });

  it('a turn that ends with a foreground agent still running loses sight of it (unknown), background ones stay', () => {
    const h = holder();
    applyAgentEvent(h, { kind: 'spawn', agentId: 'toolu_fg', background: false, ts: T0 });
    applyAgentEvent(h, { kind: 'spawn', agentId: 'toolu_bg', background: true, ts: T0 });
    applyAgentEvent(h, { kind: 'turn_end', ts: T0 + 100 });
    expect(agentById(h.agents, 'toolu_fg')).toMatchObject({ status: 'unknown', endedAt: T0 + 100 });
    expect(agentById(h.agents, 'toolu_bg')?.status).toBe('running');
    // Seeing it again (a progress frame) proves it is alive.
    applyAgentEvent(h, { kind: 'lifecycle', agentId: 'toolu_fg', phase: 'progress', taskId: 't', ts: T0 + 200 });
    expect(agentById(h.agents, 'toolu_fg')).toMatchObject({ status: 'running' });
    expect(agentById(h.agents, 'toolu_fg')?.endedAt).toBeUndefined();
  });

  it('a restart loses sight of every running agent (loseRunningAgents)', () => {
    const h = holder();
    applyAgentEvent(h, { kind: 'spawn', agentId: 'toolu_bg', background: true, ts: T0 });
    applyAgentEvent(h, { kind: 'spawn', agentId: 'toolu_done', ts: T0 });
    applyAgentEvent(h, { kind: 'returned', agentId: 'toolu_done', ok: true, ack: false, ts: T0 + 1 });
    const out = loseRunningAgents(h.agents, T0 + 500);
    expect(agentById(out, 'toolu_bg')).toMatchObject({ status: 'unknown', endedAt: T0 + 500 });
    expect(agentById(out, 'toolu_done')?.status).toBe('completed');
  });
});

describe('agent registry — tasks and work log', () => {
  it("a subagent's TodoWrite lands in its own ledger; the main ledger is untouched", () => {
    const h = holder();
    h.taskLedger = applyTodoList(undefined, [{ content: 'Main step', status: 'in_progress' }], T0);
    applyAgentEvent(h, { kind: 'spawn', agentId: 'toolu_a', ts: T0 });
    applyAgentEvent(h, {
      kind: 'todos',
      agentId: 'toolu_a',
      todos: [{ content: 'Sub step', status: 'in_progress', activeForm: 'Subbing' }],
      ts: T0 + 1,
    });
    expect(ledgerTasks(h.taskLedger).current.map((t) => t.content)).toEqual(['Main step']);
    const sub = agentById(h.agents, 'toolu_a');
    expect(sub?.ledger && ledgerTasks(sub.ledger).current.map((t) => t.content)).toEqual(['Sub step']);
  });

  it("stamps a subagent's entry with that agent's task and counts its tool calls there, not on main", () => {
    const h = holder();
    h.taskLedger = applyTodoList(undefined, [{ content: 'Main step', status: 'in_progress' }], T0);
    applyAgentEvent(h, { kind: 'spawn', agentId: 'toolu_a', ts: T0 });
    applyAgentEvent(h, {
      kind: 'todos',
      agentId: 'toolu_a',
      todos: [{ content: 'Sub step', status: 'in_progress' }],
      ts: T0,
    });

    const sub = stampWorkLogAgent(h, { kind: 'tool', tool: 'Grep', text: 'Grep x', agentId: 'toolu_a' }, T0 + 2);
    expect(sub).toMatchObject({ agentId: 'toolu_a', taskId: 'T1', taskTitle: 'Sub step' });
    const main = stampWorkLogAgent(h, { kind: 'tool', tool: 'Bash', text: 'Bash ls' }, T0 + 3);
    expect(main).toMatchObject({ taskId: 'T1', taskTitle: 'Main step' });
    expect('agentId' in main).toBe(false);

    const a = agentById(h.agents, 'toolu_a');
    expect(a).toMatchObject({ toolCalls: 1, lastTool: 'Grep' });
    expect(a?.ledger?.tasks[0].toolCalls).toBe(1);
    expect(h.taskLedger?.tasks[0].toolCalls).toBe(1);
  });

  it('an entry from an agent the registry has never seen creates a placeholder (its log stays reachable)', () => {
    const h = holder();
    stampWorkLogAgent(h, { kind: 'tool', tool: 'Read', text: 'Read a', agentId: 'toolu_ghost' }, T0);
    expect(agentById(h.agents, 'toolu_ghost')).toMatchObject({ status: 'running', toolCalls: 1 });
    expect(agentById(h.agents, 'toolu_ghost')?.type).toBeUndefined();
  });
});

describe('agent registry — bounds and restore', () => {
  it('over the bound, the oldest finished agents go first; running agents and their ancestors stay', () => {
    const h = holder();
    applyAgentEvent(h, { kind: 'spawn', agentId: 'root', background: true, ts: T0 });
    applyAgentEvent(h, { kind: 'spawn', agentId: 'child', parentAgentId: 'root', background: true, ts: T0 });
    applyAgentEvent(h, { kind: 'returned', agentId: 'root', ok: true, ack: false, ts: T0 });
    // root is finished, child (running) needs it.
    for (let i = 0; i < AGENT_REGISTRY_MAX + 5; i++) {
      applyAgentEvent(h, { kind: 'spawn', agentId: `x${i}`, ts: T0 + i });
      applyAgentEvent(h, { kind: 'returned', agentId: `x${i}`, ok: true, ack: false, ts: T0 + i });
    }
    const ids = new Set(h.agents?.agents.map((a) => a.id));
    expect(h.agents?.agents.length).toBe(AGENT_REGISTRY_MAX);
    expect(ids.has('root')).toBe(true);
    expect(ids.has('child')).toBe(true);
    expect(ids.has('x0')).toBe(false);
    expect(ids.has(`x${AGENT_REGISTRY_MAX + 4}`)).toBe(true);
    // Spawn numbers are never reused.
    expect(h.agents?.nextN).toBe(AGENT_REGISTRY_MAX + 8);
  });

  it('only the newest finished agents keep their task ledgers', () => {
    const h = holder();
    for (let i = 0; i < AGENT_LEDGER_KEEP + 3; i++) {
      applyAgentEvent(h, { kind: 'spawn', agentId: `x${i}`, ts: T0 + i });
      applyAgentEvent(h, {
        kind: 'todos',
        agentId: `x${i}`,
        todos: [{ content: `t${i}`, status: 'completed' }],
        ts: T0 + i,
      });
      applyAgentEvent(h, { kind: 'returned', agentId: `x${i}`, ok: true, ack: false, ts: T0 + i });
    }
    expect(agentById(h.agents, 'x0')?.ledger).toBeUndefined();
    expect(agentById(h.agents, `x${AGENT_LEDGER_KEEP + 2}`)?.ledger).toBeDefined();
  });

  it('sanitize restores a persisted registry and drops what is not one', () => {
    const h = holder();
    applyAgentEvent(h, { kind: 'spawn', agentId: 'toolu_a', agentType: 'Explore', ts: T0 });
    applyAgentEvent(h, { kind: 'todos', agentId: 'toolu_a', todos: [{ content: 'Sub', status: 'pending' }], ts: T0 });
    const restored = sanitizeAgentRegistry(JSON.parse(JSON.stringify(h.agents)));
    expect(restored).toEqual(h.agents);
    expect(sanitizeAgentRegistry(null)).toBeUndefined();
    expect(sanitizeAgentRegistry({ nextN: 'x', agents: [] })).toBeUndefined();
    const bad = sanitizeAgentRegistry({
      nextN: 3,
      agents: [{ id: 'ok', n: 1, status: 'running', startedAt: T0, toolCalls: 0 }, { id: 5 }, { n: 2 }],
    });
    expect(bad?.agents.map((a) => a.id)).toEqual(['ok']);
  });
});
