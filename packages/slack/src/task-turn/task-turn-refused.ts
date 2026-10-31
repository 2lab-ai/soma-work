/**
 * A Slack-less task's turn refused at the executor's entry (#598 ④c; fable
 * #615 R2 P3). Every code is a caller bug: the task runner and its controller
 * build the turn, so a refusal means they built it wrong. Nothing has run when
 * this is thrown — no model call, no Slack call, no work-log entry.
 */
export type TaskTurnRefusalCode =
  /** A Slack-less session with no execution context. */
  | 'no-execution-context'
  /** An execution context on a Slack session. */
  | 'context-on-slack-session'
  /** No turn binding, no work-log writer, or the binding is for another conversation. */
  | 'no-binding'
  /** A follow-up turn epoch (the Slack follow-up queue's) on a task turn. */
  | 'followup-epoch';

export class TaskTurnRefusedError extends Error {
  readonly code: TaskTurnRefusalCode;

  constructor(code: TaskTurnRefusalCode, message: string) {
    super(message);
    this.name = 'TaskTurnRefusedError';
    this.code = code;
  }
}
