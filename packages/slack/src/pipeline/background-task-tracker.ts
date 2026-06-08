/**
 * Authoritative background-task lifecycle tracker — the REAL "is background
 * work still running?" signal for the turn-end resume guard.
 *
 * WHY THIS REPLACES THE HEURISTIC TRACKER
 * ---------------------------------------
 * The Claude Agent SDK emits authoritative `system` messages for EVERY
 * background task (`Bash({run_in_background:true})` AND `Task({run_in_background:
 * true})`): `task_started`, `task_progress`, and a terminal `task_notification`
 * (`completed`/`failed`/`stopped`). The harness's `sdk-message-to-event` mapper
 * forwards these as neutral `agent_task_lifecycle` events. This tracker consumes
 * them and is the single source of truth for liveness.
 *
 * The previous design (`background-resume-tracker.ts`) RECONSTRUCTED liveness
 * from the model's behavior: it parsed the spawn-ack text for an id, then waited
 * for the model to poll `TaskOutput`/`BashOutput` and parsed THAT result for a
 * terminal status. That coupled correctness to model behavior and a deprecated
 * polling tool, and burned the per-session resume cap whenever the model read
 * the output file directly (the SDK-sanctioned path) instead of polling. This
 * tracker drains on the authoritative settle event instead — no model polling,
 * no consumer-tool parsing.
 *
 * KEY (task_id)
 * -------------
 * Everything is keyed by the SDK `task_id`. Empirically the `task_id` equals the
 * `Bash({run_in_background})` spawn-ack "...with ID: <id>" id, so a fallback ADD
 * parsed from the spawn ack (in case a `task_started` is ever missed) shares the
 * same key space as the authoritative events — one map serves both.
 *
 * ORDERING / IDEMPOTENCE (per design review with codex)
 * -----------------------------------------------------
 * - `trackStart` is idempotent per `task_id` (a duplicate `task_started`, or a
 *   `task_started` after a fallback spawn-ack add, does not double-count). New
 *   metadata (taskType/outputFile) from a later signal is merged in.
 * - `trackSettled` removes the live task AND records a tombstone, so a LATE
 *   `task_started` / fallback add for an already-settled task cannot resurrect
 *   it (settle-before-start safety — the two SDK messages can be reordered, and
 *   the fallback spawn-ack add can race the authoritative settle).
 * - A duplicate `task_notification` is a no-op.
 * - `drain` (session teardown / cap give-up by the caller) clears BOTH live and
 *   tombstone state for the session.
 *
 * The tracker is session-scoped (survives across resume turns) and is a pure,
 * unit-testable state machine with no I/O.
 */

export type TaskTerminalStatus = 'completed' | 'failed' | 'stopped';

/** Coerce arbitrary `tool_result.content` (string | text-block[] | object) to text. */
export function contentToText(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
          return (part as { text: string }).text;
        }
        return '';
      })
      .join('\n');
  }
  if (typeof content === 'object') {
    const o = content as { text?: unknown };
    if (typeof o.text === 'string') return o.text;
    try {
      return JSON.stringify(content);
    } catch {
      return '';
    }
  }
  return String(content);
}

/** Search structured payloads (object or block array, recursively) for a string field. */
function findStructuredString(content: unknown, field: string): string | undefined {
  const seen = new Set<unknown>();
  const visit = (node: unknown): string | undefined => {
    if (!node || typeof node !== 'object' || seen.has(node)) return undefined;
    seen.add(node);
    const rec = node as Record<string, unknown>;
    if (typeof rec[field] === 'string' && rec[field]) return rec[field] as string;
    for (const child of Object.values(rec)) {
      const hit = visit(child);
      if (hit) return hit;
    }
    return undefined;
  };
  return visit(content);
}

/**
 * Extract the background id from a `Bash({run_in_background:true})` spawn-ack
 * result, for the FALLBACK add (used only if the SDK `task_started` is ever
 * missed). Structured `backgroundTaskId`/`shellId` first, then a tolerant text
 * regex. The id this yields equals the SDK `task_id`, so it shares the tracker
 * key space. Returns `undefined` when no id is present.
 */
