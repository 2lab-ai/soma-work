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
}

export interface WorkLogEntry extends WorkLogInput {
  seq: number;
  ts: number;
}
