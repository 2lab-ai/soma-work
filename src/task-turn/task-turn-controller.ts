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
import type { ExecutionContext } from '../agent-runtime/execution-context';
import type { ConversationSession, TaskTurnOutcomeRecord } from '../types';
import { buildTaskAnswerText, type TaskAnswer } from './task-answer';
import type { RunTaskTurnInput, RunTaskTurnResult, TaskTurnNonTerminal } from './task-turn-runner';

export interface TaskCommandRequest {
  sessionKey: string;
  text: string;
  attachments?: readonly unknown[];
  /** The signed-in user sending it; the turn runs as the owner, so only the owner may (#637 R2). */
  actorUserId: string;
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
 * a fraction (`2/3`). Every command is refused on a task in A0 (D8), `/compact`
 * included: a task turn has no signal that proves a manual compaction happened
 * (#634 R1). Automatic and fallback compaction still run.
 */
const SLASH_COMMAND = /^\/[A-Za-z][\w-]*(?:\s|$)/;
const SESSION_COMMAND = /^%[A-Za-z]/;
const CONTINUATION_REFUSED = 'continuation not supported on a dashboard task yet';
const BUDGET_SPENT = 're-entry limit reached';

interface Chain {
  ownerId: string;
  abort: AbortController;
  done: Promise<void>;
}

export function createTaskTurnController(deps: TaskTurnControllerDeps): TaskTurnController {
  const maxDispatches = deps.maxDispatches ?? 3;
  const maxStarts = deps.maxStartsPerWindow ?? 10;
  const windowMs = deps.windowMs ?? 10 * 60_000;
  const now = deps.now ?? Date.now;
  const chains = new Map<string, Chain>();
  const ownerChain = new Map<string, string>();
  const starts = new Map<string, number[]>();
  /** Turns a shutdown abort left `working` (restart reconciliation's to record — unless the shutdown is refused). */
  const shutdownStranded = new Map<string, string>();
  let accepting = true;

  const refuse = (status: number, error: string): TaskCommandResponse => ({ status, body: { error } });

  function admit(
    request: TaskCommandRequest,
    opts: { answer?: boolean } = {},
  ):
    | { ok: true; session: ConversationSession; ctx: ExecutionContext; ownerId: string; startedAt: number }
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
    } else if (SLASH_COMMAND.test(text) || SESSION_COMMAND.test(text)) {
      return {
        ok: false,
        response: refuse(400, 'commands are not supported on a dashboard task yet — send an instruction'),
      };
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
    if (ownerChain.has(ownerId)) {
      return { ok: false, response: refuse(429, 'one dashboard task runs at a time — wait for it to finish') };
    }
    const t = now();
    const recent = (starts.get(ownerId) ?? []).filter((at) => t - at < windowMs);
    if (recent.length >= maxStarts) {
      starts.set(ownerId, recent);
      return { ok: false, response: refuse(429, 'too many dashboard task starts — try again shortly') };
    }
    recent.push(t);
    starts.set(ownerId, recent);
    return { ok: true, session, ctx, ownerId, startedAt: t };
  }

  function start(request: TaskCommandRequest): Promise<TaskCommandResponse> {
    return startChain(request, {});
  }

  async function startChain(request: TaskCommandRequest, opts: { answer?: boolean }): Promise<TaskCommandResponse> {
    const admitted = admit(request, opts);
    if (!admitted.ok) return admitted.response;
    const { session, ctx, ownerId, startedAt } = admitted;
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
    const done = runChain(sessionKey, session, ctx, request.text.trim(), abort, markStarted, progress);
    const chain: Chain = { ownerId, abort, done };
    chains.set(sessionKey, chain);
    ownerChain.set(ownerId, sessionKey);
    const finished = done.finally(() => {
      deps.coordinator.removeController(sessionKey, abort);
      if (chains.get(sessionKey) === chain) chains.delete(sessionKey);
      if (ownerChain.get(ownerId) === sessionKey) ownerChain.delete(ownerId);
    });

    const first = await Promise.race([started, finished.then(() => 'ended' as const)]);
    if (first === 'started') return { status: 202, body: { ok: true }, done: finished };
    // Not started: this start does not count against the owner's window (#634 R1).
    const window = starts.get(ownerId);
    const at = window?.lastIndexOf(startedAt) ?? -1;
    if (window && at >= 0) window.splice(at, 1);
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
        await deps.runner.abandonTurn(sessionKey, turnId, decided);
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
          else if (pendingTurnId) strand(sessionKey, pendingTurnId);
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
          if (compactHop && replay && result.outcome.outcome === 'completed' && !last) {
            text = replay;
            replay = null;
            compactHop = false;
            isUserInput = true;
            continue;
          }
          return;
        }
        if (!result.fenced && result.nonTerminal === 'shutdown') strand(sessionKey, result.turnId);
        if (result.fenced || result.nonTerminal !== 'fallbackCompact') return;
        pendingTurnId = result.turnId;
        // The stash is nulled at the compaction boundary: take it now.
        replay = session.fallbackCompactPendingUserText ?? null;
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
  function strand(sessionKey: string, turnId: string): void {
    if (!accepting) {
      shutdownStranded.set(sessionKey, turnId);
      return;
    }
    endStranded(sessionKey, turnId);
  }

  /** Endings of stranded turns still saving — Close waits for them (astra #634 R2). */
  const endings = new Map<string, Promise<void>>();

  function endStranded(sessionKey: string, turnId: string): void {
    const ending = deps.runner
      .abandonTurn(sessionKey, turnId, {
        outcome: 'interrupted',
        category: 'Exception',
        reason: 'service shutdown was cancelled',
      })
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
          if (ownerChain.get(chain.ownerId) === sessionKey) ownerChain.delete(chain.ownerId);
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
    close,
    stopAccepting: () => {
      accepting = false;
    },
    resumeAccepting: () => {
      accepting = true;
      // The shutdown was refused and the process stays up: nobody will reconcile
      // the turns its abort left `working` — end them now (#634 R1).
      for (const [sessionKey, turnId] of shutdownStranded) {
        shutdownStranded.delete(sessionKey);
        endStranded(sessionKey, turnId);
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
