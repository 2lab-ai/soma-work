/**
 * Background-bash resume tracker — the REAL live-work signal for the
 * background-work resume guard (`background-wait.ts` + `StreamExecutor`).
 *
 * WHY THIS EXISTS (the bug #1049 missed)
 * --------------------------------------
 * `Bash({run_in_background:true})` returns its `tool_result` IMMEDIATELY — a
 * spawn ack carrying the background id (`backgroundTaskId`, or text "...with
 * ID: <id>"). It does NOT block until the process exits; the model is expected
 * to poll with `TaskOutput`/`BashOutput`. So `BackgroundBashRegistry` (#688),
 * which removes its entry the moment that ack arrives, is empty again within
 * milliseconds. #1049 read that registry at turn end to decide whether to
 * resume — so it always saw zero live work and never fired. The session
 * completed ("🟢 작업 완료") while the shell was still running.
 *
 * THE SIGNAL THIS PROVIDES
 * ------------------------
 * A background bash is "live" from its spawn ack until the model CONSUMES a
 * TERMINAL output for it (`TaskOutput`/`BashOutput` reporting completed/failed/
 * killed or an exit code) or KILLS it. A poll that reports `running`/`pending`
 * keeps it live. This is sessionKey-scoped so it survives across resume turns
 * (the bg shell is sessionKey-scoped in #688 too).
 *
 * DELIBERATELY ISOLATED
 * ---------------------
 * This tracker is separate from `BackgroundBashRegistry`. That registry owns
 * the #688 spinner counter / McpCallTracker lifecycle; entangling resume
 * correctness with progress-UI accounting risks regressing the spinner. This
 * tracker touches none of that and is never drained by the per-turn
 * `cleanup()` — it must outlive the turn. It is drained only when work is
 * terminally consumed, or when the resume cap is hit (StreamExecutor gives up).
 *
 * ROBUSTNESS / KNOWN LIMITATIONS
 * ------------------------------
 * - Id extraction prefers the structured `backgroundTaskId`; falls back to a
 *   tolerant `with ID:` text regex. If neither yields an id, the launch is
 *   keyed by its launch `toolUseId` and a terminal consumer result with no
 *   parseable id drains one entry (FIFO). Coarse, but the per-session resume
 *   cap is the ultimate backstop against runaway loops.
 * - The harness cannot itself watch the OS process or call output tools (only
 *   the model can), so "wake exactly on process exit" is not achievable
 *   harness-side. The guard instead re-enters the loop and instructs the model
 *   to block on the work in-turn.
 */

/** A background-bash launch still live (spawn-acked, not yet terminally consumed). */
interface LiveLaunch {
  /** Stable key: parsed background id, else the launch `toolUseId`. */
  key: string;
  /** True when keyed by parsed background id (enables id-matched draining). */
  hasId: boolean;
}

/** Tool names that consume / terminate a background shell's output. */
const CONSUMER_TOOL_NAMES = new Set(['TaskOutput', 'BashOutput', 'KillShell', 'KillBash', 'TaskStop']);

/** Statuses that mean the background task has stopped for good. */
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'killed', 'stopped']);
/** Statuses that mean it is still alive. */
const LIVE_STATUSES = new Set(['running', 'pending']);

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

/** Search structured payloads (object or block array) for a string field. */
function findStructuredString(content: unknown, field: string): string | undefined {
  const visit = (node: unknown): string | undefined => {
    if (!node || typeof node !== 'object') return undefined;
    const rec = node as Record<string, unknown>;
    if (typeof rec[field] === 'string' && rec[field]) return rec[field] as string;
    if (Array.isArray(node)) {
      for (const child of node) {
        const hit = visit(child);
        if (hit) return hit;
      }
    }
    return undefined;
  };
  return visit(content);
}

/**
 * Extract the background id from a `Bash({run_in_background:true})` spawn-ack
 * result. Structured `backgroundTaskId` first, then a tolerant text regex.
 * Returns `undefined` when no id is present (caller falls back to toolUseId).
 */
export function parseBackgroundLaunchId(content: unknown): string | undefined {
  const structured = findStructuredString(content, 'backgroundTaskId') ?? findStructuredString(content, 'shellId');
  if (structured) return structured;
  const text = contentToText(content);
  // "...running in background with ID: <id>. Output is being written to..."
  const m = text.match(/\bwith ID:\s*([^\s.]+)/i);
  return m ? m[1] : undefined;
}

