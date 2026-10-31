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
import type { ConversationSession, TaskTurnOutcomeRecord } from '../types';
import { buildTaskAnswerText, type TaskAnswer } from './task-answer';
import type { RunTaskTurnInput, RunTaskTurnResult, TaskTurnNonTerminal } from './task-turn-runner';

export interface TaskCommandRequest {
  sessionKey: string;
  text: string;
  attachments?: readonly unknown[];
  /** The signed-in user sending it; the turn runs as the owner, so only the owner may (#637 R2). */
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
}

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
  /** `executionContextForTask` — throws `ExecutionContextMissingError` with the reason. */
  buildExecutionContext(session: ConversationSession): ExecutionContext;
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
}

/** #599 ⑤ — a dashboard answer to the task's open question, bound to its `askId`. */
export interface TaskAnswerRequest {
  sessionKey: string;
  askId: string;
  answer: TaskAnswer;
  /** The signed-in user answering; only the task's owner may (#637 R1). */
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
   */
  canStart(ownerId: string, text?: string, tree?: TreeStart): TaskCommandResponse | null;
  /** Abort the task's chain with `session-close` and wait (bounded) for it to end. */
  close(sessionKey: string): Promise<void>;
  /** Shutdown: refuse new starts (503). Running chains end through the coordinator's `shutdown` abort. */
  stopAccepting(): void;
  /** A refused shutdown (the bot stays up): accept starts again (#634 R1). */
  resumeAccepting(): void;
  isRunning(sessionKey: string): boolean;
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
const BUDGET_SPENT = 're-entry limit reached';
/** E2 ③ — the end of a chain whose `/compact` hop completed with no instruction re-run. */
const COMPACT_NOT_RERUN = 'compacted, but the instruction was not re-run (압축 뒤 재실행 못 함)';

interface Chain {
  ownerId: string;
  abort: AbortController;
  done: Promise<void>;
  /** E4 ③ — the epic tree it runs in (its root's key), or none for an ordinary task. */
  tree?: string;
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

export function createTaskTurnController(deps: TaskTurnControllerDeps): TaskTurnController {
  const maxDispatches = deps.maxDispatches ?? 3;
  const maxStarts = deps.maxStartsPerWindow ?? 10;
  const windowMs = deps.windowMs ?? 10 * 60_000;
  const now = deps.now ?? Date.now;
  const maxTreeChildren = deps.maxTreeChildren ?? 3;
  const maxTreeStarts = deps.maxTreeStartsPerWindow ?? 30;
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

  /** The owner-level part of admission (D9): no side effect. */
  function ownerAdmission(ownerId: string, t: number): TaskCommandResponse | null {
    if (ownerChain.has(ownerId)) return refuse(429, 'one dashboard task runs at a time — wait for it to finish');
    const recent = (starts.get(ownerId) ?? []).filter((at) => t - at < windowMs);
    if (recent.length >= maxStarts) return refuse(429, 'too many dashboard task starts — try again shortly');
    return null;
  }

  /**
   * E4 ③ — the tree's admission (§2.1), instead of A0's slot: one tree per
   * owner, at most `maxTreeChildren` children running, a host start refused
   * over the cost limit, and the tree's own window (a new epic's first start
   * is A0's window). No side effect.
   */
  function treeAdmission(ownerId: string, tree: TreeStart, t: number, newTask: boolean): TaskCommandResponse | null {
    const held = ownerTree.get(ownerId);
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

  function canStart(ownerId: string, text?: string, tree?: TreeStart): TaskCommandResponse | null {
    if (!accepting) return refuse(503, 'the service is shutting down — try again shortly');
    if (text !== undefined && isCommand(text.trim())) return refuse(400, COMMAND_REFUSED);
    return tree ? treeAdmission(ownerId, tree, now(), tree.root === undefined) : ownerAdmission(ownerId, now());
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
    if (chain.tree !== undefined) releaseTree(chain, sessionKey);
    else if (ownerChain.get(chain.ownerId) === sessionKey) ownerChain.delete(chain.ownerId);
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
        window: number[];
      }
    | { ok: false; response: TaskCommandResponse } {
    if (!accepting) return { ok: false, response: refuse(503, 'the service is shutting down — try again shortly') };
    const session = deps.getSession(request.sessionKey);
    if (!session || session.slackless !== true) return { ok: false, response: refuse(409, 'not a dashboard task') };
    // The turn runs under the owner's identity: only the owner starts one — an
    // instruction or an answer alike (#637 R2).
    if (!request.actorUserId || request.actorUserId !== session.ownerId) {
      return { ok: false, response: refuse(403, 'only the task owner can instruct or answer a dashboard task') };
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
    } else if (isCommand(text)) {
      return { ok: false, response: refuse(400, COMMAND_REFUSED) };
    }
    let ctx: ExecutionContext;
    try {
      ctx = deps.buildExecutionContext(session);
    } catch (error) {
      return { ok: false, response: refuse(409, `task cannot run: ${(error as Error)?.message ?? String(error)}`) };
    }
    if (chains.has(request.sessionKey)) {
      return { ok: false, response: refuse(409, 'a turn is already running on this task') };
    }
    const ownerId = ctx.userId;
    const t = now();
    const tree = treeOf(session, request.sessionKey);
    const newTask = request.newTask === true;
    const refusal = tree
      ? treeAdmission(ownerId, { ...tree, initiator: request.initiator }, t, newTask)
      : ownerAdmission(ownerId, t);
    if (refusal) return { ok: false, response: refusal };
    // The window this start counts in: A0's per owner, or the tree's (a new epic's first start is A0's).
    const [windows, windowKey] =
      tree && !(newTask && tree.role === 'root') ? [treeStarts, tree.root] : [starts, ownerId];
    const recent = (windows.get(windowKey) ?? []).filter((at) => t - at < windowMs);
    recent.push(t);
    windows.set(windowKey, recent);
    return { ok: true, session, ctx, ownerId, startedAt: t, tree: tree?.root, window: recent };
  }

  function start(request: TaskCommandRequest): Promise<TaskCommandResponse> {
    return startChain(request, {});
  }

  async function startChain(request: TaskCommandRequest, opts: { answer?: boolean }): Promise<TaskCommandResponse> {
    const admitted = admit(request, opts);
    if (!admitted.ok) return admitted.response;
    const { session, ctx, ownerId, startedAt, tree, window } = admitted;
    const { sessionKey } = request;

    // A new instruction supersedes an open question, as a new Slack message
    // does; the turn's saved start persists the cleared panel. A start that is
    // not saved puts it back — the 500 means nothing happened (grok #634 R1).
    const panel = session.actionPanel;
    const openQuestion = panel
      ? { pendingQuestion: panel.pendingQuestion, pendingChoice: panel.pendingChoice, waiting: panel.waitingForChoice }
      : undefined;
    if (panel) {
      panel.pendingQuestion = undefined;
      panel.pendingChoice = undefined;
      panel.waitingForChoice = false;
    }

    const abort = new AbortController();
    deps.coordinator.setController(sessionKey, abort);
    let markStarted!: () => void;
    const started = new Promise<'started'>((resolve) => {
      markStarted = () => resolve('started');
    });
    const progress = { committedBeforeStart: false };
    // E2 ③ — every hop of this chain carries its id; the chain is open from
    // its first saved start until its last outcome (or reconciliation).
    const chainId = randomUUID();
    const done = runChain(sessionKey, session, ctx, request.text.trim(), abort, markStarted, progress, chainId);
    const chain: Chain = { ownerId, abort, done, ...(tree !== undefined ? { tree } : {}) };
    chains.set(sessionKey, chain);
    if (tree === undefined) {
      ownerChain.set(ownerId, sessionKey);
    } else {
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
    });

    const first = await Promise.race([started, finished.then(() => 'ended' as const)]);
    if (first === 'started') return { status: 202, body: { ok: true }, done: finished };
    // Not started: this start does not count against its window (#634 R1) — A0's or the tree's.
    const at = window.lastIndexOf(startedAt);
    if (at >= 0) window.splice(at, 1);
    // A chain that already committed an outcome (conversation not created) saved the
    // cleared panel with it: putting the question back in memory would diverge from disk.
    if (panel && openQuestion && !progress.committedBeforeStart) {
      panel.pendingQuestion = openQuestion.pendingQuestion;
      panel.pendingChoice = openQuestion.pendingChoice;
      panel.waitingForChoice = openQuestion.waiting;
    }
    return refuse(500, 'the task turn could not start');
  }

  async function runChain(
    sessionKey: string,
    session: ConversationSession,
    ctx: ExecutionContext,
    instruction: string,
    chainAbort: AbortController,
    markStarted: () => void,
    progress: { committedBeforeStart: boolean },
    chainId: string,
  ): Promise<void> {
    let text = instruction;
    let compactHop = false;
    let isUserInput = true;
    let replay: string | null = null;
    /** A turn that returned non-terminal for a re-entry not yet started: it owns the task (#634 R1). */
    let pendingTurnId: string | null = null;
    let hopStarted = false;
    const endPending = async (decided: Omit<TaskTurnOutcomeRecord, 'turnId' | 'at'>) => {
      if (!pendingTurnId) return;
      const turnId = pendingTurnId;
      pendingTurnId = null;
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
          // for every hop, so a revoked owner or moved directory stops the chain.
          try {
            ctx = deps.buildExecutionContext(session);
          } catch (error) {
            await endPending({
              outcome: 'interrupted',
              category: 'Exception',
              reason: `task cannot run: ${(error as Error)?.message ?? String(error)}`,
            });
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
              userName: session.ownerName ?? ctx.userId,
              workingDirectory: ctx.workingDirectory,
              processedFiles: [],
              isUserInput,
              say: async () => ({}),
            },
            resumable: last ? ['shutdown'] : ['fallbackCompact', 'shutdown'],
            notResumedReasons: {
              continuation: CONTINUATION_REFUSED,
              ...(last ? { fallbackCompact: BUDGET_SPENT } : {}),
            } satisfies Partial<Record<TaskTurnNonTerminal, string>>,
            ...(compactHop ? { compactHop: true } : {}),
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
              markStarted();
            },
          });
        } finally {
          chainAbort.signal.removeEventListener('abort', forward);
        }

