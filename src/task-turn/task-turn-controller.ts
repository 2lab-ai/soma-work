/**
 * The caller of a Slack-less task's turns (#598 ④c, design 598c §1–§5 + v2).
 *
 * The dashboard's `command` route hands a task's instruction here. The
 * controller refuses what A0 does not support (D8), enforces D9 (one chain per
 * owner, a start window), and accepts — answers 202 — only once the first
 * turn's start is saved. The chain then runs in the background:
 *
 *   instruction ─▶ runTaskTurn ─▶ outcome committed               → done
 *                              └▶ fallbackCompact (budget left)   → /compact (compact hop)
 *                                   └▶ completed (boundary proved) and budget left → the stashed instruction
 *                              └▶ shutdown                        → done (restart reconciliation owns it)
 *
 * Continuations are not resumed on a task (no SDK reset/load semantics): the
 * runner commits them `interrupted`. Nothing is retried automatically (D10).
 *
 * One chain-level AbortController stays registered on the request
 * coordinator for the whole chain, so Stop (`abortSession`, `user-stop`),
 * shutdown (`clearAll`, `shutdown`) and Close (`close()`, `session-close`)
 * reach it between hops too. Each hop gets its own controller, linked to the
 * chain's; the executor's CAS removal of a hop controller leaves the chain's.
 */
import { randomUUID } from 'node:crypto';
import type { ExecutionContext } from '../agent-runtime/execution-context';
import { buildTaskSessionKey } from '../session-identity';
import type { ConversationSession, TaskFollowupItem, TaskTurnOutcomeRecord } from '../types';
import { wakeableEpicEvents } from './epic-plan';
import { buildTaskAnswerText, type TaskAnswer } from './task-answer';
import {
  TASK_FOLLOWUP_CANCELLED,
  TASK_FOLLOWUP_CAPACITY,
  TASK_FOLLOWUP_FIRST_IN_LINE,
  TASK_FOLLOWUP_PAUSED_BEHIND_REFUSED,
  TASK_FOLLOWUP_PAUSED_BY_STOP,
  TASK_FOLLOWUP_PAUSED_BY_UNHEALTHY_END,
} from './task-followups';
import { isPlanPending, planGateTurn } from './task-plan';
import type { RunTaskTurnInput, RunTaskTurnResult, TaskTurnNonTerminal } from './task-turn-runner';

export interface TaskCommandRequest {
  sessionKey: string;
  text: string;
  attachments?: readonly unknown[];
  /**
   * The signed-in user sending it — the owner or anyone else (SSOT 2026-11-02):
   * the turn runs as them, as a Slack turn runs as the user who wrote in the
   * thread. Empty is nobody and starts nothing. A host start passes the owner.
   */
  actorUserId: string;
  /**
   * E4 ③ — who starts it. `owner` (the default): the owner's own instruction
   * or answer. `host`: the host on the owner's behalf — spawning or
   * instructing a child, waking an epic — which an epic tree over its cost
   * limit refuses (D9 e). Host code sets it; no HTTP route forwards it.
   */
  initiator?: 'owner' | 'host';
  /** E4 ③ — the launcher's first start of a task it just made: a new epic counts against A0's window, not its tree's. */
  newTask?: boolean;
  /**
   * A host notice for the start's first hop only — prepended to what the model reads, never recorded
   * as the instruction (the restart resume's guidance, `task-restart-resume.ts`). Host code sets it;
   * no HTTP route forwards it. Joins a plan-mode notice when the task has one.
   */
  promptNotice?: string;
  /**
   * The dashboard's own word (the command route, an approved instruction):
   * while the task's chain runs it waits in the task's follow-up queue for the
   * chain's end (202 `queued`) instead of the 409 — after every other refusal a
   * start makes. A host start (spawn, instruct, wake) leaves it off and keeps the 409.
   */
  queueWhileRunning?: boolean;
  /**
   * #767 — these very words were released by the owner's one-time approval:
   * queued, they run without asking again while unedited (`approvedText`).
   */
  approvedOnce?: boolean;
  /**
   * The goal loop's next turn (host code only, with `initiator: 'host'`): it
   * runs as a synthetic turn — not user input, so it cannot set a goal and
   * does not reset the goal's continuation count. Like every host start it is
   * refused while the task runs (it never supersedes a turn).
   */
  goalContinuation?: boolean;
  /**
   * #865 — a goal's opening turn (host code only): the id of the goal it opens.
   * `text` is the goal's objective, run as the user's words — never read as a
   * goal command again, even when the objective itself begins with `goal`.
   * Queued, it keeps the id, and runs only while that goal is still the active
   * goal (a `goal clear`, `pause`, `done` or delete meanwhile makes it stale).
   */
  goalOpeningId?: string;
}

/** A control on a word in a task's follow-up queue (the dashboard's queue route). */
export interface TaskQueueActRequest {
  sessionKey: string;
  itemId: string;
  op: 'promote' | 'cancel' | 'edit';
  /** The item's epoch the panel showed: an older one is refused (the word changed). */
  epoch: number;
  /** `edit` only — the new words. */
  text?: string;
  /** The signed-in user who pressed it (none: a viewer token). */
  actorUserId?: string;
  /** The presser may manage the task (the owner, a token, an admin in admin mode). */
  manages?: boolean;
}
export type TaskQueueActOutcome = { ok: true; message?: string } | { ok: false; status: number; message: string };

/**
 * E4 ③ — the epic tree a start belongs to (.prd/19 §2.1): its root (the
 * epic's session key; none for an epic not made yet) and whether this start
 * is the root's or a child's. `canStart` takes it; a start reads it from the task.
 */
export interface TreeStart {
  root?: string;
  role: 'root' | 'child';
  initiator?: 'owner' | 'host';
}

export interface TaskCommandResponse {
  status: number;
  body: Record<string, unknown>;
  /** The accepted chain (tests and close() await it). */
  done?: Promise<void>;
}

