/**
 * Turn Completion Notification System
 * Trace: docs/turn-notification/trace.md, Scenario 1
 *
 * Determines turn completion category, maps to visual properties,
 * and dispatches to all registered NotificationChannels via fire-and-forget.
 */

import { Logger } from './logger.js';

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

// --- Shared helpers ---

/** Build a Slack thread permalink from channel ID and thread timestamp. */
export function buildThreadPermalink(channel: string, threadTs: string): string {
  return `https://slack.com/archives/${channel}/p${threadTs.replace('.', '')}`;
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

export class TurnNotifier {
  constructor(private channels: NotificationChannel[]) {}

  async notify(event: TurnCompletionEvent): Promise<void> {
    const enabledChannels = await Promise.all(
      this.channels.map(async (ch) => {
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

    const results = await Promise.allSettled(
      active.map((ch) => ch.send(event)),
    );

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
