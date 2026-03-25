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

export interface TurnCompletionEvent {
  category: TurnCategory;
  userId: string;
  channel: string;
  threadTs: string;
  sessionTitle?: string;
  message?: string;
  durationMs: number;
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
          logger.warn('TurnNotifier isEnabled check failed for channel', {
            channel: ch.name,
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
