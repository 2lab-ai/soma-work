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
    persistSessionStrict(sessionKey: string): void;
    setActivityStateByKey(sessionKey: string, state: 'working' | 'waiting' | 'idle'): void;
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
}

export interface RunTaskTurnResult {
  turnId: string;
  /** The committed outcome, or null for a non-terminal return. */
  outcome: TaskTurnOutcomeRecord | null;
  continuation?: unknown;
  /** A newer turn took the session while this one ran; nothing was committed. */
  fenced?: boolean;
}

export function createTaskTurnRunner(deps: TaskTurnRunnerDeps) {
  /** Recording failures of non-terminal returns, folded into the next terminal commit. */
  const pendingRecordFailures = new Map<string, string>();
  /** The turn that currently owns each task (the fence). In memory only. */
  const activeTurn = new Map<string, string>();

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
    const previous = session.lastTurnOutcome;
    const record: TaskTurnOutcomeRecord = { ...decided, turnId, at: Date.now() };
    session.lastTurnOutcome = record;
    try {
      deps.registry.persistSessionStrict(sessionKey);
    } catch (error) {
      session.lastTurnOutcome = previous;
      deps.logger.error('Task turn outcome not saved — rolled back', {
        sessionKey,
        turnId,
        error: (error as Error)?.message,
      });
      throw error;
    }
    deps.registry.setActivityStateByKey(sessionKey, record.outcome === 'waiting' ? 'waiting' : 'idle');
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
        session.conversationId = await deps.createConversation(session);
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
      if (recordFailure) pendingRecordFailures.set(sessionKey, recordFailure);
      return {
        turnId,
        outcome: null,
        ...(result.continuation !== undefined ? { continuation: result.continuation } : {}),
      };
    }
    pendingRecordFailures.delete(sessionKey);
    return commit(sessionKey, session, turnId, decided);
  }

  return { runTaskTurn };
}
