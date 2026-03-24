/**
 * Telegram DM notification channel — sends message via Bot API.
 * Trace: docs/turn-notification/trace.md, Scenario 4
 * Opt-in: user must register chat ID via `notify telegram <id>`.
 * Requires TELEGRAM_BOT_TOKEN environment variable.
 */

import { NotificationChannel, TurnCompletionEvent, getCategoryEmoji, getCategoryLabel } from '../turn-notifier.js';
import { Logger } from '../logger.js';

const logger = new Logger('TelegramChannel');

interface SettingsStoreLike {
  getUserSettings(userId: string): { notification?: { telegramChatId?: string } } | undefined;
}

type FetchFn = (url: string, init: any) => Promise<{ ok: boolean; status: number }>;

function buildThreadPermalink(channel: string, threadTs: string): string {
  return `https://slack.com/archives/${channel}/p${threadTs.replace('.', '')}`;
}

export class TelegramChannel implements NotificationChannel {
  name = 'telegram';

  constructor(
    private settingsStore: SettingsStoreLike,
    private botToken: string | undefined,
    private fetchFn: FetchFn = globalThis.fetch,
  ) {}

  async isEnabled(userId: string): Promise<boolean> {
    if (!this.botToken) return false;
    const settings = this.settingsStore.getUserSettings(userId);
    return Boolean(settings?.notification?.telegramChatId);
  }

  async send(event: TurnCompletionEvent): Promise<void> {
    if (!this.botToken) return;

    const settings = this.settingsStore.getUserSettings(event.userId);
    const chatId = settings?.notification?.telegramChatId;
    if (!chatId) return;

    const emoji = getCategoryEmoji(event.category);
    const label = getCategoryLabel(event.category);
    const title = event.sessionTitle || 'Session';
    const permalink = buildThreadPermalink(event.channel, event.threadTs);
    const text = `${emoji} [soma-work] ${label}: ${title}\n${permalink}`;

    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const body = JSON.stringify({
      chat_id: chatId,
      text,
      // No parse_mode — sessionTitle is user input and can contain Markdown special chars
      // that cause Telegram 400 "can't parse entities" errors
    });

    try {
      const response = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      if (!response.ok) {
        logger.warn('TelegramChannel API error', { chatId, status: response.status });
        throw new Error(`Telegram API returned ${response.status}`);
      } else {
        logger.info('TelegramChannel.send()', { chatId, category: event.category });
      }
    } catch (error: any) {
      logger.warn('TelegramChannel failed', { chatId, error: error.message });
      // Graceful — do not throw
    }
  }
}
