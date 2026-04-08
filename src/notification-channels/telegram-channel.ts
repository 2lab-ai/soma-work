/**
 * Telegram DM notification channel — sends message via Bot API.
 * Trace: docs/turn-notification/trace.md, Scenario 4
 * Opt-in: user must register chat ID via `notify telegram <id>`.
 * Requires TELEGRAM_BOT_TOKEN environment variable.
 */

import { Logger } from '../logger.js';
import {
  buildThreadPermalink,
  getCategoryEmoji,
  getCategoryLabel,
  type NotificationChannel,
  type TurnCompletionEvent,
} from '../turn-notifier.js';

const logger = new Logger('TelegramChannel');

interface SettingsStoreLike {
  getUserSettings(userId: string): { notification?: { telegramChatId?: string } } | undefined;
}

type FetchFn = (url: string, init: any) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const TIMEOUT_MS = 5000;

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
    const text = permalink
      ? `${emoji} [soma-work] ${label}: ${title}\n${permalink}`
      : `${emoji} [soma-work] ${label}: ${title}`;

    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const body = JSON.stringify({
      chat_id: chatId,
      text,
      // No parse_mode — sessionTitle is user input and can contain Markdown special chars
      // that cause Telegram 400 "can't parse entities" errors
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
        redirect: 'error',
      });

      if (!response.ok) {
        const respBody = await response.text().catch(() => '');
        logger.warn('TelegramChannel API error', { chatId, status: response.status, body: respBody.slice(0, 200) });
        return;
      }
      logger.info('TelegramChannel.send()', { chatId, category: event.category });
    } catch (error: any) {
      const msg = error.name === 'AbortError' ? `timeout (${TIMEOUT_MS / 1000}s)` : error.message;
      logger.warn('TelegramChannel failed', { chatId, error: msg });
      // Graceful — do not throw
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
