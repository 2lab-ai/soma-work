/**
 * Turn Completion Notification System
 * Trace: docs/turn-notification/trace.md, Scenario 1
 *
 * Determines turn completion category, maps to visual properties,
 * and dispatches to all registered NotificationChannels via fire-and-forget.
 */

import { Logger } from '@soma/common/logger';

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const logger = new Logger('TurnNotifier');

// --- Types ---

/**
 * Turn completion category — user-defined invariant:
 *  - `WorkflowComplete` 🟢 — model emitted end_turn; turn finished normally.
 *  - `UIUserAskQuestion` 🟠 — model emitted a formal ASK / pending-form;
 *    turn paused waiting on user input.
 *  - `Exception` 🔴 — IMMEDIATE model or code error (SDK throw, max_turns,
 *    parse failure, etc.). NOT for timeouts — those are `Stalled`.
 *  - `Stalled` ⚫ — idle-timeout fired without seeing end_turn or ASK from
 *    the model. This is a CODE BUG signal: somewhere in our pipeline, the
 *    model produced a turn that did not surface a terminal signal in time.
 *    Operators investigating these cards should treat them as TODO items
 *    to remove the offending code path (per user invariant: "타임아웃나는
 *    경우를 모두 제거하라"). NOT a model/SDK runtime error.
 */
export type TurnCategory = 'UIUserAskQuestion' | 'WorkflowComplete' | 'Exception' | 'Stalled';

/** Per-tool call statistics for rich notification */
export interface ToolStatEntry {
  count: number;
  totalDurationMs: number;
}

export interface TurnCompletionEvent {
  category: TurnCategory;
  userId: string;
  channel: string;
  threadTs: string;
  sessionTitle?: string;
  message?: string;
  durationMs: number;
  /**
   * Stable per-turn id (`sessionKey:ts:uuid`, generated in stream-executor).
   * Carried to the B5 card so the feedback affordance (#1064) can reference the
   * turn in its button value. Optional for backward compatibility.
   */
  turnId?: string;
  // Rich notification fields (all optional for backward compatibility)
  // Trace: docs/rich-turn-notification/trace.md, Scenario 1
  persona?: string;
  model?: string;
  effort?: EffortLevel;
  startedAt?: Date;
  contextUsagePercent?: number;
  contextUsageDelta?: number;
  contextUsageTokens?: number;
  contextWindowSize?: number;
  fiveHourUsage?: number;
  fiveHourDelta?: number;
  sevenDayUsage?: number;
  sevenDayDelta?: number;
  toolStats?: Record<string, ToolStatEntry>;
}

export interface NotificationChannel {
  name: string;
  isEnabled(userId: string): Promise<boolean>;
  send(event: TurnCompletionEvent): Promise<void>;
}

// --- Category determination ---

export function determineTurnCategory(input: {
  hasPendingChoice: boolean;
  isError: boolean;
  /**
   * `true` when the turn ended because the idle-timeout watchdog fired
   * (no SDK activity for `SOMA_STREAM_STALL_TIMEOUT_MS`) — distinct from
   * an immediate SDK/model error. Optional for back-compat with callers
   * that don't yet thread the signal through.
   */
  isStalled?: boolean;
}): TurnCategory {
  // Order matters. Stalled takes precedence over Error because a stall
  // surfaces as an AbortError (looks like an error at the catch site)
  // but should NOT be classified red — see TurnCategory JSDoc.
  if (input.isStalled) return 'Stalled';
  if (input.isError) return 'Exception';
  if (input.hasPendingChoice) return 'UIUserAskQuestion';
  return 'WorkflowComplete';
}

// --- Color mapping ---

const CATEGORY_COLORS: Record<TurnCategory, string> = {
  UIUserAskQuestion: '#FF9500',
  WorkflowComplete: '#36B37E',
  Exception: '#FF5630',
  // Near-black, visually distinct from Exception's red so operators
  // immediately recognize "this is the investigation queue, not a
  // model/API failure". Pure #000 reads as missing-style in Slack
  // attachments — `#1F1F1F` is the safest dark.
  Stalled: '#1F1F1F',
};

export function getCategoryColor(category: TurnCategory): string {
  return CATEGORY_COLORS[category];
}

const CATEGORY_EMOJI: Record<TurnCategory, string> = {
  UIUserAskQuestion: '🟠',
  WorkflowComplete: '🟢',
  Exception: '🔴',
  Stalled: '⚫',
};

export function getCategoryEmoji(category: TurnCategory): string {
  return CATEGORY_EMOJI[category];
}

const CATEGORY_LABEL: Record<TurnCategory, string> = {
  UIUserAskQuestion: '유저 입력 대기',
  WorkflowComplete: '작업 완료',
  Exception: '오류 발생',
  // Intentionally distinct phrasing — this is NOT an error in the
  // model/SDK sense; it is a missed `end_turn`/`ASK` signal that
  // pipeline code should have produced. Wording invites operator
  // investigation rather than implying a model failure.
  Stalled: '응답 없음 — 코드 버그 의심',
};

export function getCategoryLabel(category: TurnCategory): string {
  return CATEGORY_LABEL[category];
}

// --- Slack workspace URL singleton (set once at startup) ---

let _workspaceUrl: string | undefined;

/** Set the Slack workspace base URL (from auth.test().url). Call once at startup. */
export function setSlackWorkspaceUrl(url: string): void {
  _workspaceUrl = url.endsWith('/') ? url : url + '/';
}

/** Get the cached workspace URL (undefined if not initialized). */
export function getSlackWorkspaceUrl(): string | undefined {
  return _workspaceUrl;
}

