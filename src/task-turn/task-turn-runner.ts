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
import type { ConversationSession, TaskTurnOutcomeRecord } from '../types';

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
    beginTaskTurn(sessionKey: string, turnId: string): void;
    /** Outcome + end activity in one strict save; restores both and throws on failure. */
    commitTaskTurnOutcome(sessionKey: string, outcome: TaskTurnOutcomeRecord, activity: 'waiting' | 'idle'): void;
  };
  /** The task executor's `execute` (built by `createTaskTurnExecutor`). */
  execute(params: Record<string, unknown>): Promise<TaskExecuteResult>;
  createConversation(session: ConversationSession): Promise<string>;
  receipts: TaskTurnReceipts;
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
  /** The reason committed for a non-terminal kind not in `resumable`. Default `re-entry not wired`. */
  notResumedReason?: string;
}

const DEFAULT_RESUMABLE: readonly TaskTurnNonTerminal[] = ['supersede', 'user-interrupted', 'shutdown'];

/** Why a turn ended without an outcome — what the caller (④c) must do next. */
export type TaskTurnNonTerminal = 'continuation' | 'fallbackCompact' | 'supersede' | 'user-interrupted' | 'shutdown';

export interface RunTaskTurnResult {
  turnId: string;
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
    try {
      // One strict save of the outcome and the end activity (the registry
      // restores both on failure); idle hooks run after it, seeing the outcome.
      deps.registry.commitTaskTurnOutcome(sessionKey, record, record.outcome === 'waiting' ? 'waiting' : 'idle');
    } catch (error) {
      deps.logger.error('Task turn outcome not saved — rolled back', {
        sessionKey,
        turnId,
        error: (error as Error)?.message,
      });
      throw error;
    }
    return { turnId, outcome: record };
  }

  async function runTaskTurn(input: RunTaskTurnInput): Promise<RunTaskTurnResult> {
    const { sessionKey } = input;
    const session = deps.registry.getSessionByKey(sessionKey);
    if (!session || session.slackless !== true) {
      throw new Error(`runTaskTurn refused: ${sessionKey} is not a Slack-less task`);
    }
    const turnId = `${sessionKey}:${Date.now()}:${randomUUID()}`;
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
        return commit(sessionKey, session, turnId, {
          outcome: 'failed',
          category: 'Exception',
          reason: 'record: conversation not created',
        });
      }
    }

    const binding: TaskTurnBinding = { sessionKey, conversationId: session.conversationId, turnId };
    // Saved before anything runs: a process that dies mid-turn leaves this turn
    // on disk for restart reconciliation. A failed save runs nothing.
    deps.registry.beginTaskTurn(sessionKey, turnId);
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
      const recordFailure = await deps.receipts.drain(binding);
      pendingRecordFailures.delete(sessionKey);
      const reason =
        error instanceof TaskTurnRefusedError
          ? `refused: ${error.code}`
          : `turn threw: ${(error as Error)?.message ?? String(error)}`;
      try {
        await commit(sessionKey, session, turnId, {
          outcome: 'failed',
          category: 'Exception',
          reason,
          ...(recordFailure ? { recordFailure } : {}),
        });
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
    const carried = pendingRecordFailures.get(sessionKey);
    const failure = recordFailure ?? carried;

    const decided = result.terminal ? deriveTaskTurnOutcome(result.terminal, failure) : null;
    if (!decided) {
      const nonTerminal = classifyNonTerminal(result);
      const resumable = input.resumable ?? DEFAULT_RESUMABLE;
      if (!nonTerminal || !resumable.includes(nonTerminal)) {
        // Nobody will resume it: commit it as interrupted rather than leave it working.
        if (nonTerminal === 'fallbackCompact') disarmFallbackCompact(session);
        pendingRecordFailures.delete(sessionKey);
        return commit(sessionKey, session, turnId, {
          outcome: 'interrupted',
          category: 'Exception',
          reason: nonTerminal ? (input.notResumedReason ?? 're-entry not wired') : 'turn ended without an outcome',
          ...(failure ? { recordFailure: failure } : {}),
        });
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
    return commit(sessionKey, session, turnId, decided);
  }

  return { runTaskTurn };
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