export function parseBackgroundLaunchId(content: unknown): string | undefined {
  const structured = findStructuredString(content, 'backgroundTaskId') ?? findStructuredString(content, 'shellId');
  if (structured) return structured;
  const text = contentToText(content);
  // "...running in background with ID: <id>. Output is being written to..."
  const m = text.match(/\bwith ID:\s*([^\s.]+)/i);
  return m ? m[1] : undefined;
}

/** A background task currently live (started/acked, not yet settled). */
export interface LiveTask {
  /** SDK `task_id` (== Bash spawn-ack "with ID:" id). */
  taskId: string;
  /** The launching tool_use id, when the signal carried one. */
  toolUseId?: string;
  /** SDK `task_type` (e.g. 'bash', a subagent type), when known. */
  taskType?: string;
  /** SDK-managed output file path, carried for host-side reconciliation. */
  outputFile?: string;
}

/** Optional metadata supplied alongside a start/ack. */
export interface TaskStartMeta {
  toolUseId?: string;
  taskType?: string;
  outputFile?: string;
}

export class AgentTaskLifecycleTracker {
  /** sessionKey → (taskId → LiveTask). */
  private readonly live = new Map<string, Map<string, LiveTask>>();
  /** sessionKey → settled taskIds (tombstones: reject late re-adds). */
  private readonly settled = new Map<string, Set<string>>();

  /**
   * Record a task as live. Source = authoritative SDK `task_started` OR the
   * fallback spawn-ack add. Idempotent by `task_id`; merges new metadata.
   * A start for an already-settled task is ignored (tombstone guard).
   */
  trackStart(sessionKey: string, taskId: string, meta: TaskStartMeta = {}): void {
    if (!sessionKey || !taskId) return;
    if (this.settled.get(sessionKey)?.has(taskId)) return; // already settled → do not resurrect

    const map = this.live.get(sessionKey) ?? new Map<string, LiveTask>();
    const existing = map.get(taskId);
    if (existing) {
      // Merge any newly-known fields (e.g. fallback add first, task_started later).
      existing.toolUseId ??= meta.toolUseId;
      existing.taskType ??= meta.taskType;
      existing.outputFile ??= meta.outputFile;
    } else {
      map.set(taskId, {
        taskId,
        toolUseId: meta.toolUseId,
        taskType: meta.taskType,
        outputFile: meta.outputFile,
      });
    }
    this.live.set(sessionKey, map);
  }

  /**
   * Record a task as settled (authoritative SDK `task_notification`, or a
   * terminal `task_updated`). Removes it from the live set and tombstones the
   * id so a reordered late start cannot revive it. Duplicate settles are no-ops.
   */
  trackSettled(sessionKey: string, taskId: string): void {
    if (!sessionKey || !taskId) return;

    const tomb = this.settled.get(sessionKey) ?? new Set<string>();
    tomb.add(taskId);
    this.settled.set(sessionKey, tomb);

    const map = this.live.get(sessionKey);
    if (map) {
      map.delete(taskId);
      if (map.size === 0) this.live.delete(sessionKey);
    }
  }

  /** Count of live (started-but-not-settled) background tasks for a session. */
  liveCount(sessionKey: string): number {
    return this.live.get(sessionKey)?.size ?? 0;
  }

  /** Snapshot of live tasks for a session (for the resume prompt summary). */
  liveTasks(sessionKey: string): LiveTask[] {
    return [...(this.live.get(sessionKey)?.values() ?? [])];
  }

  /**
   * Stable signature of the current live set (sorted task_ids). The resume
   * guard uses this to suppress auto-resume NON-destructively once the cap is
   * hit: it remembers the signature it gave up on instead of clearing the
   * authoritative live state, and re-arms when the signature changes.
   */
  liveSignature(sessionKey: string): string {
    const map = this.live.get(sessionKey);
    if (!map || map.size === 0) return '';
    return [...map.keys()].sort().join(',');
  }

  /** Drop ALL state (live + tombstones) for a session — teardown only. */
  drain(sessionKey: string): void {
    this.live.delete(sessionKey);
    this.settled.delete(sessionKey);
  }
}
