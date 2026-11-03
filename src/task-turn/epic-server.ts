/**
 * E4 ④ — the epic's host tools (.prd/19 D3 · D8), an in-process SDK MCP server `epic`, on an
 * epic's own turns only. Since #854 an epic and its children are Slack sessions: the epic is a
 * thread, each child is its own thread in the epic's channel, and the epic's instruction to a
 * child is a message into that thread — the normal Slack path, so a child that is working takes
 * it in its follow-up queue instead of refusing it.
 *
 * - It rides a Slack turn of an epic that is not a child (`attachesEpicServer`: the turn's
 *   context carries `epicTaskId`). A child's turn and an ordinary session's never get it —
 *   depth 1 is "a child has no epic server".
 * - Its tools carry no identity: the epic's task id is captured when the turn is built, and
 *   every call re-reads the epic's record through the host.
 * - The host (registry reads, the plan writer, the work-log reader, the Slack thread maker, the
 *   tree's limits) is set by `index.ts` through `setEpicHost` — no import of the registry here.
 *
 * Tools: the plan and the reads (`plan_write`, `child_status`), and making and instructing
 * children (`spawn_child`, `instruct_child`). A child is its epic owner's, works in a fresh
 * folder or one the epic names inside its own (D4), and every start the epic makes on its own
 * is bounded by the tree's limits (`epic-tree-gate.ts`).
 */
import { createSdkMcpServer, type McpSdkServerConfigWithInstance, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ExecutionContext } from '../agent-runtime/execution-context';
import { NEW_TASK_LIMITS } from '../conversation/new-task';
import type { ConversationSession, EpicPlan } from '../types';
import { ChildFolderError, foldersOverlap, removeMadeFolders, resolveChildFolder } from './epic-child-folder';
import { EpicPlanError, epicNodeStatus, isEpicDone, type PlanWriteInput } from './epic-plan';

/** A child's card title: the first non-empty line, cut at this many characters. */
const CHILD_TITLE_MAX = 80;

/** A child's card title: the given text's first non-empty line, cut at {@link CHILD_TITLE_MAX}. */
function childTitleOf(text: string): string {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return (line ?? '').slice(0, CHILD_TITLE_MAX);
}

/** D9 a — an epic makes at most this many children (closed and archived ones count). */
export const EPIC_CHILD_MAX = 7;

/** The server key and name: its tools are `mcp__epic__<tool>`. */
export const EPIC_SERVER = 'epic';

/** What making a child asks of the host: its node, its first instruction, its card title, its folder. */
export interface EpicChildSpec {
  planNodeId: string;
  instruction: string;
  title: string;
  /** A folder inside the epic's own (already made); none — the child's thread gets a fresh one. */
  workingDirectory?: string;
}

/** What the epic's tools need from the host process. */
export interface EpicHost {
  getTask(taskId: string): ConversationSession | undefined;
  getChildTasks(parentTaskId: string): ConversationSession[];
  setEpicPlan(taskId: string, input: PlanWriteInput, by: 'epic' | 'owner'): EpicPlan;
  /** A child's last answer (its work log's last final), clipped; undefined when there is none. */
  readChildFinal(child: ConversationSession): Promise<{ text: string; clipped: boolean } | undefined>;
  /** A turn of this session runs now. */
  isRunning(session: ConversationSession): boolean;
  /** #854 — the tree's limits for a start the epic makes (`EpicTreeGate.refusal`): why not, or undefined. */
  admit(epic: ConversationSession, start: { child?: ConversationSession; newChild?: true }): string | undefined;
  /**
   * #854 — make the child: counted on the epic first, then its own thread in the epic's channel,
   * its first instruction sent there as the owner's. `started`: the instruction was taken (its turn
   * runs). A refusal (`ok: false`) changed nothing.
   */
  spawnChild(
    epic: ConversationSession,
    spec: EpicChildSpec,
  ): Promise<
    { ok: true; childId: string; started: boolean; reason?: string } | { ok: false; code: string; error: string }
  >;
  /**
   * #854 — the child's next instruction, into its thread as the owner's: it runs now, or waits in
   * the child's queue behind the turn in flight (`queued`). `taken: false` — it went nowhere.
   */
  instructChild(
    epic: ConversationSession,
    child: ConversationSession,
    instruction: string,
  ): Promise<{ taken: boolean; queued: boolean; reason?: string }>;
  /** Make a named child folder (and its parents) if it is not there yet; the first folder it made, if any. */
  ensureDirectory(dir: string): string | undefined;
}

let host: EpicHost | undefined;

/** Set (or clear, in tests) the host the epic's tools call. `index.ts` sets it once at startup. */
export function setEpicHost(next: EpicHost | undefined): void {
  host = next;
}

/** A turn the epic server rides: the context names the epic (a Slack epic's own turn, never a child's). */
export type EpicExecutionContext = ExecutionContext & { readonly epicTaskId: string };

