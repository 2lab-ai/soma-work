/**
 * Slack Block Kit notification channel — posts colored status message to thread.
 * Trace: docs/turn-notification/trace.md, Scenario 1 (Section 3c)
 * Always enabled — this is the default in-thread visual feedback.
 */

import { NotificationChannel, TurnCompletionEvent, getCategoryColor, getCategoryEmoji, getCategoryLabel } from '../turn-notifier.js';
import { Logger } from '../logger.js';

const logger = new Logger('SlackBlockKitChannel');

export class SlackBlockKitChannel implements NotificationChannel {
  name = 'slack-block-kit';

  constructor(
    private slackApi: { postMessage: (channel: string, text: string, options?: any) => Promise<any> },
  ) {}

  async isEnabled(_userId: string): Promise<boolean> {
    return true; // Always enabled — core UX
  }

  async send(event: TurnCompletionEvent): Promise<void> {
    const color = getCategoryColor(event.category);
    const emoji = getCategoryEmoji(event.category);
    const label = getCategoryLabel(event.category);
    const text = `${emoji} *${label}*`;

    const contextParts: string[] = [];
    if (event.sessionTitle) contextParts.push(`세션: ${event.sessionTitle}`);
    if (event.durationMs) contextParts.push(`소요: ${Math.round(event.durationMs / 1000)}s`);

    const blocks: any[] = [
      { type: 'section', text: { type: 'mrkdwn', text } },
    ];

    if (contextParts.length > 0) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: contextParts.join(' | ') }],
      });
    }

    try {
      await this.slackApi.postMessage(event.channel, text, {
        threadTs: event.threadTs,
        attachments: [{ color, blocks }],
      });
    } catch (error: any) {
      logger.warn('Failed to post Block Kit notification', { error: error.message });
    }
  }
}
