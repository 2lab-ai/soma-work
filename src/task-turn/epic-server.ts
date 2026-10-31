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
 * Tools: the plan and the reads (`plan_write`, `child_status`, ④a), and
 * making and instructing children (`spawn_child`, `instruct_child`, ④b). A
 * child is its epic owner's, runs in a folder the host picks (D4), and starts
 * through the controller as a host start (`initiator: 'host'`) — so the tree
 * slot, its window and the cost cap apply (E4 ③).
 */
import { createSdkMcpServer, type McpSdkServerConfigWithInstance, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { type ExecutionContext, type TaskExecutionContext, taskDirectoryFor } from '../agent-runtime/execution-context';
import { buildTaskSessionKey } from '../session-identity';
import type { CreateTaskInput } from '../session-registry';
import type { ConversationSession, EpicPlan } from '../types';
import { ChildFolderError, foldersOverlap, resolveChildFolder } from './epic-child-folder';
import { EpicPlanError, epicNodeStatus, isEpicDone, type PlanWriteInput } from './epic-plan';
import type { TaskTurnController } from './task-turn-controller';

/** D9 a — an epic makes at most this many children (closed and archived ones count). */
export const EPIC_CHILD_MAX = 7;

/** The server key and name: its tools are `mcp__epic__<tool>`. */
export const EPIC_SERVER = 'epic';

/** What the epic's tools need from the host process. */
export interface EpicHost {
  getTask(taskId: string): ConversationSession | undefined;
  getChildTasks(parentTaskId: string): ConversationSession[];
  setEpicPlan(taskId: string, input: PlanWriteInput, by: 'epic' | 'owner'): EpicPlan;
  /** A child's last turn final (its work log), clipped; undefined when there is none. */
  readChildFinal(child: ConversationSession): Promise<{ text: string; clipped: boolean } | undefined>;
  /** ④b — make a child task (the registry's strict create: its epic counts it in the same save). */
  createTask(input: CreateTaskInput): ConversationSession;
  /** ④b — a fresh `session_*` folder under the owner's `/tmp` root. */
  createFreshDirectory(ownerId: string): string | undefined;
  /** ④b — make a named child folder (and its parents) if it is not there yet. */
  ensureDirectory(dir: string): void;
  /** ④b — the task turn controller: tree admission and starts. */
  controller: Pick<TaskTurnController, 'canStart' | 'start' | 'isRunning'>;
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

  /** A host start of a child: the epic's owner, the tree's slot and cap (E4 ③). */
  const startChild = (h: EpicHost, epic: ConversationSession, childId: string, text: string) =>
    h.controller.start({
      sessionKey: buildTaskSessionKey(childId),
      text,
      actorUserId: epic.ownerId,
      initiator: 'host',
    });

  /** D4 — a running sibling whose folder is this one, or holds it, or is held by it. */
  const overlappingSibling = (h: EpicHost, epic: ConversationSession, dir: string, except?: string) =>
    liveChildrenOf(h, epic).find(
      (c) =>
        c.taskId !== except &&
        !!c.taskId &&
        !!c.workingDirectory &&
        h.controller.isRunning(buildTaskSessionKey(c.taskId)) &&
        foldersOverlap(dir, c.workingDirectory),
    );

  const spawnChild = tool(
    'spawn_child',
    [
      'Make a child task for one node of the plan and start it with an instruction (plain text). One live child per',
      'node: calling again for a node that has one returns it (made: false) — give it more work with instruct_child.',
      `At most ${EPIC_CHILD_MAX} children per epic. folder (optional) is a relative path inside this epic's folder;`,
      'without it the child gets a fresh folder. Two running children never share a folder.',
    ].join(' '),
    {
      planNodeId: z.string(),
      instruction: z.string(),
      folder: z.string().optional(),
      title: z.string().optional(),
    },
    async (args) => {
      const found = liveEpic(taskId);
      if ('content' in found) return found;
      const { host: h, epic } = found;
      const node = epic.plan?.nodes.find((n) => n.id === args.planNodeId);
      if (!node)
        return refuse('no-such-node', `the plan has no node ${args.planNodeId} — write it with plan_write first`);
      // Idempotent per (epic, node): a re-call after an aborted turn finds the child it made.
      const existing = liveChildrenOf(h, epic).find((c) => c.planNodeId === args.planNodeId);
      if (existing?.taskId) {
        return reply({ ok: true, made: false, childId: existing.taskId, state: existing.activityState ?? 'idle' });
      }
      if ((epic.childTaskIds ?? []).length >= EPIC_CHILD_MAX) {
        return refuse('too-many-children', `an epic makes at most ${EPIC_CHILD_MAX} children`);
      }
      const ownerId = epic.ownerId;
      const epicKey = buildTaskSessionKey(taskId);
      const refused = h.controller.canStart(ownerId, args.instruction, {
        root: epicKey,
        role: 'child',
        initiator: 'host',
      });
      if (refused) return refuse(`start-${refused.status}`, String(refused.body.error ?? 'refused'));
      let dir: string;
      if (args.folder === undefined) {
        const fresh = h.createFreshDirectory(ownerId);
        if (!fresh) return refuse('no-folder', 'a folder for the child could not be made');
        try {
          dir = taskDirectoryFor(ownerId, fresh);
        } catch (error) {
          return refuse('no-folder', `the child cannot work in its folder: ${(error as Error).message}`);
        }
      } else {
        try {
          dir = resolveChildFolder(ownerId, epic.workingDirectory ?? '', args.folder);
        } catch (error) {
          if (error instanceof ChildFolderError) return refuse(error.code, error.message);
          throw error;
        }
      }
      const sibling = overlappingSibling(h, epic, dir);
      if (sibling) return refuse('folder-overlap', `a running child (${sibling.taskId}) works in that folder`);
      if (args.folder !== undefined) h.ensureDirectory(dir);
      let child: ConversationSession;
      try {
        child = h.createTask({
          ownerId,
          ownerName: epic.ownerName ?? ownerId,
          workingDirectory: dir,
          title: (args.title ?? node.title).slice(0, 80),
          parentTaskId: taskId,
          planNodeId: args.planNodeId,
          ...(epic.model ? { model: epic.model } : {}),
        });
      } catch {
        return refuse('not-saved', 'the child could not be made — nothing changed; try again');
      }
      const childId = child.taskId as string;
      const started = await startChild(h, epic, childId, args.instruction);
      return reply({
        ok: true,
        made: true,
        childId,
        started: started.status === 202,
        ...(started.status === 202 ? {} : { reason: String(started.body.error ?? `status ${started.status}`) }),
      });
    },
  );

  const instructChild = tool(
    'instruct_child',
    [
      "Give one of this epic's children its next instruction (plain text — not / or %). A child waiting on a question",
      'takes it as the answer (it replaces the question). A child that is running refuses (busy) — try later.',
    ].join(' '),
    { childId: z.string(), instruction: z.string() },
    async (args) => {
      const found = liveEpic(taskId);
      if ('content' in found) return found;
      const { host: h, epic } = found;
      if (!(epic.childTaskIds ?? []).includes(args.childId)) {
        return refuse('not-a-child', `${args.childId} is not a child of this epic`);
      }
      const child = liveChildrenOf(h, epic).find((c) => c.taskId === args.childId);
      if (!child) return refuse('closed', `${args.childId} is closed — spawn a new child for its node`);
      if (/^[/%]/.test(args.instruction.trim())) {
        return refuse('command', 'an instruction is plain text — it cannot start with / or %');
      }
      const sibling = child.workingDirectory
        ? overlappingSibling(h, epic, child.workingDirectory, child.taskId)
        : undefined;
      if (sibling) return refuse('folder-overlap', `a running child (${sibling.taskId}) works in its folder`);
      const started = await startChild(h, epic, args.childId, args.instruction);
      if (started.status === 202) return reply({ ok: true, childId: args.childId, started: true });
      const code = started.status === 409 ? 'busy' : `start-${started.status}`;
      return refuse(code, String(started.body.error ?? `status ${started.status}`));
    },
  );

  return [planWrite, childStatus, spawnChild, instructChild] as const;
}

/** The `epic` server for one epic turn (its tools: `epicTools`). */
export function buildEpicServer(ctx: TaskExecutionContext): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({ name: EPIC_SERVER, tools: [...epicTools(ctx)] });
}