export interface TaskTurnControllerDeps {
  runner: {
    runTaskTurn(input: RunTaskTurnInput): Promise<RunTaskTurnResult>;
    /** End a pending non-terminal turn that will not be resumed (stop, or the next hop could not start). */
    abandonTurn(
      sessionKey: string,
      turnId: string,
      decided: Omit<TaskTurnOutcomeRecord, 'turnId' | 'at'>,
      chainId?: string,
    ): Promise<RunTaskTurnResult>;
  };
  getSession(sessionKey: string): ConversationSession | undefined;
  coordinator: {
    setController(sessionKey: string, controller: AbortController): void;
    removeController(sessionKey: string, expected?: AbortController): void;
  };
  /**
   * `executionContextForTask(session, actorUserId)` — the turn's context for the
   * user who started it; throws `ExecutionContextMissingError` with the reason.
   */
  buildExecutionContext(session: ConversationSession, actorUserId?: string): ExecutionContext;
  logger: {
    info(msg: string, meta?: unknown): void;
    warn(msg: string, meta?: unknown): void;
    error(msg: string, meta?: unknown): void;
  };
  /** Every hop counts: the instruction, `/compact`, the replay. Default 3. */
  maxDispatches?: number;
  /** D9 window: starts per owner per window. Default 10 per 10 minutes. */
  maxStartsPerWindow?: number;
  windowMs?: number;
  /** E4 ③ (D9 c) — children of one epic running at once. Default 3. */
  maxTreeChildren?: number;
  /** E4 ③ (D9 d) — starts per epic tree per window (`windowMs`). Default 30. */
  maxTreeStartsPerWindow?: number;
  /** E4 ③ (D9 e) — the tree's spend so far: the epic and all its children, live calls included. */
  treeCostUsd?(rootKey: string): number;
  /** E4 ③ (D9 e) — the owner's limit for one tree (`epicCostLimitUsd`). Default 50. */
  epicCostLimitUsd?(ownerId: string): number;
  /**
   * How long close() waits for a chain to end. Default 60 s — longer than the
   * runner's save retries (1 + 5 + 30 s) plus the receipt drain, so a closed
   * task is not removed while its outcome is still being saved (#634 R1).
   */
  closeWaitMs?: number;
  now?: () => number;
  /**
   * E4 ⑥ — told each chain's end, however it ended (an outcome, a throw),
   * after the task is free again — an epic woken for events that came while it
   * ran (grok #702 R1). `started`: some hop's start was saved. A chain that
   * never started is not a cause to wake again (that would loop on a start
   * that keeps failing — fable #702 R2). Never throws into the chain.
   */
  onChainEnd?: (
    sessionKey: string,
    info: {
      started: boolean;
      /** Stop, shutdown or close aborted it. */
      stopped?: boolean;
      /** Its last outcome (none when it threw) — the goal loop runs only after a healthy end. */
      outcome?: TaskTurnOutcomeRecord['outcome'];
    },
  ) => void;
  /** The task's follow-up queue changed (a word queued, run, paused, edited or cancelled): save and show it. Never throws into the caller. */
  onFollowupsChanged?: (sessionKey: string) => void;
  /**
   * A person's instruction or answer starts a turn (not a host start): the
   * user weighed in, as a Slack message does — the goal's continuation count
   * resets and an in-flight completion eval is discarded. Called before the
   * chain runs; never throws into the start.
   */
  onUserInstruction?: (sessionKey: string, session: ConversationSession) => void;
  /** Words one task's queue holds at most. Default {@link TASK_FOLLOWUP_CAPACITY}. */
  maxQueuedFollowups?: number;
  /**
   * #767 — the backstop of the instruction gate when a queued word is about to
   * run (the drain, Send now), as a drained Slack follow-up is gated again: a
   * word not covered by its one-time approval whose writer may not instruct
   * the task on their own (the owner, approved for the session, trusted) goes
   * to the owner instead. Answers `undefined` at once when it may run, else
   * the hold's answer (202 `pendingApproval`, or a refusal).
   */
  holdQueued?: (
    sessionKey: string,
    session: ConversationSession,
    item: TaskFollowupItem,
  ) => Promise<TaskCommandResponse | undefined> | undefined;
  /**
   * #865 — `goal …` is the host's goal command on a task, as in a Slack thread
   * (task-goal-commands.ts): the owner's (or an approved) word that matches is
   * run here — at once, even while a turn runs — and never reaches the model.
   */
  goalCommands?: {
    matches: (text: string) => boolean;
    run: (request: TaskCommandRequest, session: ConversationSession) => Promise<TaskCommandResponse>;
    /** True when the goal command opens a goal (`goal <objective>`) — the only one a new task may start with. */
    opensGoal: (text: string) => boolean;
    /**
     * A goal's queued opening will not run: `cancelled` from the queue, or found
     * `stale` at the drain. Its goal, if its first turn is still owed, is paused
     * (`goal resume` starts it) — never left active with no first turn.
     */
    openingDropped: (
      sessionKey: string,
      session: ConversationSession,
      goalId: string,
      why: 'cancelled' | 'stale',
    ) => void;
  };
}

/** #599 ⑤ — a dashboard answer to the task's open question, bound to its `askId`. */
export interface TaskAnswerRequest {
  sessionKey: string;
  askId: string;
  answer: TaskAnswer;
  /** The signed-in user answering — any user (SSOT 2026-11-02); the answer runs as them. */
  actorUserId: string;
}

export interface TaskTurnController {
  start(request: TaskCommandRequest): Promise<TaskCommandResponse>;
  /**
   * Answer the task's open question (#599 ⑤): bound to its `askId`, one answer
   * per question, run as the next instruction through the same admission as
   * `start`. A refusal at any point leaves the question open.
   */
  answer(request: TaskAnswerRequest): Promise<TaskCommandResponse>;
  /**
   * A dry run of the owner-level admission a start would meet (shutdown, the
   * owner's running task, the start window): null when it may start, else the
   * refusal. Takes nothing — #600 ⑥ asks before it creates a task. With the
   * first instruction, it also refuses a command the start would refuse (#640 R1),
   * so a task is never created that its own first instruction cannot start.
   * With a tree (E4 ③), it is the tree's admission instead of A0's slot.
   * `planning` — the start is a plan turn (a task made in plan mode): no slot, only the window.
   */
  canStart(ownerId: string, text?: string, tree?: TreeStart, opts?: { planning?: boolean }): TaskCommandResponse | null;
  /** Abort the task's chain with `session-close` and wait (bounded) for it to end. */
  close(sessionKey: string): Promise<void>;
  /** Shutdown: refuse new starts (503). Running chains end through the coordinator's `shutdown` abort. */
  stopAccepting(): void;
  /** A refused shutdown (the bot stays up): accept starts again (#634 R1). */
  resumeAccepting(): void;
  isRunning(sessionKey: string): boolean;
  /** E4 ⑦ — the id of the task's running chain (its hops carry it), or none. */
  runningChain(sessionKey: string): string | undefined;
  /**
   * Send now / Cancel / Edit on a queued word. Cancel and Send now: its writer
   * or a manager; Edit: its writer. Send now starts it at once on an idle task
   * (as its writer, through the same admission), or puts it first in line while
   * a chain runs — a task turn takes no word mid-turn yet.
   */
  actOnQueue(request: TaskQueueActRequest): Promise<TaskQueueActOutcome>;
}

const COMPACT = '/compact';
/**
 * A slash command's shape (`/model x`, `/compact`) — not a path (`/work/x`) or
 * a fraction (`2/3`); a plugin's namespaced command (`/plugin:skill`) included
 * (#640 R2). Every command is refused on a task in A0 (D8), `/compact`
 * included: a task turn has no signal that proves a manual compaction happened
 * (#634 R1). Automatic and fallback compaction still run.
 */
const SLASH_COMMAND = /^\/[A-Za-z][\w-]*(?::[\w-]+)*(?:\s|$)/;
const SESSION_COMMAND = /^%[A-Za-z]/;
const COMMAND_REFUSED = 'commands are not supported on a dashboard task yet — send an instruction';
/** An instruction (trimmed) a task start refuses as a command: `/word` or `%word`. */
function isCommand(text: string): boolean {
  return SLASH_COMMAND.test(text) || SESSION_COMMAND.test(text);
}
const CONTINUATION_REFUSED = 'continuation not supported on a dashboard task yet';
/** #865 — a goal command applies at once; it never waits in the queue. */
const GOAL_COMMAND_NOT_QUEUED = 'a goal command is not queued — send it as its own message (it applies at once)';
/** #865 — a goal's queued opening whose goal moved on (cleared, paused, done, deleted, or already opened). */
const GOAL_OPENING_STALE = "this goal's first turn was skipped — the goal no longer waits for it";
/** #865 — a goal's queued first turn is its objective. */
const GOAL_OPENING_NOT_EDITABLE =
  "this is a goal's first turn (its objective) — cancel it to pause the goal, or `goal clear` and set the goal again";
/** #865 — a new task's first word may open a goal, not act on one it does not have. */
const GOAL_COMMAND_NEEDS_GOAL =
  'a new task starts with an instruction or `goal <objective>` — it has no goal to act on yet';
