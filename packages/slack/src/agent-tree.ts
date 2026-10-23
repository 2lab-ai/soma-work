/**
 * Agent tree — the seam between the stream processor and the session's agent
 * registry (spec 12, `.prd/12-dashboard-agent-tree-spec.md`).
 *
 * A subagent is identified by the id of the tool call that started it (the
 * SDK's `Agent` tool, `Task` before Claude Code v2.1.63). Every frame a
 * subagent produces carries that id as `parentToolUseId`; a frame without one
 * is the main agent's. The stream processor turns what it sees into these
 * events (`StreamCallbacks.onAgentEvent`); the host folds them into the
 * session's registry (`src/session/agent-registry.ts`). Types only, plus the
 * two pure predicates both sides share.
 */

/** Tools whose call starts a subagent: `Agent` today, `Task` for older CLIs. */
const AGENT_SPAWN_TOOLS = new Set(['Agent', 'Task']);

export function isAgentSpawnTool(name: unknown): boolean {
  return typeof name === 'string' && AGENT_SPAWN_TOOLS.has(name);
}

/**
 * Last-resort reading of a spawn's tool result as a background
 * acknowledgement ("Async agent launched successfully…", "…running in the
 * background…"). Used only when neither the structured outcome
 * (`tool_use_result.status`) nor the spawn input (`run_in_background`) says.
 */
export function isBackgroundAckText(text: unknown): boolean {
  return (
    typeof text === 'string' && /\b(async agent launched|launched successfully|running in the background)\b/i.test(text)
  );
}

/** Longest agent id kept anywhere (the work log clips `agentId` / `agentRef` to the same length). */
export const AGENT_ID_MAX = 200;

/**
 * The one way an agent id is shortened, so the registry and the work log always
 * hold the same string for the same agent. SDK ids are ~30 chars; this only
 * matters for a hostile or broken producer. Same rule as the work log's
 * field clamp: keep `max - 1` units, never split a surrogate pair, add `…`.
 */
export function normalizeAgentId(id: string): string {
  if (id.length <= AGENT_ID_MAX) return id;
  let end = AGENT_ID_MAX - 1;
  const lastKept = id.charCodeAt(end - 1);
  if (lastKept >= 0xd800 && lastKept <= 0xdbff) end -= 1;
  return `${id.slice(0, end)}…`;
}

export type AgentTaskStatus = 'pending' | 'in_progress' | 'completed';

export interface AgentLifecycleUsage {
  totalTokens: number;
  toolUses: number;
  durationMs: number;
}

export type AgentTreeEvent =
  /** An `Agent`/`Task` call (full info), or the first frame of an agent not seen before (id only). */
  | {
      kind: 'spawn';
      agentId: string;
      /** The agent that made the spawning call; absent = the main agent. */
      parentAgentId?: string;
      agentType?: string;
      description?: string;
      background?: boolean;
      ts: number;
    }
  /** A subagent's TodoWrite list (the main agent's goes to `onTodoUpdate`, as before). */
  | { kind: 'todos'; agentId: string; todos: unknown; ts: number }
  /**
   * The spawning call's tool result. `ack` = it only acknowledges a background
   * start; otherwise the agent is done (`ok` false = failed). Run totals come
   * from the structured outcome when the SDK sent one.
   */
  | {
      kind: 'returned';
      agentId: string;
      ok: boolean;
      ack: boolean;
      toolUses?: number;
      durationMs?: number;
      ts: number;
    }
  /**
   * SDK task lifecycle (`task_started` / `task_progress` / `task_notification`,
   * `task_updated`). `agentId` = the task's `tool_use_id`, absent when the SDK
   * names only its task id (`task_updated`). The registry applies it to an agent
   * it already has; it never creates one from it.
   */
  | {
      kind: 'lifecycle';
      agentId?: string;
      phase: 'started' | 'progress' | 'settled';
      taskId: string;
      taskType?: string;
      status?: 'completed' | 'failed' | 'stopped';
      agentType?: string;
      description?: string;
      background?: boolean;
      summary?: string;
      lastTool?: string;
      usage?: AgentLifecycleUsage;
      ts: number;
    }
  /** The turn is over: a foreground agent still running is no longer watched. */
  | { kind: 'turn_end'; ts: number };
