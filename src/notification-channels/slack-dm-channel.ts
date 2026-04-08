/**
 * Slack DM notification channel — sends DM to user on turn completion.
 * Trace: docs/turn-notification/trace.md, Scenario 2
 * Opt-in: user must enable via `notify on`.
 */

import { Logger } from '../logger.js';
import {
  buildThreadPermalink,
  getCategoryEmoji,
  getCategoryLabel,
  type NotificationChannel,
  type TurnCompletionEvent,
} from '../turn-notifier.js';

const logger = new Logger('SlackDmChannel');

interface SlackApiLike {
  openDmChannel(userId: string): Promise<string>;
  postMessage(channel: string, text: string, options?: any): Promise<any>;
}

interface SettingsStoreLike {
  getUserSettings(userId: string): { notification?: { slackDm?: boolean } } | undefined;
}

export class SlackDmChannel implements NotificationChannel {
  name = 'slack-dm';

  constructor(
    private slackApi: SlackApiLike,
    private settingsStore: SettingsStoreLike,
  ) {}

  async isEnabled(userId: string): Promise<boolean> {
    const settings = this.settingsStore.getUserSettings(userId);
    return settings?.notification?.slackDm === true;
  }

  async send(event: TurnCompletionEvent): Promise<void> {
    const emoji = getCategoryEmoji(event.category);
    const label = getCategoryLabel(event.category);
    const title = event.sessionTitle || 'Session';
    const permalink = buildThreadPermalink(event.channel, event.threadTs);

    let dmChannelId: string;
    try {
      dmChannelId = await this.slackApi.openDmChannel(event.userId);
    } catch (error: any) {
      logger.warn('SlackDmChannel: failed to open DM', { userId: event.userId, error: error.message });
      return; // Graceful — do not throw
    }

    try {
      const text = `${emoji} ${label} — ${title}`;
      const mrkdwn = permalink
        ? `${emoji} *${label}* — ${title}\n<${permalink}|스레드로 이동>`
        : `${emoji} *${label}* — ${title}`;
      const blocks = [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: mrkdwn,
          },
        },
      ];

      await this.slackApi.postMessage(dmChannelId, text, { blocks });
      logger.info('SlackDmChannel.send()', { userId: event.userId, category: event.category });
    } catch (error: any) {
      logger.warn('SlackDmChannel: failed to send DM', { userId: event.userId, dmChannelId, error: error.message });
      // Graceful — do not throw
    }
  }
}
