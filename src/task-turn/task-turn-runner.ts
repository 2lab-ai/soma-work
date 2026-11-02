/**
 * The runner of a Slack-less task's turn (#598 ④b, design 598b v5 §8–§9,
 * 598c §3, §6, §8).
 *
 * One terminalizer per turn, around `StreamExecutor.execute()`:
 *
 *   before: the task's conversation exists durably (created once, awaited) →
 *           the turn's start is saved strictly (`beginTaskTurn`: `working` +
 *           the turn id) → open the turn's work-log receipts.
 *   after:  drain the receipts → decide the outcome from the executor's raw
 *           terminal signals (`deriveTaskTurnOutcome`; the open question is
 *           read now, after the drain) → current-turn fence → one strict
 *           commit of the outcome and the end activity.
 *
 * A non-terminal return (continuation, fallback compaction, supersede, a
 * user interrupt, shutdown) commits nothing only when the caller said it
 * resumes that kind (`resumable`); its recording failure is carried to the
 * next terminal commit. Any other is committed `interrupted`, so a task never
 * stays `working` with nobody to resume it. A throw out of `execute` is
 * committed `failed` and rethrown. The re-entry loop is the caller's
 * (`TaskTurnController`).
 */
import { randomUUID } from 'node:crypto';
import type { TaskTurnBinding } from '@soma/slack/task-turn/task-say';
import {
  deriveTaskTurnOutcome,
  NO_TERMINAL_ABORTS,
  type TaskTurnTerminalSignals,
} from '@soma/slack/task-turn/task-turn-outcome';
import { TaskTurnRefusedError } from '@soma/slack/task-turn/task-turn-refused';
import type { ExecutionContext } from '../agent-runtime/execution-context';
import type { ConversationSession, TaskChainSettle, TaskTurnOutcomeRecord } from '../types';

/** The slice of `ExecuteResult` the runner reads. */
export interface TaskExecuteResult {
  success: boolean;
  continuation?: unknown;
  terminal?: TaskTurnTerminalSignals;
}

export interface TaskTurnReceipts {
  /** Start collecting this turn's work-log append promises. */
  open(binding: TaskTurnBinding): void;
  /** Seal and wait (bounded); resolves with the first failure's reason, or undefined. */
  drain(binding: TaskTurnBinding): Promise<string | undefined>;
}

export interface TaskTurnRunnerDeps {
  registry: {
    getSessionByKey(sessionKey: string): ConversationSession | undefined;
    /** `working` + the turn id in one strict save; restores and throws on failure (598c §6). */
    beginTaskTurn(sessionKey: string, turnId: string, chainId?: string, consume?: readonly string[]): void;
    /** Outcome + end activity in one strict save; restores both and throws on failure. */
    commitTaskTurnOutcome(
      sessionKey: string,
      outcome: TaskTurnOutcomeRecord,
      activity: 'waiting' | 'idle',
      settle?: TaskChainSettle,
    ): void;
    /**
     * The outcome could not be saved after every retry: apply it in memory
     * only (the dashboard shows the truth; disk still says `working`, so a
     * restart records the turn `interrupted`). Never re-runs anything.
     */
    holdUnsavedTaskTurnOutcome(
      sessionKey: string,
      outcome: TaskTurnOutcomeRecord,
      activity: 'waiting' | 'idle',
      settle?: TaskChainSettle,
    ): void;
  };
  /** The task executor's `execute` (built by `createTaskTurnExecutor`). */
  execute(params: Record<string, unknown>): Promise<TaskExecuteResult>;
  createConversation(session: ConversationSession): Promise<string>;
  receipts: TaskTurnReceipts;
  /** Persistence-only retries of a failed outcome commit (598c v2 a3). Default 1 s, 5 s, 30 s. */
  commitRetryDelaysMs?: readonly number[];
  logger: {
    warn(msg: string, meta?: unknown): void;
    error(msg: string, meta?: unknown): void;
    info(msg: string, meta?: unknown): void;
  };
}

