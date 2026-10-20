/**
 * Work log — the per-conversation record of what a turn actually did
 * (spec 10 §3.3, the fixed seam between the Slack emitter and the dashboard
 * store). Types and the shared raw cap only: the emitter is
 * `StreamContext.workLog` (stream-processor) bound by stream-executor to
 * `streamExecutorProviders.appendWorkLog`; the store
 * (`src/conversation/work-log.ts`) assigns `seq`/`ts`.
 *
 * Every entry is emitted at every verbosity level — Slack verbosity decides
 * what reaches the thread, never what reaches the work log.
 */

/**
 * Max UTF-8 bytes of a raw the store keeps; the emitter stops joining a tool
 * result's blocks past it. The single definition for both sides.
 */
export const WORK_LOG_RAW_MAX_BYTES = 256 * 1024;

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
   * tool result's output. The store keeps it (size-capped, in a file of its
   * own) and serves it on demand only; pages and the live broadcast carry
   * `rawBytes` instead.
   */
  raw?: string;
  /** UTF-8 size of the original when `raw` was already cut here (the store then reports it as truncated). */
  rawBytes?: number;
}

/** An entry as pages and the live broadcast carry it: its raw is described, never included. */
export interface WorkLogEntry extends Omit<WorkLogInput, 'raw' | 'rawBytes'> {
  seq: number;
  ts: number;
  /** UTF-8 byte length of the original raw; present iff the entry has one. */
  rawBytes?: number;
  /** The stored raw is cut short of the original. */
  rawTruncated?: true;
}
