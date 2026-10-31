/**
 * A Slack-less task turn's outcome (#598 ④b, design 598b v5 §7, §14.2–§14.3).
 *
 * `StreamExecutor.execute()` reports the raw signals at its two terminal
 * returns (`ExecuteResult.terminal`); the task runner decides the outcome here,
 * once, at commit. The first matching row wins: explicit cancellation and
 * errors rank above an open question, and "ended without a result" applies
 * only to a stream that ended normally. A non-terminal return (a continuation,
 * a compaction re-entry, a turn handed to the steering turn, a shutdown) has
 * no outcome — `null`.
 */
import type { TurnCategory } from '../turn-notifier';

export type TaskTurnOutcomeKind = 'completed' | 'failed' | 'cancelled' | 'waiting' | 'interrupted';

export interface TaskTurnTerminalSignals {
  /** Which terminal return of `execute()` produced these. */
  exit: 'success' | 'error';
  // success exit
  hasSdkError?: boolean;
  renewFailed?: boolean;
  /** A `result` event arrived (the processor set `endTurnInfo`). */
  endTurnInfoPresent?: boolean;
  /** Live read of "a question asked this turn is still open". */
  choiceStillOpen?: () => boolean;
  questionTitle?: string;
  // error exit
  /** The controller's abort reason (`RequestAbortReason` or `__unknown`). */
  abortReason?: string;
  /** An abort-shaped error with no controller abort behind it. */
  abortLike?: boolean;
  thrownError?: boolean;
  retryAfterMs?: number;
  fallbackCompact?: boolean;
  /** The user-facing text the Slack path would have posted. */
  reasonText?: string;
}

export interface TaskTurnOutcome {
  outcome: TaskTurnOutcomeKind;
  category: TurnCategory;
  reason?: string;
  retryable?: boolean;
  /** A recording failure that did not change a non-`completed` outcome. */
  recordFailure?: string;
}

/** Abort reasons that end a turn with no terminal outcome — the next turn or restart owns the task. */
export const NO_TERMINAL_ABORTS: ReadonlySet<string> = new Set(['supersede', 'user-interrupted', 'shutdown']);

function decide(s: TaskTurnTerminalSignals): TaskTurnOutcome | null {
  if (s.fallbackCompact) return null;
  switch (s.abortReason) {
    case 'user-stop':
      return { outcome: 'cancelled', category: 'Exception', reason: s.reasonText ?? 'stopped by user' };
    case 'session-close':
      return { outcome: 'cancelled', category: 'Exception', reason: s.reasonText ?? 'task closed' };
    case 'stall-timeout':
      return { outcome: 'interrupted', category: 'Stalled', reason: s.reasonText ?? 'stalled' };
    case 'ghost-session':
      return { outcome: 'interrupted', category: 'Exception', reason: s.reasonText ?? 'session ended during the turn' };
    case undefined:
      break;
    default:
      if (NO_TERMINAL_ABORTS.has(s.abortReason)) return null;
      return { outcome: 'interrupted', category: 'Exception', reason: s.reasonText ?? 'aborted for an unknown reason' };
  }
  if (s.abortLike) return { outcome: 'interrupted', category: 'Exception', reason: 'transport aborted' };
  if (s.thrownError) {
    return {
      outcome: 'failed',
      category: 'Exception',
      reason: s.reasonText ?? 'turn failed',
      ...(s.retryAfterMs !== undefined ? { retryable: true } : {}),
    };
  }
  if (s.hasSdkError) return { outcome: 'failed', category: 'Exception', reason: s.reasonText ?? 'SDK result error' };
  if (s.renewFailed) return { outcome: 'failed', category: 'Exception', reason: 'renew failed' };
  if (s.exit === 'success' && !s.endTurnInfoPresent) {
    return { outcome: 'interrupted', category: 'Exception', reason: 'stream ended without a result' };
  }
  if (s.choiceStillOpen?.()) {
    return {
      outcome: 'waiting',
      category: 'UIUserAskQuestion',
      ...(s.questionTitle ? { reason: s.questionTitle } : {}),
    };
  }
  return { outcome: 'completed', category: 'WorkflowComplete' };
}

/**
 * The outcome of a terminal return, or `null` for a non-terminal one. A
 * recording failure turns `completed` into `failed` (`record: …`) and rides
 * along on any other outcome, so a model failure and a recording failure stay
 * distinguishable.
 */
export function deriveTaskTurnOutcome(
  signals: TaskTurnTerminalSignals,
  recordFailure?: string,
): TaskTurnOutcome | null {
  const decided = decide(signals);
  if (!decided || !recordFailure) return decided;
  if (decided.outcome === 'completed') {
    return { outcome: 'failed', category: 'Exception', reason: `record: ${recordFailure}` };
  }
  return { ...decided, recordFailure };
}