export interface RunTaskTurnInput {
  sessionKey: string;
  executionContext: ExecutionContext;
  text: string;
  /** Extra execute params the caller (④c) supplies: abort controller, user name, … */
  params?: Record<string, unknown>;
  /**
   * The non-terminal kinds this caller resumes. Any other non-terminal return
   * is committed `interrupted` with `notResumedReason`. Default: supersede,
   * user interrupt and shutdown (their resumer is the next turn or restart
   * reconciliation); a continuation or fallback compaction is then not resumed.
   */
  resumable?: readonly TaskTurnNonTerminal[];
  /** The reason committed for each non-terminal kind not in `resumable` (defaults below). */
  notResumedReasons?: Partial<Record<TaskTurnNonTerminal, string>>;
  /**
   * This turn is the `/compact` re-entry of a fallback compaction. Its
   * `completed` stands only if the compaction boundary disarmed the session;
   * otherwise it is `failed` ("compaction did not complete") and the session
   * is disarmed (598c v2 a4).
   */
  compactHop?: boolean;
  /** Called once the turn's start is saved, before the model runs (the caller's acceptance point). */
  onStarted?: () => void;
  /**
   * E2 ③ — the chain this turn is a hop of (absent for a caller with no
   * chain). Its start opens the chain; its commit ends it, unless a
   * `completed` outcome continues it (`continuesIfCompleted`). A completed
   * outcome that `completedFailsWith` a reason ends the chain as a failure.
   */
  chain?: TaskTurnChain;
  /** E4 ⑥ — an epic's pending events this hop's saved start consumes (the chain's first hop only). */
  consume?: readonly string[];
}

/** E2 ③ — a hop's place in its chain (see `RunTaskTurnInput.chain`). */
export interface TaskTurnChain {
  id: string;
  continuesIfCompleted: boolean;
  completedFailsWith?: string;
}

/** E2 ③ — how a hop's outcome settles its chain. */
function settleFor(chain: TaskTurnChain, outcome: TaskTurnOutcomeRecord['outcome']): TaskChainSettle {
  const completed = outcome === 'completed';
  if (completed && chain.continuesIfCompleted) return { chainId: chain.id, ends: false };
  if (completed && chain.completedFailsWith) {
    return { chainId: chain.id, ends: true, notice: { kind: 'failure', reason: chain.completedFailsWith } };
  }
  return { chainId: chain.id, ends: true };
}

const NOT_RESUMED_REASONS: Record<TaskTurnNonTerminal, string> = {
  continuation: 're-entry not wired',
  fallbackCompact: 're-entry not wired',
  supersede: 'superseded',
  'user-interrupted': 'interrupted by the user',
  shutdown: 'service shut down',
};

const DEFAULT_RESUMABLE: readonly TaskTurnNonTerminal[] = ['supersede', 'user-interrupted', 'shutdown'];

/** Why a turn ended without an outcome — what the caller (④c) must do next. */
export type TaskTurnNonTerminal = 'continuation' | 'fallbackCompact' | 'supersede' | 'user-interrupted' | 'shutdown';

export interface RunTaskTurnResult {
  turnId: string;
  /** The outcome is held in memory only: every save failed (598c v2 a3). */
  unsaved?: boolean;
  /** The committed outcome, or null for a non-terminal return. */
  outcome: TaskTurnOutcomeRecord | null;
  /** Set when `outcome` is null and the turn was not fenced. */
  nonTerminal?: TaskTurnNonTerminal;
  continuation?: unknown;
  /** A newer turn took the session while this one ran; nothing was committed. */
  fenced?: boolean;
}

