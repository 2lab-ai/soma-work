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
  /**
   * SSOT 2026-10-28 — an `instruction` entry: who put it in the conversation
   * (the recorded user turn's `origin.by`) and whether it was a compaction
   * turn. The dashboard's work log reads a turn soma-work sent as a one-line
   * badge from these; entries written before they were kept are read from text.
   */
  by?: 'user' | 'system';
  compactTurn?: true;
  tool?: string;
  ok?: boolean;
  turnId?: string;
  ts?: number;
  /**
   * SSOT 2026-10-22 T10 — the task (`T<n>` of the session's task ledger) that
   * was in progress when this entry was made, and its title then. The
   * dashboard folds the log under these. Absent outside any task.
   */
  taskId?: string;
  taskTitle?: string;
  /**
   * Spec 12 — the subagent that made this entry: the id of the tool call that
   * started it (SDK `parent_tool_use_id`). Absent = the main agent.
   */
  agentId?: string;
  /**
   * Spec 12 — the subagent this entry starts or returns: set on an `Agent` /
   * `Task` call and on its tool result, whoever made the call.
   */
  agentRef?: string;
  /**
   * The full content behind the one-line `text`: a tool call's whole input, a
   * tool result's output. The store keeps it (size-capped, in a file of its
   * own) and serves it on demand only; pages and the live broadcast carry
   * `rawBytes` instead.
   */
  raw?: string;
  /** UTF-8 size of the original when `raw` was already cut here (the store then reports it as truncated). */
  rawBytes?: number;
  /**
   * SSOT 2026-10-23 T1 — the SDK tool-use id of a `tool` / `tool_result` entry,
   * so a live observer (the dashboard's artifact capture) pairs a call with its
   * result exactly. Persisted by the store (clamped) since the 작업 로그 tool
   * call card pairs a result with its call by it; older logs have none.
   */
  toolUseId?: string;
}

/** An entry as pages and the live broadcast carry it: its raw is described, never included. */
export interface WorkLogEntry extends Omit<WorkLogInput, 'raw' | 'rawBytes'> {
  seq: number;
  ts: number;
  /** UTF-8 byte length of the original raw; present iff the entry has one. */
  rawBytes?: number;
  /** The stored raw is cut short of the original. */
  rawTruncated?: true;
  /**
   * Spec 12 — written by a store that records who made each entry. An entry
   * without it predates agent attribution: a subagent's work may be filed in
   * it as the main agent's, so the dashboard does not claim it is.
   */
  attributed?: true;
}