/** Reset workspace URL — for test isolation only. */
export function resetSlackWorkspaceUrl(): void {
  _workspaceUrl = undefined;
}

// --- Shared helpers ---

/**
 * Coalesce any thrown value into a human-readable string suitable for
 * `TurnCompletionEvent.message`. The Slack block-kit Exception card uses
 * this directly as the visible body; the renderer separately picks a short
 * first-line summary for the header suffix.
 *
 * Priority:
 *  1. `Error.message` (the common path)
 *  2. `error.code` (OAuth refresh, net-layer `{ code: 'ETIMEDOUT' }`)
 *  3. `error.name` (subclassed Errors with empty message)
 *  4. `String(error)` (plain strings, JSON-shaped throws)
 *
 * Returns the empty string for `null` / `undefined` / objects that
 * stringify to `[object Object]` and have no useful fields — callers can
 * then fall back to a generic reason.
 */
export function coalesceErrorMessage(error: unknown): string {
  if (error === null || error === undefined) return '';

  if (typeof error === 'string') return error;

  if (typeof error === 'object') {
    const err = error as { message?: unknown; code?: unknown; name?: unknown };
    if (typeof err.message === 'string' && err.message.trim().length > 0) {
      return err.message;
    }
    if (typeof err.code === 'string' && err.code.trim().length > 0) {
      return err.code;
    }
    if (typeof err.name === 'string' && err.name.trim().length > 0 && err.name !== 'Error') {
      return err.name;
    }
    // Fall through to String(error) — which is "[object Object]" for plain
    // objects. We replace that uninformative default with JSON.stringify so
    // shaped throws like `{ statusCode: 429, retryAfter: 10 }` still leave
    // a trace.
    try {
      const stringified = JSON.stringify(error);
      if (stringified && stringified !== '{}') return stringified;
    } catch {
      // circular ref or non-serializable — fall through
    }
    return '';
  }

  return String(error);
}

/** Build a Slack thread permalink from channel ID and thread timestamp. */
export function buildThreadPermalink(channel: string, threadTs: string): string | null {
  if (!_workspaceUrl) {
    return null;
  }
  return `${_workspaceUrl}archives/${channel}/p${threadTs.replace('.', '')}`;
}

/** Mask a URL for safe logging: `https://hooks.slack.com/***` */
export function maskUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.hostname}/***`;
  } catch {
    return '***';
  }
}

// --- TurnNotifier service ---

/**
 * Options for {@link TurnNotifier.notify}. `excludeChannelNames` filters
 * channels by `name` before `isEnabled` is probed (exclusion doesn't override
 * enablement). Omitting opts is identical to the pre-P5 single-arg signature.
 */
export interface TurnNotifierNotifyOpts {
  /** Channel `name` values to skip. Empty array ≡ no filter. */
  excludeChannelNames?: string[];
}

export class TurnNotifier {
  constructor(private channels: NotificationChannel[]) {}

  async notify(event: TurnCompletionEvent, opts?: TurnNotifierNotifyOpts): Promise<void> {
    const excludeSet =
      opts?.excludeChannelNames && opts.excludeChannelNames.length > 0 ? new Set(opts.excludeChannelNames) : undefined;

    const candidateChannels = excludeSet ? this.channels.filter((ch) => !excludeSet.has(ch.name)) : this.channels;

    const enabledChannels = await Promise.all(
      candidateChannels.map(async (ch) => {
        try {
          const enabled = await ch.isEnabled(event.userId);
          return enabled ? ch : null;
        } catch (error: any) {
          logger.warn(`Channel ${ch.name} isEnabled() check failed`, {
            userId: event.userId,
            error: error?.message || String(error),
          });
          return null;
        }
      }),
    );

    const active = enabledChannels.filter((ch): ch is NotificationChannel => ch !== null);

    if (active.length === 0) {
      if (excludeSet) {
        // A caller passing `excludeChannelNames` declares those channels are
        // handled elsewhere — in the P5 path, `TurnSurface.end` has ALREADY
        // surfaced the B5 terminal card via the block-kit channel (that is
        // exactly why `slack-block-kit` is excluded here, see
        // StreamExecutor.buildCompletionNotifyOpts). Zero remaining enabled
        // channels just means the user has no opt-in fan-out channels
        // (slack-dm / webhook / telegram) — fully expected, NOT a missing
        // card. Logging this case with the §B-3 warn below ("terminal card
        // not surfaced") is factually wrong and caused a real misdiagnosis
        // during the #1079 invalid_blocks incident triage.
        logger.debug('TurnNotifier: no opt-in fan-out channels enabled — terminal card already surfaced upstream', {
          userId: event.userId,
          category: event.category,
          excluded: [...excludeSet],
        });
        return;
      }
      // Turn-end surface guarantee §B-3: zero enabled channels means the
      // turn just ended with NO terminal signal anywhere. Pre-fix this
      // returned silently — operators triaging "where did the card go?"
      // had no breadcrumb. The warn is observability-only; we don't fall
      // back to a default channel here because misconfigured workspaces
      // (no enabled channels at all) are an operator concern, not a
      // runtime hot path.
      // Trace: docs/current/plans/turn-end-surface-guarantee/exhaustive-paths.md §B-3.
      logger.warn('TurnNotifier: no enabled channels — terminal card not surfaced', {
        userId: event.userId,
        category: event.category,
        channel: event.channel,
        threadTs: event.threadTs,
      });
      return;
    }

    const results = await Promise.allSettled(active.map((ch) => ch.send(event)));

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') {
        logger.warn(`TurnNotifier channel=${active[i].name} failed`, {
          error: result.reason?.message || String(result.reason),
        });
      }
    }
  }
}
