/**
 * E4 ④a — the epic's host tools (.prd/19 D3 · D8): an in-process SDK MCP
 * server `epic`, on an epic's own turns only.
 *
 * - It rides a turn whose execution context is a task turn of an epic that
 *   is not a child (`attachesEpicServer`). A child's turn, an ordinary task's
 *   and a Slack turn never get it — depth 1 is "a child has no epic server".
 * - Its tools carry no identity: the epic's task id is captured when the turn
 *   is built, and every call re-reads the epic's record through the host.
 * - The host (registry reads, the plan writer, the work-log reader) is set
 *   by `index.ts` through `setEpicHost` — no import of the registry here.
 *
 * ④a ships the plan and the reads (`plan_write`, `child_status`); making and
 * instructing children is ④b.
 */
import { createSdkMcpServer, type McpSdkServerConfigWithInstance, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ExecutionContext, TaskExecutionContext } from '../agent-runtime/execution-context';
import type { ConversationSession, EpicPlan } from '../types';
import { EpicPlanError, epicNodeStatus, isEpicDone, type PlanWriteInput } from './epic-plan';

/** The server key and name: its tools are `mcp__epic__<tool>`. */
export const EPIC_SERVER = 'epic';

/** What the epic's tools need from the host process. */
export interface EpicHost {
  getTask(taskId: string): ConversationSession | undefined;
  getChildTasks(parentTaskId: string): ConversationSession[];
  setEpicPlan(taskId: string, input: PlanWriteInput, by: 'epic' | 'owner'): EpicPlan;
  /** A child's last turn final (its work log), clipped; undefined when there is none. */
  readChildFinal(child: ConversationSession): Promise<{ text: string; clipped: boolean } | undefined>;
}

let host: EpicHost | undefined;

/** Set (or clear, in tests) the host the epic's tools call. `index.ts` sets it once at startup. */
export function setEpicHost(next: EpicHost | undefined): void {
  host = next;
}

/** D3 — the epic server rides a task turn of an epic that is not itself a child. */
export function attachesEpicServer(ctx: ExecutionContext | undefined): ctx is TaskExecutionContext {
  if (!ctx || ctx.origin !== 'task') return false;
  const task = ctx as TaskExecutionContext;
  return task.kind === 'epic' && !task.parentTaskId;
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
const reply = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const refuse = (code: string, error: string): ToolResult => ({ ...reply({ ok: false, code, error }), isError: true });

/** The epic's live record now, or why its tools cannot act. */
function liveEpic(taskId: string): { host: EpicHost; epic: ConversationSession } | ToolResult {
  if (!host) return refuse('not-ready', 'the epic tools are not ready yet — try again');
  const epic = host.getTask(taskId);
  if (!epic || epic.slackless !== true || epic.kind !== 'epic' || epic.terminated) {
    return refuse('not-an-epic', 'this task is no longer a live epic');
  }
  return { host, epic };
}

/** A child as the epic sees it: its node, state and last chain result — no text it wrote. */
function childView(id: string, live: ConversationSession | undefined) {
  if (!live) return { taskId: id, closed: true };
  return {
    taskId: id,
    planNodeId: live.planNodeId,
    state: live.activityState ?? 'idle',
    ...(live.lastTurnOutcome ? { outcome: live.lastTurnOutcome.outcome } : {}),
  };
}

/** The epic's live children: only those of its own owner count (a child is its epic's owner's, D4). */
function liveChildrenOf(h: EpicHost, epic: ConversationSession): ConversationSession[] {
  return h.getChildTasks(epic.taskId as string).filter((c) => c.ownerId === epic.ownerId);
}

/** `child_status()` — the plan tree with each node's status and verdict, and every child the epic made. */
function treeStatus(h: EpicHost, epic: ConversationSession) {
  const live = liveChildrenOf(h, epic);
  const byId = new Map(live.map((c) => [c.taskId, c]));
  const plan = epic.plan ?? { nodes: [] };
  return {
    ok: true,
    done: isEpicDone(epic.plan),
    nodes: plan.nodes.map((node) => ({
      id: node.id,
      title: node.title,
      kind: node.kind,
      ...(node.parent ? { parent: node.parent } : {}),
      status: epicNodeStatus(node, live, epic.epicEvents ?? []),
      ...(node.accepted ? { accepted: node.accepted } : {}),
    })),
    children: (epic.childTaskIds ?? []).map((id) => childView(id, byId.get(id))),
  };
}

/**
 * The epic's tools for one epic turn. `ctx` is the turn's own context: the
 * epic's task id comes from it, never from a tool argument.
 */
export function epicTools(ctx: TaskExecutionContext) {
  const taskId = ctx.taskId;

  const planWrite = tool(
    'plan_write',
    [
      "Replace this epic's plan tree (all nodes at once). Nodes: `issue` (top level) or `sub` (under an issue);",
      'ids are short lowercase slugs, unique, and a removed id is never reused. At most 50 nodes; title ≤ 200,',
      'body ≤ 2,000 characters. A node a child was made for cannot be removed. `accepted: true` marks a node',
      'done-and-accepted (kept on later writes; `false` clears it). `done: true` closes the epic (refused while a',
      'child runs or waits). Returns the saved plan, or a refusal with its code — nothing is changed then.',
    ].join(' '),
    {
      nodes: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          kind: z.string(),
          parent: z.string().optional(),
          body: z.string().optional(),
          accepted: z.boolean().optional(),
        }),
      ),
      done: z.boolean().optional(),
    },
    async (args) => {
      const found = liveEpic(taskId);
      if ('content' in found) return found;
      try {
        const plan = found.host.setEpicPlan(taskId, args as PlanWriteInput, 'epic');
        return reply({ ok: true, done: isEpicDone(plan), plan });
      } catch (error) {
        if (error instanceof EpicPlanError) return refuse(error.code, error.message);
        return refuse('not-saved', 'the plan could not be saved — nothing changed; try again');
      }
    },
  );

  const childStatus = tool(
    'child_status',
    [
      "Read this epic's progress. With no childId: the plan tree, each node's status (none, running,",
      'needs-input, finished, failed, cancelled, interrupted, closed) and verdict, and every child made.',
      "With a childId of one of this epic's children: its state, last result and the end of its last answer.",
    ].join(' '),
    { childId: z.string().optional() },
    async (args) => {
      const found = liveEpic(taskId);
      if ('content' in found) return found;
      const { host: h, epic } = found;
      if (args.childId === undefined) return reply(treeStatus(h, epic));
      if (!(epic.childTaskIds ?? []).includes(args.childId)) {
        return refuse('not-a-child', `${args.childId} is not a child of this epic`);
      }
      const live = liveChildrenOf(h, epic).find((c) => c.taskId === args.childId);
      const view = childView(args.childId, live);
      if (!live) return reply({ ok: true, child: view });
      let final: { text: string; clipped: boolean } | undefined;
      try {
        final = await h.readChildFinal(live);
      } catch {
        final = undefined;
      }
      return reply({ ok: true, child: { ...view, ...(final ? { final: final.text, clipped: final.clipped } : {}) } });
    },
  );

  return [planWrite, childStatus] as const;
}

/** The `epic` server for one epic turn (its tools: `epicTools`). */
export function buildEpicServer(ctx: TaskExecutionContext): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({ name: EPIC_SERVER, tools: [...epicTools(ctx)] });
}
