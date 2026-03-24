/**
 * Slack DM notification channel — sends DM to user on turn completion.
 * Trace: docs/turn-notification/trace.md, Scenario 2
 * Opt-in: user must enable via `notify on`.
 */

import { NotificationChannel, TurnCompletionEvent, getCategoryEmoji, getCategoryLabel } from '../turn-notifier.js';
import { Logger } from '../logger.js';

const logger = new Logger('SlackDmChannel');

interface SlackApiLike {
  openDmChannel(userId: string): Promise<string>;
  postMessage(channel: string, text: string, options?: any): Promise<any>;
  getPermalink(channel: string, messageTs: string): Promise<string | null>;
}

interface SettingsStoreLike {
  getUserSettings(userId: string): { notification?: { slackDm?: boolean } } | undefined;
}

function buildThreadPermalink(channel: string, threadTs: string): string {
  return `https://slack.com/archives/${channel}/p${threadTs.replace('.', '')}`;
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

    // Use Slack API permalink when available, fall back to hardcoded format
    const permalink = await this.slackApi.getPermalink(event.channel, event.threadTs)
      ?? buildThreadPermalink(event.channel, event.threadTs);

    let dmChannelId: string;
    try {
      dmChannelId = await this.slackApi.openDmChannel(event.userId);
    } catch (error: any) {
      logger.warn('SlackDmChannel: failed to open DM', {
        userId: event.userId,
        error: error.message,
      });
      return; // Cannot send DM — graceful exit
    }

    try {
      const text = `${emoji} ${label} — ${title}`;
      const blocks = [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${emoji} *${label}* — ${title}\n<${permalink}|스레드로 이동>`,
          },
        },
      ];

      await this.slackApi.postMessage(dmChannelId, text, { blocks });
      logger.info('SlackDmChannel.send()', { userId: event.userId, category: event.category });
    } catch (error: any) {
      logger.warn('SlackDmChannel: failed to post message', {
        userId: event.userId,
        dmChannelId,
        error: error.message,
      });
      // Graceful — do not throw
    }
  }
}