export function createTaskTurnRunner(deps: TaskTurnRunnerDeps) {
  /** Recording failures of non-terminal returns, folded into the next terminal commit. */
  const pendingRecordFailures = new Map<string, string>();
  /** The turn that currently owns each task (the fence). In memory only. */
  const activeTurn = new Map<string, string>();
  /** A first turn's conversation creation, shared by a concurrent second turn. */
  const conversationCreation = new Map<string, Promise<string>>();

  async function commit(
    sessionKey: string,
    session: ConversationSession,
    turnId: string,
    decided: Omit<TaskTurnOutcomeRecord, 'turnId' | 'at'>,
    chain?: TaskTurnChain,
  ): Promise<RunTaskTurnResult> {
    if (activeTurn.get(sessionKey) !== turnId) {
      deps.logger.info('Task turn outcome fenced out by a newer turn', {
        sessionKey,
        turnId,
        outcome: decided.outcome,
      });
      return { turnId, outcome: null, fenced: true };
    }
    const record: TaskTurnOutcomeRecord = { ...decided, turnId, at: Date.now() };
    const activity = record.outcome === 'waiting' ? 'waiting' : 'idle';
    const settle = chain ? settleFor(chain, record.outcome) : undefined;
    const delays = deps.commitRetryDelaysMs ?? [1_000, 5_000, 30_000];
    let lastError: unknown;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt > 0) {
        await sleep(delays[attempt - 1]);
        // Only this turn's outcome is retried, and only while it still owns the task.
        if (activeTurn.get(sessionKey) !== turnId) return { turnId, outcome: null, fenced: true };
      }
      try {
        // One strict save of the outcome and the end activity (the registry
        // restores both on failure); idle hooks run after it, seeing the outcome.
        deps.registry.commitTaskTurnOutcome(sessionKey, record, activity, settle);
        return { turnId, outcome: record };
      } catch (error) {
        lastError = error;
        deps.logger.warn('Task turn outcome not saved — rolled back; retrying the save only', {
          sessionKey,
          turnId,
          attempt,
          error: (error as Error)?.message,
        });
      }
    }
    const held: TaskTurnOutcomeRecord = {
      ...record,
      recordFailure: `outcome not saved: ${(lastError as Error)?.message ?? String(lastError)}`,
    };
    deps.logger.error('Task turn outcome held in memory — every save failed', { sessionKey, turnId });
    deps.registry.holdUnsavedTaskTurnOutcome(sessionKey, held, activity, settle);
    return { turnId, outcome: held, unsaved: true };
  }

  async function runTaskTurn(input: RunTaskTurnInput): Promise<RunTaskTurnResult> {
    const { sessionKey } = input;
    const session = deps.registry.getSessionByKey(sessionKey);
    if (!session || session.slackless !== true) {
      throw new Error(`runTaskTurn refused: ${sessionKey} is not a Slack-less task`);
    }
    const turnId = `${sessionKey}:${Date.now()}:${randomUUID()}`;
    const previousTurn = activeTurn.get(sessionKey);
    activeTurn.set(sessionKey, turnId);

    if (!session.conversationId) {
      try {
        let creating = conversationCreation.get(sessionKey);
        if (!creating) {
          creating = deps.createConversation(session);
          conversationCreation.set(sessionKey, creating);
          creating.finally(() => conversationCreation.delete(sessionKey)).catch(() => {});
        }
        session.conversationId ??= await creating;
      } catch (error) {
        deps.logger.error('Task conversation not created', { sessionKey, error: (error as Error)?.message });
        // The chain ends here, as a failure: its thread's notice and its epic's event (E4 ⑤, D6 b).
        return commit(
          sessionKey,
          session,
          turnId,
          { outcome: 'failed', category: 'Exception', reason: 'record: conversation not created' },
          input.chain,
        );
      }
    }

    const binding: TaskTurnBinding = { sessionKey, conversationId: session.conversationId, turnId };
    // Saved before anything runs: a process that dies mid-turn leaves this turn
    // on disk for restart reconciliation. A failed save runs nothing.
    try {
      // An epic's start consumes its events in this save (E4 ⑥); a start with none passes nothing.
      if (input.consume?.length) deps.registry.beginTaskTurn(sessionKey, turnId, input.chain?.id, input.consume);
      else deps.registry.beginTaskTurn(sessionKey, turnId, input.chain?.id);
    } catch (error) {
      // Nothing ran: the turn that owned the task still does (#634 R1), so its
      // caller can still end it.
      if (activeTurn.get(sessionKey) === turnId) {
        if (previousTurn === undefined) activeTurn.delete(sessionKey);
        else activeTurn.set(sessionKey, previousTurn);
      }
      throw error;
    }
    input.onStarted?.();
    deps.receipts.open(binding);

    let result: TaskExecuteResult;
    try {
      result = await deps.execute({
        ...input.params,
        session,
        sessionKey,
        text: input.text,
        channel: '',
        threadTs: undefined,
        user: input.executionContext.userId,
        executionContext: input.executionContext,
        taskBinding: binding,
      });
    } catch (error) {
      // A throw out of execute is a refused turn (a caller bug) or an escape
      // from its own catch: drain what was written, end the turn `failed` so
      // the task never stays `working`, then let the caller see the throw.
      const drained = await deps.receipts.drain(binding);
      if (activeTurn.get(sessionKey) !== turnId) {
        // A newer turn owns the task: this one records nothing (#626 R2).
        throw error;
      }
      // A thrown turn ends the chain: an armed fallback (a compact hop that
      // threw before its boundary) is disarmed, not left for the next turn (astra #634).
      disarmFallbackCompact(session);
      // The first recording failure wins — an earlier hop's carried one included.
      const recordFailure = pendingRecordFailures.get(sessionKey) ?? drained;
      pendingRecordFailures.delete(sessionKey);
      const reason =
        error instanceof TaskTurnRefusedError
          ? `refused: ${error.code}`
          : `turn threw: ${(error as Error)?.message ?? String(error)}`;
      try {
        await commit(
          sessionKey,
          session,
          turnId,
          { outcome: 'failed', category: 'Exception', reason, ...(recordFailure ? { recordFailure } : {}) },
          input.chain,
        );
      } catch (commitError) {
        deps.logger.error('A thrown task turn could not be recorded', {
          sessionKey,
          turnId,
          error: (commitError as Error)?.message,
        });
      }
      throw error;
    }
    const recordFailure = await deps.receipts.drain(binding);
    if (activeTurn.get(sessionKey) !== turnId) {
      // A newer turn owns the task: this one neither commits, nor asks for a
      // hop, nor touches the session it now shares — not the carried failure,
      // not an armed fallback (#626 R2 astra).
      deps.logger.info('Task turn fenced out by a newer turn', { sessionKey, turnId });
      return { turnId, outcome: null, fenced: true };
    }
    // The first recording failure wins: a carried one before this drain's (#626 R2).
    const carried = pendingRecordFailures.get(sessionKey);
    const failure = carried ?? recordFailure;

    let decided = result.terminal ? deriveTaskTurnOutcome(result.terminal, failure) : null;
    if (input.compactHop && session.fallbackCompactActive) {
      // No boundary disarmed it: whatever the turn said, nothing was compacted.
      disarmFallbackCompact(session);
      if (!decided || decided.outcome === 'completed') {
        decided = { outcome: 'failed', category: 'Exception', reason: 'compaction did not complete' };
      }
    }
    if (!decided) {
      const nonTerminal = classifyNonTerminal(result);
      const resumable = input.resumable ?? DEFAULT_RESUMABLE;
      if (!nonTerminal || !resumable.includes(nonTerminal)) {
        // Nobody will resume it: commit it as interrupted rather than leave it working.
        if (nonTerminal === 'fallbackCompact') disarmFallbackCompact(session);
        pendingRecordFailures.delete(sessionKey);
        return commit(
          sessionKey,
          session,
          turnId,
          {
            outcome: 'interrupted',
            category: 'Exception',
            reason: nonTerminal
              ? (input.notResumedReasons?.[nonTerminal] ?? NOT_RESUMED_REASONS[nonTerminal])
              : 'turn ended without an outcome',
            ...(failure ? { recordFailure: failure } : {}),
          },
          input.chain,
        );
      }
      // Keep the first failure: a later one must not replace it (#626 R1).
      if (recordFailure && !pendingRecordFailures.has(sessionKey)) pendingRecordFailures.set(sessionKey, recordFailure);
      return {
        turnId,
        outcome: null,
        nonTerminal,
        ...(result.continuation !== undefined ? { continuation: result.continuation } : {}),
      };
    }
    pendingRecordFailures.delete(sessionKey);
    return commit(sessionKey, session, turnId, decided, input.chain);
  }

  /**
   * End a turn that returned non-terminal and will not be resumed after all —
   * the chain was stopped, or its next hop could not start (#634 R1). An armed
   * fallback compaction is disarmed; the turn is committed with the caller's
   * outcome and any carried recording failure. Fenced if a newer turn owns the task.
   */
  async function abandonTurn(
    sessionKey: string,
    turnId: string,
    decided: Omit<TaskTurnOutcomeRecord, 'turnId' | 'at'>,
    chainId?: string,
  ): Promise<RunTaskTurnResult> {
    const session = deps.registry.getSessionByKey(sessionKey);
    if (!session || activeTurn.get(sessionKey) !== turnId) return { turnId, outcome: null, fenced: true };
    disarmFallbackCompact(session);
    const carried = pendingRecordFailures.get(sessionKey);
    pendingRecordFailures.delete(sessionKey);
    // An abandoned turn ends its chain (E2 ③).
    const chain = chainId ? { id: chainId, continuesIfCompleted: false } : undefined;
    return commit(sessionKey, session, turnId, { ...decided, ...(carried ? { recordFailure: carried } : {}) }, chain);
  }

  return { runTaskTurn, abandonTurn };
}

/**
 * A fallback compaction armed the session for a `/compact` re-entry (1M model,
 * the stashed text). Not resumed, it is disarmed here — otherwise the task's
 * next turn would run as a compact turn on the swapped model (fable #626 R2).
 */
function disarmFallbackCompact(session: ConversationSession): void {
  if (!session.fallbackCompactActive) return;
  if (session.fallbackCompactOriginalModel) session.model = session.fallbackCompactOriginalModel;
  session.fallbackCompactActive = false;
  session.fallbackCompactOriginalModel = null;
  session.fallbackCompactPendingUserText = null;
  session.fallbackCompactPendingEventContext = null;
}

function classifyNonTerminal(result: TaskExecuteResult): TaskTurnNonTerminal | undefined {
  if (result.continuation !== undefined) return 'continuation';
  if (result.terminal?.fallbackCompact) return 'fallbackCompact';
  const reason = result.terminal?.abortReason;
  if (reason && NO_TERMINAL_ABORTS.has(reason)) return reason as TaskTurnNonTerminal;
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}
