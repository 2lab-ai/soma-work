/**
 * ReportPublisher — Posts formatted reports to Slack channels.
 * Trace: docs/daily-weekly-report/trace.md, Scenario 5
 */

import { Logger } from '../logger';

const logger = new Logger('ReportPublisher');

// Minimal Slack API interface to avoid tight coupling
interface SlackApiLike {
  postMessage(
    channel: string,
    text: string,
    options?: { blocks?: any[]; threadTs?: string },
  ): Promise<{ ts?: string; channel?: string }>;
}

export class ReportPublisher {
  private slackApi: SlackApiLike;

  constructor(slackApi: SlackApiLike) {
    this.slackApi = slackApi;
  }

  /**
   * Publish a formatted report to a Slack channel.
   * Returns the message timestamp if successful.
   */
  async publish(
    channelId: string,
    blocks: any[],
    text: string,
  ): Promise<{ ts?: string } | null> {
    if (!channelId) {
      logger.error('No channel ID configured, skipping report publish');
      return null;
    }

    try {
      const result = await this.slackApi.postMessage(channelId, text, { blocks });
      logger.info(`Published report to ${channelId}, ts=${result.ts}`);
      return { ts: result.ts };
    } catch (error) {
      logger.error(`Failed to publish report to ${channelId}`, error);
      return null;
    }
  }
}
