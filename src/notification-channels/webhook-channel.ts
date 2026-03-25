/**
 * Webhook notification channel — POST event payload to user-registered URL.
 * Trace: docs/turn-notification/trace.md, Scenario 3
 * Opt-in: user must register URL via `webhook register <url>`.
 * Retry: up to 3 attempts with exponential backoff for 5xx/network errors.
 */

import { NotificationChannel, TurnCompletionEvent } from '../turn-notifier.js';
import { Logger } from '../logger.js';
import { validateWebhookUrlWithDns } from '../webhook-url-validator.js';

const logger = new Logger('WebhookChannel');

const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 5000;

interface SettingsStoreLike {
  getUserSettings(userId: string): { notification?: { webhookUrl?: string } } | undefined;
}

type FetchFn = (url: string, init: any) => Promise<{ ok: boolean; status: number }>;

export class WebhookChannel implements NotificationChannel {
  name = 'webhook';

  constructor(
    private settingsStore: SettingsStoreLike,
    private fetchFn: FetchFn = globalThis.fetch,
  ) {}

  async isEnabled(userId: string): Promise<boolean> {
    const settings = this.settingsStore.getUserSettings(userId);
    return Boolean(settings?.notification?.webhookUrl);
  }

  async send(event: TurnCompletionEvent): Promise<void> {
    const settings = this.settingsStore.getUserSettings(event.userId);
    const url = settings?.notification?.webhookUrl;
    if (!url) return;

    // SSRF defense: validate URL at send-time with DNS resolution (catches DNS rebinding)
    const validation = await validateWebhookUrlWithDns(url);
    if (!validation.valid) {
      logger.warn('WebhookChannel blocked unsafe URL at send-time', { url: url.slice(0, 50), reason: validation.error });
      return;
    }

    const payload = {
      event: 'turn_completed',
      category: event.category,
      sessionId: `${event.channel}-${event.threadTs}`,
      userId: event.userId,
      channel: event.channel,
      threadTs: event.threadTs,
      message: event.message,
      timestamp: new Date().toISOString(),
    };

    const body = JSON.stringify(payload);

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

        const response = await this.fetchFn(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: controller.signal,
          redirect: 'error',
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          logger.info('WebhookChannel.send()', { url, attempt: attempt + 1, status: response.status });
          return;
        }

        // 4xx = permanent failure, do not retry
        if (response.status >= 400 && response.status < 500) {
          logger.warn('WebhookChannel 4xx permanent failure', { url, status: response.status });
          return;
        }

        // 5xx = transient failure, retry
        logger.warn('WebhookChannel 5xx, will retry', { url, attempt: attempt + 1, status: response.status });
      } catch (error: any) {
        logger.warn('WebhookChannel network error', { url, attempt: attempt + 1, error: error.message });
      }

      // Backoff before next attempt (skip for last attempt)
      if (attempt < MAX_ATTEMPTS - 1) {
        const delayMs = 1000 * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    logger.error('WebhookChannel FAILED after all attempts', { url: url.slice(0, 50) });
  }
}
