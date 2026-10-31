/**
 * The runner of a Slack-less task's turn (#598 ④b, design 598b v5 §8–§9).
 *
 * One terminalizer per turn, around `StreamExecutor.execute()`:
 *
 *   before: the task's conversation exists durably (created once, awaited) →
 *           stamp `activeTaskTurnId` → activity `working` → open the turn's
 *           work-log receipts.
 *   after:  drain the receipts → decide the outcome from the executor's raw
 *           terminal signals (`deriveTaskTurnOutcome`; the open question is
 *           read now, after the drain) → current-turn fence → write
 *           `lastTurnOutcome` → strict save (rolled back and rethrown on
 *           failure) → the turn's only idle/waiting transition.
 *
 * A non-terminal return (continuation, compaction re-entry, a turn handed to
 * the steering turn, shutdown) commits nothing and stays `working`; its
 * recording failure is carried to the next terminal commit. The re-entry loop
 * itself is the caller's (④c).
 */
import { randomUUID } from 'node:crypto';
import type { TaskTurnBinding } from '@soma/slack/task-turn/task-say';
import { deriveTaskTurnOutcome, type TaskTurnTerminalSignals } from '@soma/slack/task-turn/task-turn-outcome';
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
    /** Outcome + end activity in one strict save; restores both and throws on failure. */
    commitTaskTurnOutcome(sessionKey: string, outcome: TaskTurnOutcomeRecord, activity: 'waiting' | 'idle'): void;
    setActivityStateByKey(sessionKey: string, state: 'working' | 'waiting' | 'idle'): void;
  };
  /** The task executor's `execute` (built by `createTaskTurnExecutor`). */
  execute(params: Record<string, unknown>): Promise<TaskExecuteResult>;
  createConversation(session: ConversationSession): Promise<string>;
  receipts: TaskTurnReceipts;
  /**
   * The caller runs the next turn of a continuation and the `/compact`
   * re-entry of a fallback compaction (④c). Without it such a return is
   * committed as `interrupted` ("re-entry not wired") so a task never sits in
   * `working` with nobody to resume it (design 598b v5 §9).
   */
  supportsReentry?: boolean;
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
}

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
    deps.registry.setActivityStateByKey(sessionKey, 'working');
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
      // A throw from execute is a refused turn (a caller bug): drain what was
      // written, then let the caller see it. Activity is left to the caller (④c).
      await deps.receipts.drain(binding);
      throw error;
    }
    const recordFailure = await deps.receipts.drain(binding);
    const carried = pendingRecordFailures.get(sessionKey);
    const failure = recordFailure ?? carried;

    const decided = result.terminal ? deriveTaskTurnOutcome(result.terminal, failure) : null;
    if (!decided) {
      const nonTerminal = classifyNonTerminal(result);
      const needsReentry = nonTerminal === 'continuation' || nonTerminal === 'fallbackCompact';
      if (!nonTerminal || (needsReentry && !deps.supportsReentry)) {
        // Nobody will resume it: commit it as interrupted rather than leave it working.
        pendingRecordFailures.delete(sessionKey);
        return commit(sessionKey, session, turnId, {
          outcome: 'interrupted',
          category: 'Exception',
          reason: nonTerminal ? 're-entry not wired' : 'turn ended without an outcome',
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

const NO_TERMINAL_ABORTS: ReadonlySet<string> = new Set(['supersede', 'user-interrupted', 'shutdown']);

function classifyNonTerminal(result: TaskExecuteResult): TaskTurnNonTerminal | undefined {
  if (result.continuation !== undefined) return 'continuation';
  if (result.terminal?.fallbackCompact) return 'fallbackCompact';
  const reason = result.terminal?.abortReason;
  if (reason && NO_TERMINAL_ABORTS.has(reason)) return reason as TaskTurnNonTerminal;
  return undefined;
}