/** D3 — the epic server rides a Slack turn of an epic that is not itself a child (`epicTaskId`). */
export function attachesEpicServer(ctx: ExecutionContext | undefined): ctx is EpicExecutionContext {
  return !!ctx && ctx.origin === 'slack' && typeof ctx.epicTaskId === 'string' && ctx.epicTaskId !== '';
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
const reply = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const refuse = (code: string, error: string): ToolResult => ({ ...reply({ ok: false, code, error }), isError: true });

/** The epic's live record now, or why its tools cannot act. */
function liveEpic(taskId: string): { host: EpicHost; epic: ConversationSession } | ToolResult {
  if (!host) return refuse('not-ready', 'the epic tools are not ready yet — try again');
  const epic = host.getTask(taskId);
  if (!epic || epic.kind !== 'epic' || epic.terminated || epic.closing) {
    return refuse('not-an-epic', 'this session is no longer a live epic');
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

/** The epic's live children: its own owner's (a child is its epic's owner's, D4), not closed. */
function liveChildrenOf(h: EpicHost, epic: ConversationSession): ConversationSession[] {
  return h.getChildTasks(epic.taskId as string).filter((c) => c.ownerId === epic.ownerId && !c.terminated);
}

/** Where a session works: its own session folder, else its working directory. */
const folderOf = (s: ConversationSession): string | undefined => s.sessionWorkingDir || s.workingDirectory;

/**
 * Why an instruction cannot be given, or undefined: the new-task bounds (not empty, at most
 * `NEW_TASK_LIMITS.maxPromptChars`) and plain text only — never a command (fable #700 R1).
 */
function instructionProblem(instruction: string): ToolResult | undefined {
  const text = instruction.trim();
  if (text === '') return refuse('empty-instruction', 'an instruction cannot be empty');
  if (instruction.length > NEW_TASK_LIMITS.maxPromptChars) {
    return refuse('too-long', `an instruction is at most ${NEW_TASK_LIMITS.maxPromptChars} characters`);
  }
  if (/^[/%!$]/.test(text)) return refuse('command', 'an instruction is plain text — it cannot start with / % ! or $');
  return undefined;
}

/**
 * `child_status()` — the plan tree with each node's status and verdict, and every child the epic made.
 * Node status here is the records' (D5). The board overlays what it shows (D11 — a running node whose
 * child sits on a permission prompt reads needs-input there).
 */
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
 * The epic's tools for one epic turn. `ctx` is the turn's own context: the epic's task id comes
 * from it, never from a tool argument.
 */
export function epicTools(ctx: EpicExecutionContext) {
  const taskId = ctx.epicTaskId;

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

  /** D4 — a running sibling whose folder is this one, or holds it, or is held by it. */
  const overlappingSibling = (h: EpicHost, epic: ConversationSession, dir: string, except?: string) =>
    liveChildrenOf(h, epic).find((c) => {
      const theirs = folderOf(c);
      return c.taskId !== except && !!theirs && h.isRunning(c) && foldersOverlap(dir, theirs);
    });

  const spawnChild = tool(
    'spawn_child',
    [
      "Make a child for one node of the plan — its own Slack thread in this epic's channel — and start it with",
      'an instruction (plain text). One live child per node: calling again for a node that has one returns it',
      `(made: false) — give it more work with instruct_child. At most ${EPIC_CHILD_MAX} children per epic. folder`,
      "(optional) is a relative path inside this epic's folder; without it the child gets a fresh folder. Two",
      'running children never share a folder.',
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
      const bad = instructionProblem(args.instruction);
      if (bad) return bad;
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
      // A new child runs at once: it takes a place among the running children.
      const refused = h.admit(epic, { newChild: true });
      if (refused) return refuse('start-429', refused);
      let dir: string | undefined;
      /** A folder this call made, removed again if no child comes of it ("nothing changed"). */
      let made: { dir: string; first: string } | undefined;
      if (args.folder !== undefined) {
        try {
          dir = resolveChildFolder(epic.ownerId, folderOf(epic) ?? '', args.folder);
        } catch (error) {
          if (error instanceof ChildFolderError) return refuse(error.code, error.message);
          throw error;
        }
        const sibling = overlappingSibling(h, epic, dir);
        if (sibling) return refuse('folder-overlap', `a running child (${sibling.taskId}) works in that folder`);
        const first = h.ensureDirectory(dir);
        if (first) made = { dir, first };
      }
      const spawned = await h.spawnChild(epic, {
        planNodeId: args.planNodeId,
        instruction: args.instruction,
        // The card's title rule (the launcher's): the first non-empty line, 80 characters.
        title: childTitleOf(args.title ?? '') || childTitleOf(node.title),
        ...(dir ? { workingDirectory: dir } : {}),
      });
      if (!spawned.ok) {
        if (made) removeMadeFolders(made.dir, made.first);
        return refuse(spawned.code, spawned.error);
      }
      return reply({
        ok: true,
        made: true,
        childId: spawned.childId,
        started: spawned.started,
        ...(spawned.started ? {} : { reason: spawned.reason ?? 'its first instruction did not start' }),
      });
    },
  );

  const instructChild = tool(
    'instruct_child',
    [
      "Give one of this epic's children its next instruction (plain text — not / % ! or $), into its thread. A",
      'child waiting on a question takes it as the answer. A child that is working takes it in its queue: it',
      'runs right after the turn in flight (queued: true).',
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
      const bad = instructionProblem(args.instruction);
      if (bad) return bad;
      if (!h.isRunning(child)) {
        const theirs = folderOf(child);
        const sibling = theirs ? overlappingSibling(h, epic, theirs, child.taskId) : undefined;
        if (sibling) return refuse('folder-overlap', `a running child (${sibling.taskId}) works in its folder`);
      }
      // Queued or not, it is the tree's work: its spend and its window answer (a working child's
      // word takes no new running place — the gate does not count the child against itself).
      const refused = h.admit(epic, { child });
      if (refused) return refuse('start-429', refused);
      const sent = await h.instructChild(epic, child, args.instruction);
      if (!sent.taken) return refuse('not-sent', sent.reason ?? 'the instruction could not be sent — try again');
      return reply({ ok: true, childId: args.childId, started: !sent.queued, queued: sent.queued });
    },
  );

  return [planWrite, childStatus, spawnChild, instructChild] as const;
}

/** The `epic` server for one epic turn (its tools: `epicTools`). */
export function buildEpicServer(ctx: EpicExecutionContext): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({ name: EPIC_SERVER, tools: [...epicTools(ctx)] });
}
