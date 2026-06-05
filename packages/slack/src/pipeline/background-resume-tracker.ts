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

/** Search structured payloads (object or block array, recursively) for a string field. */
function findStructuredString(content: unknown, field: string): string | undefined {
  const seen = new Set<unknown>();
  const visit = (node: unknown): string | undefined => {
    if (!node || typeof node !== 'object' || seen.has(node)) return undefined;
    seen.add(node);
    const rec = node as Record<string, unknown>;
    if (typeof rec[field] === 'string' && rec[field]) return rec[field] as string;
    // Recurse arrays AND nested object property values (e.g. `{result:{...}}`).
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
  /**
   * True when we recognized ANY signal (id, status, or exit code). False means
   * the result was opaque to the parser — a likely symptom of output-tool shape
   * drift, surfaced as a debug log so it doesn't silently ride launches to the cap.
   */
  recognized: boolean;
}

/**
 * Phrases by which a consumer tool reports that the referenced background task
 * no longer exists. A short-lived `Bash({run_in_background:true})` finishes and
 * is REAPED before the model gets a chance to poll it; a later `TaskOutput`/
 * `BashOutput` on its id then ERRORS with one of these instead of returning a
 * `<status>`. A task the harness cannot find is, by definition, not running, so
 * this is a TERMINAL signal — without it the launch never drains and the
 * background-work resume guard burns every retry up to the per-session cap.
 * Matched ONLY against an error-flagged result (see `isError` gate below) so a
 * normal poll whose captured STDOUT merely contains "not found" (e.g. a build
 * log line) can never be misread as the task being gone.
 */
const TASK_GONE_RE =
  /\bno (?:task|shell|background task|process) found\b|\bno such (?:task|shell|process)\b|\b(?:task|shell|process) (?:already )?(?:killed|stopped|completed|finished|terminated|reaped)\b/i;

/**
 * Classify a consumer tool result. Parses `<task_id>`, `<status>`, `<exit_code>`
 * (current `TaskOutput` shape) and a legacy structured `{status, exitCode}`
 * fallback. A `running`/`pending`/`not_ready`/`timeout` poll is NOT terminal.
 *
 * When `isError` is true, an error envelope whose text matches {@link
 * TASK_GONE_RE} ("No task found with ID: <id>") is also TERMINAL — the polled
 * task was reaped after finishing. Gating on `isError` keeps captured stdout
 * from a still-running poll from ever tripping this.
 */
export function classifyConsumerResult(content: unknown, isError?: boolean): ConsumerResultClass {
  const text = contentToText(content);

  const idTag = text.match(/<task_id>\s*([^<\s]+)\s*<\/task_id>/i);
  const structuredId = findStructuredString(content, 'task_id') ?? findStructuredString(content, 'taskId');
  const shellId =
    findStructuredString(content, 'bash_id') ??
    findStructuredString(content, 'shell_id') ??
    findStructuredString(content, 'shellId');
  // "No task found with ID: <id>" / "...running in background with ID: <id>"
  const idFromText = text.match(/\bwith ID:\s*([^\s.]+)/i)?.[1];
  const id = idTag?.[1] ?? structuredId ?? shellId ?? idFromText ?? undefined;

  const statusTag = text.match(/<status>\s*([a-z_]+)\s*<\/status>/i)?.[1]?.toLowerCase();
  const structuredStatus = findStructuredString(content, 'status')?.toLowerCase();
  const status = statusTag ?? structuredStatus;

  const hasExitCodeTag = /<exit_code>\s*-?\d+\s*<\/exit_code>/i.test(text);
  const structuredExit =
    content && typeof content === 'object' ? (content as { exitCode?: unknown }).exitCode : undefined;
  const hasStructuredExit = typeof structuredExit === 'number';

  // A "task gone" error only counts when no live `<status>` is present (an
  // error envelope never carries `running`/`pending`) — belt-and-suspenders so
  // the two shapes can never disagree.
  const gone = isError === true && status == null && TASK_GONE_RE.test(text);

  let terminal = false;
  if (status && TERMINAL_STATUSES.has(status)) terminal = true;
  else if (status && LIVE_STATUSES.has(status)) terminal = false;
  else if (hasExitCodeTag || hasStructuredExit) terminal = true;
  else if (gone) terminal = true;
  // Unknown / unparseable status with no exit code → treat as still live so we
  // do not drop a launch prematurely (the resume cap bounds any over-hold).

  const recognized = id != null || status != null || hasExitCodeTag || hasStructuredExit || gone;
  return { id, terminal, recognized };
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
   * @param onUnrecognized optional hook fired when a consumer-tool result is
   * opaque to the parser (no id/status/exit). Lets the host log a greppable
   * signal so future output-tool shape drift doesn't silently ride launches to
   * the resume cap. Pure-by-default: omitted in unit tests.
   */
  constructor(private onUnrecognized?: (toolName: string) => void) {}

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
   *
   * `isError` (the tool_result's error flag) lets a "No task found with ID:
   * <id>" error — a short bg shell reaped after finishing but before the model
   * polled — count as terminal, without a still-running poll's stdout tripping
   * the same phrase. See {@link TASK_GONE_RE}.
   */
  observeConsumerResult(
    sessionKey: string,
    toolName: string | undefined,
    resultContent: unknown,
    isError?: boolean,
  ): void {
    if (!isConsumerToolName(toolName)) return;
    const list = this.map.get(sessionKey);
    if (!list || list.length === 0) return;

    const { id, terminal, recognized } = classifyConsumerResult(resultContent, isError);
    // Surface parser drift: a known consumer tool whose result we could not read
    // at all. Bounded by the resume cap, but worth a greppable signal.
    if (!recognized && this.onUnrecognized && toolName) this.onUnrecognized(toolName);
    if (!terminal) return;

    let idx = -1;
    if (id) {
      // Id-bearing terminal result: drain ONLY the id-matched launch. If no
      // match, it is not one of our tracked bashes (e.g. a background SUBAGENT
      // TaskOutput, #794) — do NOT FIFO-drain, which would erroneously release
      // an unrelated bash launch. A launch whose ack id-parse missed stays live
      // until the cap (the safe direction).
      idx = list.findIndex((l) => l.hasId && l.key === id);
    } else {
      // Legacy id-less terminal result → FIFO-drain one id-less launch.
      idx = list.findIndex((l) => !l.hasId);
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
