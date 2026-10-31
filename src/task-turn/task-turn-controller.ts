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
import type { ConversationSession } from '../types';
import type { RunTaskTurnInput, RunTaskTurnResult, TaskTurnNonTerminal } from './task-turn-runner';

export interface TaskCommandRequest {
  sessionKey: string;
  text: string;
  attachments?: readonly unknown[];
}

export interface TaskCommandResponse {
  status: number;
  body: Record<string, unknown>;
  /** The accepted chain (tests and close() await it). */
  done?: Promise<void>;
}

export interface TaskTurnControllerDeps {
  runner: { runTaskTurn(input: RunTaskTurnInput): Promise<RunTaskTurnResult> };
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
  /** How long close() waits for a chain to end. Default 30 s. */
  closeWaitMs?: number;
  now?: () => number;
}

export interface TaskTurnController {
  start(request: TaskCommandRequest): Promise<TaskCommandResponse>;
  /** Abort the task's chain with `session-close` and wait (bounded) for it to end. */
  close(sessionKey: string): Promise<void>;
  /** Shutdown: refuse new starts (503). Running chains end through the coordinator's `shutdown` abort. */
  stopAccepting(): void;
  isRunning(sessionKey: string): boolean;
}

const COMPACT = '/compact';
/** A slash command's shape (`/model x`, `/compact focus`) — not a path (`/work/x`) or a fraction (`2/3`). */
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
  let accepting = true;

  const refuse = (status: number, error: string): TaskCommandResponse => ({ status, body: { error } });

  function admit(
    request: TaskCommandRequest,
  ):
    | { ok: true; session: ConversationSession; ctx: ExecutionContext; ownerId: string }
    | { ok: false; response: TaskCommandResponse } {
    if (!accepting) return { ok: false, response: refuse(503, 'the service is shutting down — try again shortly') };
    const session = deps.getSession(request.sessionKey);
    if (!session || session.slackless !== true) return { ok: false, response: refuse(409, 'not a dashboard task') };
    if (request.attachments && request.attachments.length > 0) {
      return { ok: false, response: refuse(400, 'attachments are not supported on a dashboard task yet') };
    }
    const text = request.text.trim();
    if (text !== COMPACT && (SLASH_COMMAND.test(text) || SESSION_COMMAND.test(text))) {
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
    return { ok: true, session, ctx, ownerId };
  }

  async function start(request: TaskCommandRequest): Promise<TaskCommandResponse> {
    const admitted = admit(request);
    if (!admitted.ok) return admitted.response;
    const { session, ctx, ownerId } = admitted;
    const { sessionKey } = request;

    // A new instruction supersedes an open question, as a new Slack message
    // does; the turn's saved start persists the cleared panel.
    if (session.actionPanel) {
      session.actionPanel.pendingQuestion = undefined;
      session.actionPanel.pendingChoice = undefined;
      session.actionPanel.waitingForChoice = false;
    }

    const abort = new AbortController();
    deps.coordinator.setController(sessionKey, abort);
    let markStarted!: () => void;
    const started = new Promise<'started'>((resolve) => {
      markStarted = () => resolve('started');
    });
    const done = runChain(sessionKey, session, ctx, request.text.trim(), abort, markStarted);
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
    return refuse(500, 'the task turn could not start');
  }

  async function runChain(
    sessionKey: string,
    session: ConversationSession,
    ctx: ExecutionContext,
    instruction: string,
    chainAbort: AbortController,
    markStarted: () => void,
  ): Promise<void> {
    let text = instruction;
    let compactHop = false;
    let isUserInput = true;
    let replay: string | null = null;
    try {
      for (let dispatch = 1; dispatch <= maxDispatches; dispatch++) {
        if (chainAbort.signal.aborted) return;
        const last = dispatch === maxDispatches;
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
            onStarted: markStarted,
          });
        } finally {
          chainAbort.signal.removeEventListener('abort', forward);
        }

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
        if (result.fenced || result.nonTerminal !== 'fallbackCompact') return;
        // The stash is nulled at the compaction boundary: take it now.
        replay = session.fallbackCompactPendingUserText ?? null;
        text = COMPACT;
        compactHop = true;
        isUserInput = false;
      }
    } catch (error) {
      deps.logger.error('Task turn chain ended by a throw', { sessionKey, error: (error as Error)?.message });
    }
  }

  async function close(sessionKey: string): Promise<void> {
    const chain = chains.get(sessionKey);
    if (!chain) return;
    chain.abort.abort('session-close');
    const waitMs = deps.closeWaitMs ?? 30_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      chain.done,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          deps.logger.warn('Task chain did not end before close — closing anyway', { sessionKey });
          resolve();
        }, waitMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  return {
    start,
    close,
    stopAccepting: () => {
      accepting = false;
    },
    isRunning: (sessionKey) => chains.has(sessionKey),
  };
}