        if (result.outcome && !hopStarted) progress.committedBeforeStart = true;
        if (result.outcome) {
          // A compaction that the boundary proved, with budget left: run the
          // instruction it was stashed for. Nothing else is ever re-run (D10).
          if (continues && replay !== null && result.outcome.outcome === 'completed') {
            // The completed compaction owns the task until the re-run's start is
            // saved: a re-run that cannot start ends it, and the chain, here (fable #666).
            pendingTurnId = result.turnId;
            text = replay;
            replay = null;
            compactHop = false;
            isUserInput = true;
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
      }
    } catch (error) {
      deps.logger.error('Task turn chain ended by a throw', { sessionKey, error: (error as Error)?.message });
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

  async function answer(request: TaskAnswerRequest): Promise<TaskCommandResponse> {
    const session = deps.getSession(request.sessionKey);
    if (!session || session.slackless !== true) return refuse(409, 'not a dashboard task');
    // The turn runs under the owner's identity: only the owner answers (#637 R1;
    // admission checks it again for every start).
    if (!request.actorUserId || request.actorUserId !== session.ownerId) {
      return refuse(403, 'only the task owner can answer its question');
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
    },
    isRunning: (sessionKey) => chains.has(sessionKey),
  };
}

function abandonOutcome(reason: unknown): Omit<TaskTurnOutcomeRecord, 'turnId' | 'at'> {
  if (reason === 'user-stop') return { outcome: 'cancelled', category: 'Exception', reason: 'stopped by user' };
  if (reason === 'session-close') return { outcome: 'cancelled', category: 'Exception', reason: 'task closed' };
  return { outcome: 'interrupted', category: 'Exception', reason: `stopped between steps (${String(reason)})` };
}
