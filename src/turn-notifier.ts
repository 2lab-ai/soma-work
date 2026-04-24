/**
 * Turn Completion Notification System
 * Trace: docs/turn-notification/trace.md, Scenario 1
 *
 * Determines turn completion category, maps to visual properties,
 * and dispatches to all registered NotificationChannels via fire-and-forget.
 */

import { Logger } from './logger.js';
import type { EffortLevel } from './user-settings-store.js';

const logger = new Logger('TurnNotifier');

// --- Types ---

export type TurnCategory = 'UIUserAskQuestion' | 'WorkflowComplete' | 'Exception';

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

export function determineTurnCategory(input: { hasPendingChoice: boolean; isError: boolean }): TurnCategory {
  if (input.isError) return 'Exception';
  if (input.hasPendingChoice) return 'UIUserAskQuestion';
  return 'WorkflowComplete';
}

// --- Color mapping ---

const CATEGORY_COLORS: Record<TurnCategory, string> = {
  UIUserAskQuestion: '#FF9500',
  WorkflowComplete: '#36B37E',
  Exception: '#FF5630',
};

export function getCategoryColor(category: TurnCategory): string {
  return CATEGORY_COLORS[category];
}

const CATEGORY_EMOJI: Record<TurnCategory, string> = {
  UIUserAskQuestion: '🟠',
  WorkflowComplete: '🟢',
  Exception: '🔴',
};

export function getCategoryEmoji(category: TurnCategory): string {
  return CATEGORY_EMOJI[category];
}

const CATEGORY_LABEL: Record<TurnCategory, string> = {
  UIUserAskQuestion: '유저 입력 대기',
  WorkflowComplete: '작업 완료',
  Exception: '오류 발생',
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
 * Options for {@link TurnNotifier.notify}.
 *
 * #667 P5 — `excludeChannelNames` lets the caller skip specific channels by
 * `name` even when they are `isEnabled`. Used by `stream-executor` at
 * `SOMA_UI_5BLOCK_PHASE>=5` + capability-active to suppress the legacy
 * `slack-block-kit` write so `TurnSurface` becomes the single writer of
 * the in-thread `WorkflowComplete` B5 marker. The filter is a caller-
 * controlled no-op: when omitted, behaviour is identical to the pre-P5
 * signature.
 *
 * Exclusion does NOT override `isEnabled` — a disabled channel stays not-
 * sent even if absent from the filter. Unknown names are a no-op filter.
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

    // Apply the caller-controlled filter BEFORE `isEnabled` so a channel
    // marked for exclusion isn't needlessly probed. Filter is a no-op when
    // `opts` is undefined or the names array is empty.
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

    if (active.length === 0) return;

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