const BUDGET_SPENT = 're-entry limit reached';
/** E2 ③ — the end of a chain whose `/compact` hop completed with no instruction re-run. */
const COMPACT_NOT_RERUN = 'compacted, but the instruction was not re-run (압축 뒤 재실행 못 함)';

interface Chain {
  ownerId: string;
  /** E2 ③ — the id every hop of this chain carries. */
  id: string;
  abort: AbortController;
  done: Promise<void>;
  /** E4 ③ — the epic tree it runs in (its root's key), or none for an ordinary task. */
  tree?: string;
  /** A plan turn (the task's plan not started): it holds no slot — neither A0's nor its tree's. */
  planning: boolean;
}

/** E4 ③ — the epic tree of a task: the epic itself, or its parent's. An ordinary task has none. */
function treeOf(session: ConversationSession, sessionKey: string): (TreeStart & { root: string }) | undefined {
  if (session.slackless !== true) return undefined;
  if (session.kind === 'epic') return { root: sessionKey, role: 'root' };
  if (session.parentTaskId) {
    try {
      return { root: buildTaskSessionKey(session.parentTaskId), role: 'child' };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

const DEFAULT_EPIC_COST_LIMIT_USD = 50;

/** The refusal of another user's word to an epic tree (its children start as the owner). */
export const EPIC_OWNER_ONLY = 'an epic and its children take instructions from their owner or an admin only';

/** Plan mode — the executor's `promptNotice` param: prepended to the model's prompt, never recorded. */
const noticeParam = (notice: string | undefined): { promptNotice?: string } => (notice ? { promptNotice: notice } : {});

export function createTaskTurnController(deps: TaskTurnControllerDeps): TaskTurnController {
  const maxDispatches = deps.maxDispatches ?? 3;
  const maxStarts = deps.maxStartsPerWindow ?? 10;
  const windowMs = deps.windowMs ?? 10 * 60_000;
  const now = deps.now ?? Date.now;
  const maxTreeChildren = deps.maxTreeChildren ?? 3;
  const maxTreeStarts = deps.maxTreeStartsPerWindow ?? 30;
  const maxQueued = deps.maxQueuedFollowups ?? TASK_FOLLOWUP_CAPACITY;
  const chains = new Map<string, Chain>();
  const ownerChain = new Map<string, string>();
  const starts = new Map<string, number[]>();
  /**
   * E4 ③ (D9 c) — beside A0's slot: the one epic tree an owner runs, with its
   * running members (root and children) by the chain that holds each.
   */
  const ownerTree = new Map<string, { root: string; running: Map<string, Chain> }>();
  /** E4 ③ (D9 d) — starts per tree (by root key) in the window. */
  const treeStarts = new Map<string, number[]>();
  /** Turns a shutdown abort left `working` (restart reconciliation's to record — unless the shutdown is refused). */
  const shutdownStranded = new Map<string, { turnId: string; chainId: string }>();
  let accepting = true;

  const refuse = (status: number, error: string): TaskCommandResponse => ({ status, body: { error } });

  /**
   * The owner-level part of admission (D9): no side effect. A plan turn skips
   * the slot (2026-11-03): it only researches (step 6c, `plan-pending-guard.ts`),
   * so revising one plan never waits for another task — the window still counts it.
   */
  function ownerAdmission(ownerId: string, t: number, planning = false): TaskCommandResponse | null {
    if (!planning && ownerChain.has(ownerId)) {
      return refuse(429, 'one dashboard task runs at a time — wait for it to finish');
    }
    const recent = (starts.get(ownerId) ?? []).filter((at) => t - at < windowMs);
    if (recent.length >= maxStarts) return refuse(429, 'too many dashboard task starts — try again shortly');
    return null;
  }

  /**
   * E4 ③ — the tree's admission (§2.1), instead of A0's slot: one tree per
   * owner, at most `maxTreeChildren` children running, a host start refused
   * over the cost limit, and the tree's own window (a new epic's first start
   * is A0's window). No side effect. A plan turn skips the slot (one tree,
   * its running children), as `ownerAdmission` does; the cost limit and the window still apply.
   */
  function treeAdmission(
    ownerId: string,
    tree: TreeStart,
    t: number,
    newTask: boolean,
    planning = false,
  ): TaskCommandResponse | null {
    const held = planning ? undefined : ownerTree.get(ownerId);
    if (held && held.root !== tree.root) return refuse(429, 'one epic runs at a time — wait for its tree to finish');
    if (tree.role === 'child' && held) {
      let children = 0;
      for (const key of held.running.keys()) if (key !== held.root) children++;
      if (children >= maxTreeChildren) {
        return refuse(429, `at most ${maxTreeChildren} children of an epic run at once — wait for one to finish`);
      }
    }
    if (tree.initiator === 'host' && tree.root !== undefined && deps.treeCostUsd) {
      const limit = deps.epicCostLimitUsd?.(ownerId) ?? DEFAULT_EPIC_COST_LIMIT_USD;
      if (deps.treeCostUsd(tree.root) >= limit) {
        return refuse(429, `this epic reached its cost limit ($${limit}) — an instruction from its owner still runs`);
      }
    }
    if (tree.root === undefined || (newTask && tree.role === 'root')) {
      const recent = (starts.get(ownerId) ?? []).filter((at) => t - at < windowMs);
      if (recent.length >= maxStarts) return refuse(429, 'too many dashboard task starts — try again shortly');
      return null;
    }
    const recent = (treeStarts.get(tree.root) ?? []).filter((at) => t - at < windowMs);
    if (recent.length >= maxTreeStarts) return refuse(429, 'too many starts in this epic — try again shortly');
    return null;
  }

  function canStart(
    ownerId: string,
    text?: string,
    tree?: TreeStart,
    opts: { planning?: boolean } = {},
  ): TaskCommandResponse | null {
    if (!accepting) return refuse(503, 'the service is shutting down — try again shortly');
    if (text !== undefined && deps.goalCommands?.matches(text)) {
      // #865 — a new task starts with work or a goal: a goal command with no goal to act on makes a dead task.
      if (!deps.goalCommands.opensGoal(text)) return refuse(400, GOAL_COMMAND_NEEDS_GOAL);
    } else if (text !== undefined && isCommand(text.trim())) {
      return refuse(400, COMMAND_REFUSED);
    }
    const planning = opts.planning === true;
    if (!tree) return ownerAdmission(ownerId, now(), planning);
    // §2.1: the root of a running tree starts again only once its own chain ended (the start's 409).
    if (tree.role === 'root' && tree.root !== undefined && chains.has(tree.root)) {
      return refuse(409, 'a turn is already running on this task');
    }
    return treeAdmission(ownerId, tree, now(), tree.root === undefined, planning);
  }

  /** E4 ③ — free a tree member's place only while this chain holds it; the tree goes when it is empty. */
  function releaseTree(chain: Chain, sessionKey: string): void {
    const held = ownerTree.get(chain.ownerId);
    if (!held || held.running.get(sessionKey) !== chain) return;
    held.running.delete(sessionKey);
    if (held.running.size === 0) ownerTree.delete(chain.ownerId);
  }

  /** Release the slot a chain holds: A0's for an ordinary task, its tree member's for an epic or child. */
  function releaseSlot(chain: Chain, sessionKey: string): void {
    if (chain.planning) return;
    if (chain.tree !== undefined) releaseTree(chain, sessionKey);
    else if (ownerChain.get(chain.ownerId) === sessionKey) ownerChain.delete(chain.ownerId);
  }

  /**
   * Who may send these words to this task at all — the part of the admission a
   * goal command meets too (#865): a live dashboard task, a signed-in sender,
   * no files, not a command (a goal command is let through), an epic tree's
   * owner rule, not being closed. Slots, windows and a running chain are the
   * start's alone ({@link admit}).
   */
  function gate(
    request: TaskCommandRequest,
    opts: { answer?: boolean; goalCommand?: boolean } = {},
  ):
    | {
        ok: true;
        session: ConversationSession;
        ctx: ExecutionContext;
        text: string;
        tree: ReturnType<typeof treeOf>;
      }
    | { ok: false; response: TaskCommandResponse } {
    if (!accepting) return { ok: false, response: refuse(503, 'the service is shutting down — try again shortly') };
    const session = deps.getSession(request.sessionKey);
    if (!session || session.slackless !== true) return { ok: false, response: refuse(409, 'not a dashboard task') };
    // The turn runs as the user who starts it (SSOT 2026-11-02, as a Slack turn
    // runs as its speaker): anyone signed in — nobody starts nothing.
    if (!request.actorUserId) {
      return { ok: false, response: refuse(403, 'a dashboard task runs as the user who instructs it — sign in') };
    }
    if (request.attachments && request.attachments.length > 0) {
      return { ok: false, response: refuse(400, 'attachments are not supported on a dashboard task yet') };
    }
    const text = request.text.trim();
    if (opts.answer) {
      // An answer is not a command (#637 R1): `%…` is only a Slack router's
      // prefix and runs as text. A leading `/word` would be read as a command
      // by the SDK, so that one answer is refused with its reason.
      if (SLASH_COMMAND.test(text)) {
        return {
          ok: false,
          response: refuse(
            422,
            'this answer would be read as a command — rephrase it as a free-form instruction that does not start with /',
          ),
        };
      }
    } else if (!opts.goalCommand && isCommand(text)) {
      return { ok: false, response: refuse(400, COMMAND_REFUSED) };
    }
    let ctx: ExecutionContext;
    try {
      ctx = deps.buildExecutionContext(session, request.actorUserId);
    } catch (error) {
      return { ok: false, response: refuse(409, `task cannot run: ${(error as Error)?.message ?? String(error)}`) };
    }
    const tree = treeOf(session, request.sessionKey);
    // An epic's children start as its owner (host starts): another user's word
    // to an epic tree would run as the owner one hop later — only an admin's.
    if (tree && request.actorUserId !== session.ownerId && !ctx.isAdmin) {
      return { ok: false, response: refuse(403, EPIC_OWNER_ONLY) };
    }
    // E4 ⑦ — a task being closed, or a child of an epic being closed, starts nothing (fable #703 R1).
    if (session.closing || (tree && tree.root !== request.sessionKey && deps.getSession(tree.root)?.closing)) {
      return { ok: false, response: refuse(409, 'the task is being closed') };
    }
    return { ok: true, session, ctx, text, tree };
  }

  function admit(
    request: TaskCommandRequest,
    opts: { answer?: boolean } = {},
  ):
    | {
        ok: true;
        session: ConversationSession;
        ctx: ExecutionContext;
        ownerId: string;
        startedAt: number;
        tree?: string;
        /** A plan turn: admitted without a slot, and holds none while it runs. */
        planning: boolean;
        /** The window this start counted in (A0's or its tree's), by map and key — read again to refund. */
        window: { map: Map<string, number[]>; key: string };
      }
    | { ok: false; response: TaskCommandResponse } {
    const gated = gate(request, opts);
    if (!gated.ok) return gated;
    const { session, ctx, text, tree } = gated;
    if (chains.has(request.sessionKey)) {
      // The dashboard's word waits for the chain's end; a host start and an answer are refused.
      if (request.queueWhileRunning && !opts.answer) {
        return {
          ok: false,
          response: enqueue(session, request.sessionKey, text, request.actorUserId, {
            approvedOnce: request.approvedOnce === true,
            goalOpeningId: request.goalOpeningId,
          }),
        };
      }
      return { ok: false, response: refuse(409, 'a turn is already running on this task') };
    }
    // The owner's slot and window, whoever starts it: the task is the owner's.
    const ownerId = session.ownerId as string;
    const t = now();
    const newTask = request.newTask === true;
    // A plan turn (the plan not started yet) only researches: no slot (2026-11-03).
    const planning = isPlanPending(session.taskPlan);
    const refusal = tree
      ? treeAdmission(ownerId, { ...tree, initiator: request.initiator }, t, newTask, planning)
      : ownerAdmission(ownerId, t, planning);
    if (refusal) return { ok: false, response: refusal };
    // The window this start counts in: A0's per owner, or the tree's (a new epic's first start is A0's).
    const [windows, windowKey] =
      tree && !(newTask && tree.role === 'root') ? [treeStarts, tree.root] : [starts, ownerId];
    const recent = (windows.get(windowKey) ?? []).filter((at) => t - at < windowMs);
    recent.push(t);
    windows.set(windowKey, recent);
    return {
      ok: true,
      session,
      ctx,
      ownerId,
      startedAt: t,
      tree: tree?.root,
      planning,
      window: { map: windows, key: windowKey },
    };
  }

  function start(request: TaskCommandRequest): Promise<TaskCommandResponse> {
    // #865 — a goal's opening starts only while its goal's first turn is still owed: whatever path
    // it came by (the drain, an approval released later), one cleared, paused, done or already
    // opened meanwhile is refused here, never run as the user's words.
    if (request.goalOpeningId !== undefined) {
      const session = deps.getSession(request.sessionKey);
      if (!session || !openingOwed(session, request.goalOpeningId)) {
        return Promise.resolve(refuse(409, GOAL_OPENING_STALE));
      }
    }
    const goals = deps.goalCommands;
    // #865 — a person's `goal …` is the host's goal command (a goal's own opening and host starts never are).
    if (
      goals &&
      request.initiator !== 'host' &&
      request.goalContinuation !== true &&
      request.goalOpeningId === undefined &&
      goals.matches(request.text)
    ) {
      const gated = gate(request, { goalCommand: true });
      if (!gated.ok) return Promise.resolve(gated.response);
      return goals.run({ ...request, text: gated.text }, gated.session);
    }
    return startChain(request, {});
  }

  async function startChain(request: TaskCommandRequest, opts: { answer?: boolean }): Promise<TaskCommandResponse> {
    const admitted = admit(request, opts);
    if (!admitted.ok) return admitted.response;
    const { session, ctx, ownerId, startedAt, tree, planning, window } = admitted;
    const { sessionKey } = request;
    // Who instructs it now (SSOT 2026-11-02): the dashboard sends them the turn's live updates.
    session.currentInitiatorId = ctx.userId;
    // A synthetic goal turn is not user input; a person's word (not a host start) is.
    const userInput = request.goalContinuation !== true;
    // A goal's opening is the user's objective, but not a new word to the goal it opens (#876 R2, grok P2):
    // it does not reset that goal's count.
    if (userInput && request.initiator !== 'host' && request.goalOpeningId === undefined) {
      try {
        deps.onUserInstruction?.(sessionKey, session);
      } catch (error) {
        deps.logger.warn('onUserInstruction raised', { sessionKey, error: (error as Error)?.message });
      }
    }

    // A new instruction supersedes an open question, as a new Slack message
    // does; the turn's saved start persists the cleared panel. A start that is
    // not saved puts it back — the 500 means nothing happened (grok #634 R1).
    // #865 — a goal's opening starting: its goal's first turn is no longer owed (saved with the
    // turn's start). A start that does not happen owes it again (below).
    const openedGoal =
      request.goalOpeningId !== undefined && session.goal?.goalId === request.goalOpeningId ? session.goal : undefined;
    if (openedGoal) openedGoal.openingPending = undefined;

    const panel = session.actionPanel;
    const openQuestion = panel
      ? { pendingQuestion: panel.pendingQuestion, pendingChoice: panel.pendingChoice, waiting: panel.waitingForChoice }
      : undefined;
    if (panel) {
      panel.pendingQuestion = undefined;
      panel.pendingChoice = undefined;
      panel.waitingForChoice = false;
    }

    // Plan mode (SSOT 2026-11-02) — an instruction to a task whose plan is not started is
    // direct input (or a new plan after a cancel): the plan goes back to drafting in the
    // turn's saved start. A start that does not happen puts the gate back (below).
    const planBefore = session.taskPlan;
    const planned = planGateTurn(planBefore, now());
    if (planned.gate !== planBefore) session.taskPlan = planned.gate;

    const abort = new AbortController();
    deps.coordinator.setController(sessionKey, abort);
    let markStarted!: () => void;
    let chainStarted = false;
    const started = new Promise<'started'>((resolve) => {
      markStarted = () => {
        chainStarted = true;
        resolve('started');
      };
    });
    const progress: ChainProgress = { committedBeforeStart: false };
    // E2 ③ — every hop of this chain carries its id; the chain is open from
    // its first saved start until its last outcome (or reconciliation).
    const chainId = randomUUID();
    // E4 ⑥ (D7, D9 e) — any start of an epic (a wake, or the owner's own word) takes its pending events.
    const consume = session.kind === 'epic' ? wakeableEpicEvents(session.epicEvents).map((e) => e.id) : [];
    const done = runChain(
      sessionKey,
      session,
      ctx,
      request.text.trim(),
      abort,
      markStarted,
      progress,
      chainId,
      consume,
      [planned.notice, request.promptNotice].filter((n): n is string => !!n).join('\n\n') || undefined,
      userInput,
      request.initiator === 'host',
      request.promptNotice,
    );
    const chain: Chain = { ownerId, id: chainId, abort, done, planning, ...(tree !== undefined ? { tree } : {}) };
    chains.set(sessionKey, chain);
    // A plan turn holds no slot: the owner's work, or another plan, starts beside it.
    if (!planning && tree === undefined) {
      ownerChain.set(ownerId, sessionKey);
    } else if (!planning && tree !== undefined) {
      // E4 ③ — the tree's slot: made by its first running member, kept while any runs.
      let held = ownerTree.get(ownerId);
      if (!held) {
        held = { root: tree, running: new Map() };
        ownerTree.set(ownerId, held);
      }
      held.running.set(sessionKey, chain);
    }
    const finished = done.finally(() => {
      deps.coordinator.removeController(sessionKey, abort);
      if (chains.get(sessionKey) === chain) chains.delete(sessionKey);
      releaseSlot(chain, sessionKey);
      // The queued word first: it outranks an epic's wake, which finds the task busy then.
      drainFollowups(sessionKey, {
        started: chainStarted,
        stopped: abort.signal.aborted,
        outcome: progress.lastOutcome,
      });
      try {
        deps.onChainEnd?.(sessionKey, {
          started: chainStarted,
          stopped: abort.signal.aborted,
          ...(progress.lastOutcome ? { outcome: progress.lastOutcome } : {}),
        });
      } catch (error) {
        deps.logger.warn('onChainEnd raised', { sessionKey, error: (error as Error)?.message });
      }
    });

    const first = await Promise.race([started, finished.then(() => 'ended' as const)]);
    if (first === 'started') return { status: 202, body: { ok: true }, done: finished };
    // Not started: this start does not count against its window (#634 R1) — A0's or the tree's.
    // The window is read again: another start in the meantime replaced its array (fable #695 R1).
    const counted = window.map.get(window.key);
    const at = counted?.lastIndexOf(startedAt) ?? -1;
    if (counted && at >= 0) counted.splice(at, 1);
    // A chain that already committed an outcome (conversation not created) saved the
    // cleared panel with it: putting the question back in memory would diverge from disk.
    if (panel && openQuestion && !progress.committedBeforeStart) {
      panel.pendingQuestion = openQuestion.pendingQuestion;
      panel.pendingChoice = openQuestion.pendingChoice;
      panel.waitingForChoice = openQuestion.waiting;
    }
    if (planned.gate !== planBefore && !progress.committedBeforeStart && session.taskPlan === planned.gate) {
      session.taskPlan = planBefore;
    }
    if (openedGoal && session.goal === openedGoal && !progress.committedBeforeStart) openedGoal.openingPending = true;
    return refuse(500, 'the task turn could not start');
  }

  async function runChain(
    sessionKey: string,
    session: ConversationSession,
    ctx: ExecutionContext,
    instruction: string,
    chainAbort: AbortController,
    markStarted: () => void,
    progress: ChainProgress,
    chainId: string,
    consume: readonly string[] = [],
    planNotice?: string,
    /** False for a synthetic goal turn — its `/compact` replay stays synthetic too. */
    userInput = true,
    /**
     * A host start (an epic's wake or instruction, the goal loop): every hop is a host turn — its
     * words are soma-work's, recorded as `system`, and they can never set a goal (SET_GOAL gate).
     */
    hostStart = false,
    /**
     * The start's host notice (`promptNotice`): on the first hop with the plan notice, and again on the
     * hop that re-runs the instruction after a fallback `/compact` — the compaction left the model
     * without it, and the instruction is the same (trinity R4, astra P1).
     */
    hostNotice?: string,
  ): Promise<void> {
    let text = instruction;
    let compactHop = false;
    let isUserInput = userInput;
    let replay: string | null = null;
    /** The next hop re-runs the stashed instruction after a fallback `/compact`. */
    let replaying = false;
    /** A turn that returned non-terminal for a re-entry not yet started: it owns the task (#634 R1). */
    let pendingTurnId: string | null = null;
    let hopStarted = false;
    const endPending = async (decided: Omit<TaskTurnOutcomeRecord, 'turnId' | 'at'>) => {
      if (!pendingTurnId) return;
      const turnId = pendingTurnId;
      pendingTurnId = null;
      progress.lastOutcome = decided.outcome;
      try {
        await deps.runner.abandonTurn(sessionKey, turnId, decided, chainId);
      } catch (error) {
        deps.logger.error('A pending task turn could not be ended', {
          sessionKey,
          turnId,
          error: (error as Error)?.message,
        });
      }
    };
    try {
      for (let dispatch = 1; dispatch <= maxDispatches; dispatch++) {
        if (chainAbort.signal.aborted) {
          // Stopped between hops: the pending turn ends here, not on the 1M model in
          // `working`. A shutdown leaves it for restart reconciliation.
          const reason = chainAbort.signal.reason;
          if (reason !== 'shutdown') await endPending(abandonOutcome(reason));
          else if (pendingTurnId) strand(sessionKey, pendingTurnId, chainId);
          return;
        }
        const last = dispatch === maxDispatches;
        hopStarted = false;
        if (dispatch > 1) {
          // The context is per turn, never cached (execution-context.ts): rebuilt
          // for every hop — for the same user — so a revoked owner or moved directory stops the chain.
          try {
            ctx = deps.buildExecutionContext(session, ctx.userId);
          } catch (error) {
            await endPending({
              outcome: 'interrupted',
              category: 'Exception',
              reason: `task cannot run: ${(error as Error)?.message ?? String(error)}`,
            });
            return;
          }
          // The epic rule again for this hop's context: an admin removed mid-chain stops it (trinity R1 P3).
          if (treeOf(session, sessionKey) && ctx.userId !== session.ownerId && !ctx.isAdmin) {
            await endPending({ outcome: 'interrupted', category: 'Exception', reason: EPIC_OWNER_ONLY });
            return;
          }
        }
        /** This hop is a `/compact` whose completion re-runs the stashed instruction — one predicate for the settle and the re-run. */
        const continues = compactHop && replay !== null && !last;
        const hop = new AbortController();
        const forward = () => hop.abort(chainAbort.signal.reason);
        chainAbort.signal.addEventListener('abort', forward, { once: true });
        let result: RunTaskTurnResult;
        try {
          result = await deps.runner.runTaskTurn({
            sessionKey,
            executionContext: ctx,
            text,
            params: {
              abortController: hop,
              // The speaker: the owner by name, another user who instructed it by id (SSOT 2026-11-02).
              userName: ctx.userId === session.ownerId ? (session.ownerName ?? ctx.userId) : ctx.userId,
              workingDirectory: ctx.workingDirectory,
              processedFiles: [],
              isUserInput,
              ...(hostStart ? { hostTurn: true } : {}),
              say: async () => ({}),
              // Plan mode — the first hop carries the notice its start decided (before the
              // gate went back to drafting); a later hop reads the task as it is now.
              ...noticeParam(
                dispatch === 1
                  ? planNotice
                  : [planGateTurn(session.taskPlan, now()).notice, replaying ? hostNotice : undefined]
                      .filter((n): n is string => !!n)
                      .join('\n\n') || undefined,
              ),
            },
            resumable: last ? ['shutdown'] : ['fallbackCompact', 'shutdown'],
            notResumedReasons: {
              continuation: CONTINUATION_REFUSED,
              ...(last ? { fallbackCompact: BUDGET_SPENT } : {}),
            } satisfies Partial<Record<TaskTurnNonTerminal, string>>,
            ...(compactHop ? { compactHop: true } : {}),
            // The first hop's saved start consumes the epic's events (E4 ⑥).
            ...(dispatch === 1 && consume.length ? { consume } : {}),
            // A completed `/compact` hop continues the chain only when there is
            // an instruction to re-run and budget left (`continues`, below); with
            // nothing to re-run it ends the chain as a failure, never a result.
            chain: {
              id: chainId,
              continuesIfCompleted: continues,
              ...(compactHop && !continues ? { completedFailsWith: COMPACT_NOT_RERUN } : {}),
            },
            onStarted: () => {
              hopStarted = true;
              // The new hop's saved start took the task from the pending turn.
              pendingTurnId = null;
              // The chain's end is this hop's to decide now, not an earlier hop's (review R1, astra P1).
              progress.lastOutcome = undefined;
              markStarted();
            },
          });
        } finally {
          chainAbort.signal.removeEventListener('abort', forward);
        }

        if (result.outcome && !hopStarted) progress.committedBeforeStart = true;
        if (result.outcome) {
          progress.lastOutcome = result.outcome.outcome;
          // A compaction that the boundary proved, with budget left: run the
          // instruction it was stashed for. Nothing else is ever re-run (D10).
          if (continues && replay !== null && result.outcome.outcome === 'completed') {
            // The completed compaction owns the task until the re-run's start is
            // saved: a re-run that cannot start ends it, and the chain, here (fable #666).
            pendingTurnId = result.turnId;
            text = replay;
            replay = null;
            compactHop = false;
            isUserInput = userInput;
            replaying = true;
            continue;
          }
          return;
        }
        if (!result.fenced && result.nonTerminal === 'shutdown') strand(sessionKey, result.turnId, chainId);
        if (result.fenced || result.nonTerminal !== 'fallbackCompact') return;
        pendingTurnId = result.turnId;
        // The stash is nulled at the compaction boundary: take it now.
        // An empty stash is nothing to re-run (fable #666 P2).
        replay = session.fallbackCompactPendingUserText || null;
        text = COMPACT;
        compactHop = true;
        isUserInput = false;
        // The `/compact` hop is a bare command: no notice on it (the re-run after it gets the host notice).
        replaying = false;
      }
    } catch (error) {
      deps.logger.error('Task turn chain ended by a throw', { sessionKey, error: (error as Error)?.message });
      // A throw is no healthy end, whatever an earlier hop committed (review R1, astra P1).
      progress.lastOutcome = undefined;
      // A hop that never started leaves the pending turn owning the task: end it.
      if (!hopStarted) {
        await endPending({
          outcome: 'interrupted',
          category: 'Exception',
          reason: `turn start not saved: ${(error as Error)?.message ?? String(error)}`,
        });
      }
    }
  }

  /**
   * A turn a `shutdown` abort left `working`. While shutting down, restart
   * reconciliation records it; once the shutdown was refused (admission
   * re-opened) — even if this turn finished unwinding only after that — it is
   * ended here, since the process stays up (astra #634).
   */
  function strand(sessionKey: string, turnId: string, chainId: string): void {
    if (!accepting) {
      shutdownStranded.set(sessionKey, { turnId, chainId });
      return;
    }
    endStranded(sessionKey, turnId, chainId);
  }

  /** Endings of stranded turns still saving — Close waits for them (astra #634 R2). */
  const endings = new Map<string, Promise<void>>();

  function endStranded(sessionKey: string, turnId: string, chainId: string): void {
    const ending = deps.runner
      .abandonTurn(
        sessionKey,
        turnId,
        {
          outcome: 'interrupted',
          category: 'Exception',
          reason: 'service shutdown was cancelled',
        },
        chainId,
      )
      .then(
        () => undefined,
        (error) =>
          deps.logger.error('A turn stranded by a cancelled shutdown could not be ended', {
            sessionKey,
            turnId,
            error: (error as Error)?.message,
          }),
      )
      .finally(() => {
        if (endings.get(sessionKey) === ending) endings.delete(sessionKey);
      });
    endings.set(sessionKey, ending);
  }

  // ── The follow-up queue (2026-11-03) ──

  function followupsChanged(sessionKey: string): void {
    try {
      deps.onFollowupsChanged?.(sessionKey);
    } catch (error) {
      deps.logger.warn('onFollowupsChanged raised', { sessionKey, error: (error as Error)?.message });
    }
  }

  /** Tasks whose chain ended while shutting down with words still queued: a refused shutdown pauses them. */
  const heldByShutdown = new Set<string>();

  /** A word admitted like a start, while the task's chain runs: it waits for the chain's end. */
  function enqueue(
    session: ConversationSession,
    sessionKey: string,
    text: string,
    authorId: string,
    flags: { approvedOnce: boolean; goalOpeningId?: string },
  ): TaskCommandResponse {
    if (!text) return refuse(400, 'message is required');
    const queue = session.taskFollowups ?? [];
    if (queue.length >= maxQueued) {
      return refuse(429, `this task already has ${maxQueued} instructions waiting — send again once one has run`);
    }
    const item: TaskFollowupItem = {
      id: `tq-${randomUUID()}`,
      text,
      authorId,
      enqueuedAt: now(),
      epoch: 0,
      state: 'queued',
      ...(flags.approvedOnce ? { approvedText: text } : {}),
      ...(flags.goalOpeningId !== undefined ? { goalOpeningId: flags.goalOpeningId } : {}),
    };
    session.taskFollowups = [...queue, item];
    followupsChanged(sessionKey);
    return { status: 202, body: { ok: true, queued: true, itemId: item.id } };
  }

  /** Every queued word paused with `reason` (a new epoch each). True when one changed. */
  function pauseQueued(session: ConversationSession, reason: string): boolean {
    const queue = session.taskFollowups;
    if (!queue?.some((item) => item.state === 'queued')) return false;
    session.taskFollowups = queue.map((item) =>
      item.state === 'queued' ? { ...item, state: 'paused', stateReason: reason, epoch: item.epoch + 1 } : item,
    );
    return true;
  }

  /** #865 — answered by the host with no turn of its own: a goal command, or a goal's stale opening skipped. */
  const answeredWithoutTurn = (res: TaskCommandResponse): boolean => {
    const body = res.body as { goalCommand?: unknown; skipped?: unknown };
    return res.status === 200 && (body.goalCommand === true || body.skipped === true);
  };

  /**
   * #865 — a goal's opening is owed while its goal is the current, active goal whose first turn has
   * not started (`openingPending`, set when the goal opens, cleared when its opening's chain starts).
   */
  const openingOwed = (session: ConversationSession, goalId: string): boolean =>
    session.goal?.goalId === goalId && session.goal.status === 'active' && session.goal.openingPending === true;

  const heldForOwner = (res: TaskCommandResponse): boolean =>
    res.status === 202 && (res.body as { pendingApproval?: unknown }).pendingApproval === true;

  /**
   * A chain ended (the task is free again): a chain that ended well — its last
   * turn completed, or asked a question — runs the oldest queued word; one that
   * did not (a Stop, a failure, an interruption, a start that never happened)
   * pauses the queue, as a Slack session's queue drains only after a healthy
   * turn. A shutdown leaves the queue as it is (saved; the restart pauses it);
   * a task being closed takes it with it. Never throws.
   */
  function drainFollowups(
    sessionKey: string,
    end: { started: boolean; stopped: boolean; outcome?: TaskTurnOutcomeRecord['outcome'] },
  ): void {
    try {
      const session = deps.getSession(sessionKey);
      if (!session?.taskFollowups?.length) return;
      if (!accepting) {
        // A real restart pauses them on load; a refused one does in `resumeAccepting` (review R1, grok P1).
        if (session.taskFollowups.some((item) => item.state === 'queued')) heldByShutdown.add(sessionKey);
        return;
      }
      if (session.closing || session.terminated || chains.has(sessionKey)) return;
      const healthy = end.started && !end.stopped && (end.outcome === 'completed' || end.outcome === 'waiting');
      if (!healthy) {
        const reason = end.stopped ? TASK_FOLLOWUP_PAUSED_BY_STOP : TASK_FOLLOWUP_PAUSED_BY_UNHEALTHY_END;
        if (pauseQueued(session, reason)) followupsChanged(sessionKey);
        return;
      }
      runNextQueued(sessionKey, session);
    } catch (error) {
      deps.logger.warn('The task follow-up drain raised', { sessionKey, error: (error as Error)?.message });
    }
  }

  /**
   * Run the oldest queued word. One the owner must approve first leaves the
   * queue for the owner's hands and starts nothing — the next word runs then.
   */
  function runNextQueued(sessionKey: string, session: ConversationSession): void {
    const next = session.taskFollowups?.find((item) => item.state === 'queued');
    if (!next) return;
    void runQueued(sessionKey, session, next).then(
      (res) => {
        // Nothing started (in the owner's hands, or answered without a turn): the next word runs now.
        if (!(heldForOwner(res) || answeredWithoutTurn(res)) || !accepting || session.closing || session.terminated) {
          return;
        }
        if (chains.has(sessionKey) || deps.getSession(sessionKey) !== session) return;
        runNextQueued(sessionKey, session);
      },
      (error) =>
        deps.logger.error('A queued task instruction could not be started', {
          sessionKey,
          error: (error as Error)?.message,
        }),
    );
  }

  /**
   * Start a queued word as its writer, through the same admission as any
   * start: it leaves the queue as it becomes the turn. A refused start puts it
   * back where it was, paused with the refusal — or still queued, when another
   * start took the task first (its chain's end runs it). The start's admission
   * runs before this function's first await, so the task is busy when it returns.
   */
  async function runQueued(
    sessionKey: string,
    session: ConversationSession,
    item: TaskFollowupItem,
  ): Promise<TaskCommandResponse> {
    // In flight but still on record until its handoff is confirmed (review R2, astra P0): a restart
    // now finds it `sending` and brings it back paused, saying it may have gone out — never lost.
    const sending: TaskFollowupItem = { ...item, state: 'sending', stateReason: undefined, epoch: item.epoch + 1 };
    replaceFollowup(session, item.id, sending);
    followupsChanged(sessionKey);
    const settle = (next: TaskFollowupItem | undefined) => {
      replaceFollowup(session, item.id, next);
      followupsChanged(sessionKey);
    };
    // #865 — a goal's opening runs only while its goal is still the active goal.
    if (item.goalOpeningId !== undefined && !openingOwed(session, item.goalOpeningId)) {
      settle(undefined);
      deps.goalCommands?.openingDropped(sessionKey, session, item.goalOpeningId, 'stale');
      return { status: 200, body: { ok: true, skipped: true, message: GOAL_OPENING_STALE } };
    }
    let res: TaskCommandResponse;
    try {
      // #767 backstop: words its one-time approval does not cover are the owner's to allow (review R1).
      const covered = item.approvedText !== undefined && item.approvedText === item.text;
      const gate = covered ? undefined : deps.holdQueued?.(sessionKey, session, item);
      const held = gate ? await gate : undefined;
      if (held && held.status < 400) {
        settle(undefined); // in the owner's hands now (the approval store has it): nothing more is owed here
        return held;
      }
      res =
        held ??
        (await start({
          sessionKey,
          text: item.text,
          actorUserId: item.authorId,
          ...(item.goalOpeningId !== undefined ? { goalOpeningId: item.goalOpeningId } : {}),
        }));
    } catch (error) {
      // Never lost (review R1, grok/fable P2): back where it was, paused with why.
      res = refuse(500, `the task turn could not start: ${(error as Error)?.message ?? String(error)}`);
    }
    // Started: its turn's start is saved, so it is the turn now. A goal command
    // answered without a turn (#865) is done with too — never put back as refused.
    if (res.status === 202 || answeredWithoutTurn(res)) {
      settle(undefined);
      return res;
    }
    if (session.closing || session.terminated) return res;
    const busy = res.status === 409 && chains.has(sessionKey);
    const why = String((res.body as { error?: unknown })?.error ?? `HTTP ${res.status}`);
    const back: TaskFollowupItem = busy
      ? { ...item, state: 'queued', stateReason: undefined, epoch: sending.epoch + 1 }
      : { ...item, state: 'paused', stateReason: why, epoch: sending.epoch + 1 };
    // Refused (not merely beaten to the task): no chain end is coming for the words behind it (fable P2).
    if (!busy) pauseQueued(session, TASK_FOLLOWUP_PAUSED_BEHIND_REFUSED);
    settle(back);
    return res;
  }

  /** Put `next` in the place of the word `id` (none: take it off). Its place in line is kept. */
  function replaceFollowup(session: ConversationSession, id: string, next: TaskFollowupItem | undefined): void {
    const queue = session.taskFollowups ?? [];
    session.taskFollowups = next
      ? queue.map((entry) => (entry.id === id ? next : entry))
      : queue.filter((entry) => entry.id !== id);
  }

  async function actOnQueue(request: TaskQueueActRequest): Promise<TaskQueueActOutcome> {
    const no = (status: number, message: string): TaskQueueActOutcome => ({ ok: false, status, message });
    const { sessionKey } = request;
    const session = deps.getSession(sessionKey);
    if (!session || session.slackless !== true) return no(409, 'not a dashboard task');
    const queue = session.taskFollowups ?? [];
    const item = queue.find((entry) => entry.id === request.itemId);
    if (!item) return no(404, 'this instruction is no longer waiting');
    if (item.epoch !== request.epoch) return no(409, 'this instruction has changed — reload');
    if (item.state === 'sending') return no(409, 'this instruction is being sent — wait for it to settle');
    const writer = !!request.actorUserId && request.actorUserId === item.authorId;
    if (request.op === 'edit') {
      if (!writer) return no(403, 'only the person who wrote it can edit it');
      const text = (request.text ?? '').trim();
      if (!text) return no(400, 'text is required');
      // A goal's first turn is its objective (#876 R2, fable P2): cancel it instead — the goal pauses.
      if (item.goalOpeningId !== undefined) return no(409, GOAL_OPENING_NOT_EDITABLE);
      if (isCommand(text)) return no(400, COMMAND_REFUSED);
      // A goal command is never queued: it applies at once (#865).
      if (deps.goalCommands?.matches(text)) return no(400, GOAL_COMMAND_NOT_QUEUED);
      session.taskFollowups = queue.map((entry) =>
        entry === item ? { ...entry, text, epoch: entry.epoch + 1 } : entry,
      );
      followupsChanged(sessionKey);
      return { ok: true };
    }
    if (!writer && request.manages !== true) {
      return no(403, 'only the person who wrote it, or who manages the task, can do this');
    }
    if (request.op === 'cancel') {
      session.taskFollowups = queue.filter((entry) => entry !== item);
      followupsChanged(sessionKey);
      // #865 — a goal's first turn cancelled: the goal does not stay active with no first turn.
      if (item.goalOpeningId !== undefined) {
        deps.goalCommands?.openingDropped(sessionKey, session, item.goalOpeningId, 'cancelled');
      }
      return { ok: true, message: TASK_FOLLOWUP_CANCELLED };
    }
    // Send now.
    if (session.closing || session.terminated) return no(409, 'the task is being closed');
    if (chains.has(sessionKey)) {
      // A task turn takes no word mid-turn yet: first in line, run at this chain's end.
      const first: TaskFollowupItem = { ...item, state: 'queued', stateReason: undefined, epoch: item.epoch + 1 };
      session.taskFollowups = [first, ...queue.filter((entry) => entry !== item)];
      followupsChanged(sessionKey);
      return { ok: true, message: TASK_FOLLOWUP_FIRST_IN_LINE };
    }
    const res = await runQueued(sessionKey, session, item);
    if (heldForOwner(res) || answeredWithoutTurn(res)) {
      const said = (res.body as { message?: unknown }).message;
      return typeof said === 'string' && said ? { ok: true, message: said } : { ok: true };
    }
    if (res.status === 202) return { ok: true };
    return no(res.status, String((res.body as { error?: unknown })?.error ?? `HTTP ${res.status}`));
  }

  async function answer(request: TaskAnswerRequest): Promise<TaskCommandResponse> {
    const session = deps.getSession(request.sessionKey);
    if (!session || session.slackless !== true) return refuse(409, 'not a dashboard task');
    // The answer runs as the user who sends it (SSOT 2026-11-02): anyone signed
    // in — nobody answers nothing (admission checks it again for every start).
    if (!request.actorUserId) {
      return refuse(403, 'a dashboard task runs as the user who answers it — sign in');
    }
    const question = session.actionPanel?.pendingQuestion as { askId?: string } | undefined;
    if (session.activityState !== 'waiting' || !question) {
      return refuse(409, 'the task is not waiting for an answer');
    }
    if (question.askId !== request.askId) return refuse(409, 'the question has changed — reload');
    const built = buildTaskAnswerText(question, request.answer);
    if (!built.ok) return refuse(built.status, built.error);
    // One answer per question (D4): `start` admits and clears the question
    // synchronously — before its first await — so a concurrent second answer
    // finds no open question. A refused or unsaved start leaves (or puts back)
    // the question, so the answer can be sent again.
    return startChain(
      { sessionKey: request.sessionKey, text: built.text, actorUserId: request.actorUserId },
      { answer: true },
    );
  }

  async function close(sessionKey: string): Promise<void> {
    const chain = chains.get(sessionKey);
    const waitMs = deps.closeWaitMs ?? 60_000;
    if (!chain) {
      // No chain, but a stranded turn's outcome may still be saving: the task
      // is removed only after it lands (or the bound passes).
      const ending = endings.get(sessionKey);
      if (ending) await boundedWait(ending, waitMs, sessionKey);
      return;
    }
    chain.abort.abort('session-close');
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      chain.done,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          deps.logger.warn('Task chain did not end before close — closing anyway', { sessionKey });
          // The chain was aborted and its task is about to be removed: release
          // the task and the owner's slot now, or a hung chain would lock the
          // owner out for good (astra #634). Its late results are fenced by the
          // removed session.
          if (chains.get(sessionKey) === chain) chains.delete(sessionKey);
          releaseSlot(chain, sessionKey);
          deps.coordinator.removeController(sessionKey, chain.abort);
          resolve();
        }, waitMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  async function boundedWait(work: Promise<void>, waitMs: number, sessionKey: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          deps.logger.warn('A stranded turn was still saving at close — closing anyway', { sessionKey });
          resolve();
        }, waitMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  return {
    start,
    answer,
    canStart,
    close,
    stopAccepting: () => {
      accepting = false;
    },
    resumeAccepting: () => {
      accepting = true;
      // The shutdown was refused and the process stays up: nobody will reconcile
      // the turns its abort left `working` — end them now (#634 R1).
      for (const [sessionKey, { turnId, chainId }] of shutdownStranded) {
        shutdownStranded.delete(sessionKey);
        endStranded(sessionKey, turnId, chainId);
      }
      // Words a shutdown's abort left queued: their chain was cut, and none will end to run them (review R1, grok P1).
      for (const sessionKey of heldByShutdown) {
        heldByShutdown.delete(sessionKey);
        const session = deps.getSession(sessionKey);
        if (!session || session.closing || session.terminated || chains.has(sessionKey)) continue;
        if (pauseQueued(session, TASK_FOLLOWUP_PAUSED_BY_UNHEALTHY_END)) followupsChanged(sessionKey);
      }
    },
    isRunning: (sessionKey) => chains.has(sessionKey),
    runningChain: (sessionKey) => chains.get(sessionKey)?.id,
    actOnQueue,
  };
}

/** What a chain's hops leave for its end: whether a turn committed before any start, and its last outcome. */
interface ChainProgress {
  committedBeforeStart: boolean;
  /** The chain's last outcome (a committed turn, or an abandoned pending one); none when it threw. */
  lastOutcome?: TaskTurnOutcomeRecord['outcome'];
}

function abandonOutcome(reason: unknown): Omit<TaskTurnOutcomeRecord, 'turnId' | 'at'> {
  if (reason === 'user-stop') return { outcome: 'cancelled', category: 'Exception', reason: 'stopped by user' };
  if (reason === 'session-close') return { outcome: 'cancelled', category: 'Exception', reason: 'task closed' };
  return { outcome: 'interrupted', category: 'Exception', reason: `stopped between steps (${String(reason)})` };
}
