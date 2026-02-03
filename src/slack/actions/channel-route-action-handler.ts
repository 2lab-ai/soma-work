/**
 * ChannelRouteActionHandler — Handles channel routing actions
 * when a PR link is detected in the wrong channel.
 *
 * Actions:
 * - channel_route_move: Delete advisory message, create thread in correct channel
 * - channel_route_stop: Delete advisory message, stop processing
 */

import { SlackApiHelper } from '../slack-api-helper';
import { ClaudeHandler } from '../../claude-handler';
import { Logger } from '../../logger';

const logger = new Logger('ChannelRouteAction');

interface ChannelRouteDeps {
  slackApi: SlackApiHelper;
  claudeHandler: ClaudeHandler;
  messageHandler: (event: any, say: any) => Promise<void>;
}

interface RouteActionValue {
  targetChannel: string;
  targetChannelName: string;
  originalChannel: string;
  originalTs: string;
  userMessage: string;
  userId: string;
  prUrl?: string;
}

export class ChannelRouteActionHandler {
  constructor(private deps: ChannelRouteDeps) {}

  /**
   * Handle "Move to correct channel" button click
   */
  async handleMove(body: any, respond: any): Promise<void> {
    try {
      const action = body.actions?.[0];
      const value: RouteActionValue = JSON.parse(action?.value || '{}');
      const userId = body.user?.id;

      if (!value.targetChannel || !userId) {
        logger.warn('Invalid channel route move action', { value });
        return;
      }

      // Delete the advisory message
      try {
        await this.deps.slackApi.deleteMessage(value.originalChannel, value.originalTs);
      } catch {
        // Advisory message might already be gone
      }

      // Terminate original ghost session
      const origKey = `${value.originalChannel}:${value.originalTs}`;
      this.deps.claudeHandler.terminateSession(origKey);

      // Create new thread in correct channel
      // Bot posts as the thread root with user mention and PR info
      const threadRootText = value.prUrl
        ? `<@${userId}> 님의 작업 요청 — ${value.prUrl}`
        : `<@${userId}> 님의 작업 요청`;

      const postResult = await this.deps.slackApi.postMessage(
        value.targetChannel,
        threadRootText
      );

      if (!postResult?.ts) {
        logger.error('Failed to create thread in target channel', { targetChannel: value.targetChannel });
        return;
      }

      // Now simulate the user's original message in the new thread
      const syntheticEvent = {
        text: value.userMessage,
        user: userId,
        channel: value.targetChannel,
        ts: `synthetic_${Date.now()}`,
        thread_ts: postResult.ts,
      };

      const syntheticSay = async (msg: any) => {
        return this.deps.slackApi.postMessage(
          value.targetChannel,
          msg.text,
          { threadTs: postResult.ts, blocks: msg.blocks }
        );
      };

      // Pre-mark so SessionInitializer picks up bot-initiated mode during initialization
      // setBotThread is called again after messageHandler in case session is recreated
      this.deps.claudeHandler.setBotThread(value.targetChannel, postResult.ts, postResult.ts);

      // Process the message in the new channel/thread
      await this.deps.messageHandler(syntheticEvent, syntheticSay);

      // Re-mark to ensure bot-initiated mode is set (session may have been created during messageHandler)
      this.deps.claudeHandler.setBotThread(value.targetChannel, postResult.ts, postResult.ts);

      logger.info('Routed conversation to correct channel (bot-initiated thread)', {
        from: value.originalChannel,
        to: value.targetChannel,
        user: userId,
        threadRootTs: postResult.ts,
      });
    } catch (error) {
      logger.error('Failed to handle channel route move', error);
      try {
        await respond({ text: '⚠️ 채널 이동에 실패했습니다.', replace_original: true });
      } catch {}
    }
  }

  /**
   * Handle "Stop" button click
   */
  async handleStop(body: any, respond: any): Promise<void> {
    try {
      const action = body.actions?.[0];
      const value: RouteActionValue = JSON.parse(action?.value || '{}');

      // Delete the advisory message
      try {
        await this.deps.slackApi.deleteMessage(value.originalChannel, value.originalTs);
      } catch {
        // Advisory message might already be gone
      }

      logger.info('User declined channel route', {
        channel: value.originalChannel,
        user: body.user?.id,
      });
    } catch (error) {
      logger.error('Failed to handle channel route stop', error);
    }
  }
}

/**
 * Build the channel routing advisory message blocks.
 * Returns Slack blocks for a message with Move/Stop buttons.
 */
export function buildChannelRouteBlocks(params: {
  prUrl: string;
  targetChannelName: string;
  targetChannelId: string;
  originalChannel: string;
  originalTs: string;
  userMessage: string;
  userId: string;
}): { text: string; blocks: any[] } {
  const value: RouteActionValue = {
    targetChannel: params.targetChannelId,
    targetChannelName: params.targetChannelName,
    originalChannel: params.originalChannel,
    originalTs: params.originalTs,
    userMessage: params.userMessage,
    userId: params.userId,
    prUrl: params.prUrl,
  };
  const valueStr = JSON.stringify(value);

  const text = `이 repo는 #${params.targetChannelName} 채널의 작업입니다. 이동하시겠습니까?`;

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `🔀 이 repo는 <#${params.targetChannelId}> 채널의 작업입니다.\n이동하시겠습니까?`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '이동', emoji: true },
          style: 'primary',
          value: valueStr,
          action_id: 'channel_route_move',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '작업 중지', emoji: true },
          value: valueStr,
          action_id: 'channel_route_stop',
        },
      ],
    },
  ];

  return { text, blocks };
}
