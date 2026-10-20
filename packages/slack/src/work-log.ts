/**
 * Work log — the per-conversation record of what a turn actually did
 * (spec 10 §3.3, the fixed seam between the Slack emitter and the dashboard
 * store). Types only: the emitter is `StreamContext.workLog` (stream-processor)
 * bound by stream-executor to `streamExecutorProviders.appendWorkLog`; the
 * store (`src/conversation/work-log.ts`) assigns `seq`/`ts`.
 *
 * Every entry is emitted at every verbosity level — Slack verbosity decides
 * what reaches the thread, never what reaches the work log.
 */

export type WorkLogKind = 'instruction' | 'narration' | 'tool' | 'tool_result' | 'final' | 'notice' | 'error';

export interface WorkLogInput {
  kind: WorkLogKind;
  text: string;
  tool?: string;
  ok?: boolean;
  turnId?: string;
  ts?: number;
  /**
   * The full content behind the one-line `text`: a tool call's whole input, a
   * tool result's output. The store keeps it (size-capped) and serves it on
   * demand only; pages and the live broadcast carry `rawBytes` instead.
   */
  raw?: string;
}

/** An entry as pages and the live broadcast carry it: `raw` is replaced by its size. */
export interface WorkLogEntry extends Omit<WorkLogInput, 'raw'> {
  seq: number;
  ts: number;
  /** UTF-8 byte length of the original raw; present iff the entry has one. */
  rawBytes?: number;
  /** The stored raw is cut short of the original. */
  rawTruncated?: true;
}