/** Classification of a consumer (`TaskOutput`/`BashOutput`/kill) result. */
export interface ConsumerResultClass {
  /** Referenced background id, if the result/identifier exposes one. */
  id?: string;
  /** True when the referenced task has stopped for good. */
  terminal: boolean;
}

/**
 * Classify a consumer tool result. Parses `<task_id>`, `<status>`, `<exit_code>`
 * (current `TaskOutput` shape) and a legacy structured `{status, exitCode}`
 * fallback. A `running`/`pending`/`not_ready`/`timeout` poll is NOT terminal.
 */
export function classifyConsumerResult(content: unknown): ConsumerResultClass {
  const text = contentToText(content);

  const idTag = text.match(/<task_id>\s*([^<\s]+)\s*<\/task_id>/i);
  const structuredId = findStructuredString(content, 'task_id') ?? findStructuredString(content, 'taskId');
  const shellId =
    findStructuredString(content, 'bash_id') ??
    findStructuredString(content, 'shell_id') ??
    findStructuredString(content, 'shellId');
  const id = idTag?.[1] ?? structuredId ?? shellId ?? undefined;

  const statusTag = text.match(/<status>\s*([a-z_]+)\s*<\/status>/i)?.[1]?.toLowerCase();
  const structuredStatus = findStructuredString(content, 'status')?.toLowerCase();
  const status = statusTag ?? structuredStatus;

  const hasExitCodeTag = /<exit_code>\s*-?\d+\s*<\/exit_code>/i.test(text);
  const structuredExit = content && typeof content === 'object' ? (content as { exitCode?: unknown }).exitCode : undefined;
  const hasStructuredExit = typeof structuredExit === 'number';

  let terminal = false;
  if (status && TERMINAL_STATUSES.has(status)) terminal = true;
  else if (status && LIVE_STATUSES.has(status)) terminal = false;
  else if (hasExitCodeTag || hasStructuredExit) terminal = true;
  // Unknown / unparseable status with no exit code → treat as still live so we
  // do not drop a launch prematurely (the resume cap bounds any over-hold).

  return { id, terminal };
}

/** Is this tool name one that consumes/terminates a background shell? */
export function isConsumerToolName(toolName: string | undefined): boolean {
  return !!toolName && CONSUMER_TOOL_NAMES.has(toolName);
}

/**
 * Tracks background-bash launches that are live (spawn-acked, not terminally
 * consumed), keyed by sessionKey. The single source of truth for the resume
 * guard's "is background work still running?" question.
 */
export class BackgroundResumeTracker {
  private map = new Map<string /*sessionKey*/, LiveLaunch[]>();

  /**
   * Record a background-bash launch from its spawn-ack result. Idempotent per
   * id — a second ack for the same id does not double-count.
   */
  trackLaunch(sessionKey: string, launchToolUseId: string, ackContent: unknown): void {
    const id = parseBackgroundLaunchId(ackContent);
    const key = id ?? launchToolUseId;
    const hasId = id != null;
    const list = this.map.get(sessionKey) ?? [];
    if (hasId && list.some((l) => l.hasId && l.key === key)) return; // dedupe by id
    list.push({ key, hasId });
    this.map.set(sessionKey, list);
  }

  /**
   * Observe a consumer (`TaskOutput`/`BashOutput`/kill) result. Drains the
   * matching live launch when the result is terminal. Id-matched when possible;
   * otherwise FIFO-drains one id-less launch. Non-terminal polls are ignored.
   */
  observeConsumerResult(sessionKey: string, toolName: string | undefined, resultContent: unknown): void {
    if (!isConsumerToolName(toolName)) return;
    const list = this.map.get(sessionKey);
    if (!list || list.length === 0) return;

    const { id, terminal } = classifyConsumerResult(resultContent);
    if (!terminal) return;

    let idx = -1;
    if (id) idx = list.findIndex((l) => l.hasId && l.key === id);
    if (idx === -1) idx = list.findIndex((l) => !l.hasId); // FIFO drain an id-less launch
    if (idx === -1 && id) {
      // Terminal result for an id we never tracked (e.g. ack id parse missed).
      // Fall back to draining the oldest live launch so we don't get stuck.
      idx = 0;
    }
    if (idx === -1) return;

    list.splice(idx, 1);
    if (list.length === 0) this.map.delete(sessionKey);
  }

  /** Count of live background-bash launches for a session. */
  liveCount(sessionKey: string): number {
    return this.map.get(sessionKey)?.length ?? 0;
  }

  /** Drop all tracking for a session (resume cap exhausted / session teardown). */
  drain(sessionKey: string): void {
    this.map.delete(sessionKey);
  }
}
