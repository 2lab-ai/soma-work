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
import { ThreadHeaderBuilder } from '../thread-header-builder';
import { MessageFormatter } from '../message-formatter';
import { SessionLinks, SessionLink } from '../../types';

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
  originalThreadTs?: string;
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
      const rawValue = action?.value || '{}';
      const value: RouteActionValue = JSON.parse(rawValue);
      const userId = body.user?.id;
      const originalThreadTs = value.originalThreadTs || body.message?.thread_ts;
      const sessionThreadTs = originalThreadTs || value.originalTs;

      logger.info('🔀 handleMove START', {
        userId,
        targetChannel: value.targetChannel,
        targetChannelName: value.targetChannelName,
        originalChannel: value.originalChannel,
        originalTs: value.originalTs,
        originalThreadTs,
        sessionThreadTs,
        prUrl: value.prUrl,
        userMessage: value.userMessage?.substring(0, 50),
      });

      if (!value.targetChannel || !userId) {
        logger.warn('🔀 handleMove: Invalid action value', { value, userId });
        return;
      }

      // Delete the advisory message
      try {
        logger.debug('🔀 Deleting advisory message', { channel: value.originalChannel, ts: value.originalTs });
        await this.deps.slackApi.deleteMessage(value.originalChannel, value.originalTs);
      } catch (e) {
        logger.debug('🔀 Advisory message already gone', { error: (e as Error).message });
      }

      if (!originalThreadTs) {
        logger.warn('🔀 Missing original thread ts', { value });
      } else {
        logger.debug('🔀 Deleting bot messages in original thread', { channel: value.originalChannel, threadTs: originalThreadTs });
        await this.deps.slackApi.deleteThreadBotMessages(value.originalChannel, originalThreadTs, {
          excludeTs: value.originalTs ? [value.originalTs] : [],
        });
      }

      // Terminate original ghost session
      if (sessionThreadTs) {
        const origKey = this.deps.claudeHandler.getSessionKey(value.originalChannel, sessionThreadTs);
        logger.info('🔀 Terminating original session', { origKey, channel: value.originalChannel, threadTs: sessionThreadTs });
        this.deps.claudeHandler.terminateSession(origKey);
      }

      // Create new thread in correct channel
      const threadRootText = value.prUrl
        ? `<@${userId}> 님의 작업 요청 — ${value.prUrl}`
        : `<@${userId}> 님의 작업 요청`;

      const ownerName = await this.deps.slackApi.getUserName(userId);
      const title = MessageFormatter.generateSessionTitle(value.userMessage || threadRootText);
      const links = this.buildLinks(value.prUrl);
      const headerPayload = ThreadHeaderBuilder.build({
        title,
        workflow: 'default',
        ownerName,
        ownerId: userId,
        activityState: 'idle',
        lastActivity: new Date(),
        links,
      });

      logger.info('🔀 Creating thread in target channel', {
        targetChannel: value.targetChannel,
        targetChannelName: value.targetChannelName,
        threadRootText: threadRootText.substring(0, 80),
      });

      const postResult = await this.deps.slackApi.postMessage(
        value.targetChannel,
        headerPayload.text,
        {
          attachments: headerPayload.attachments,
          blocks: headerPayload.blocks,
        }
      );

      if (!postResult?.ts) {
        logger.error('🔀 Failed to create thread in target channel - no ts returned', {
          targetChannel: value.targetChannel,
          postResult,
        });
        return;
      }

      logger.info('🔀 Thread root created, constructing synthetic event', {
        targetChannel: value.targetChannel,
        threadRootTs: postResult.ts,
      });

      // Simulate the user's original message in the new thread
      const syntheticEvent = {
        text: value.userMessage,
        user: userId,
        channel: value.targetChannel,
        ts: `synthetic_${Date.now()}`,
        thread_ts: postResult.ts,
        routeContext: {
          skipAutoBotThread: true,
          sourceChannel: value.originalChannel,
          sourceThreadTs: originalThreadTs,
        },
      };

      const syntheticSay = async (msg: any) => {
        return this.deps.slackApi.postMessage(
          value.targetChannel,
          msg.text,
          { threadTs: postResult.ts, blocks: msg.blocks }
        );
      };

      // Pre-mark bot-initiated thread
      this.deps.claudeHandler.setBotThread(value.targetChannel, postResult.ts, postResult.ts);

      logger.info('🔀 Processing synthetic message in target channel', {
        channel: value.targetChannel,
        threadTs: postResult.ts,
        syntheticTs: syntheticEvent.ts,
        skipAutoBotThread: true,
      });

      // Process the message in the new channel/thread
      await this.deps.messageHandler(syntheticEvent, syntheticSay);

      // Re-mark to ensure bot-initiated mode persists
      this.deps.claudeHandler.setBotThread(value.targetChannel, postResult.ts, postResult.ts);

      logger.info('🔀 handleMove COMPLETE — routed to correct channel', {
        from: value.originalChannel,
        to: value.targetChannel,
        targetChannelName: value.targetChannelName,
        user: userId,
        threadRootTs: postResult.ts,
      });
    } catch (error) {
      logger.error('🔀 handleMove FAILED', error);
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

      logger.info('🔀 handleStop — user declined channel route', {
        channel: value.originalChannel,
        targetChannel: value.targetChannel,
        targetChannelName: value.targetChannelName,
        user: body.user?.id,
        prUrl: value.prUrl,
      });

      const reasonText = value.targetChannelName
        ? `🛑 채널 이동하지 않음: 사용자 요청으로 현재 채널에서 계속 진행합니다. (권장 채널: #${value.targetChannelName})`
        : '🛑 채널 이동하지 않음: 사용자 요청으로 현재 채널에서 계속 진행합니다.';

      try {
        await respond({
          text: reasonText,
          replace_original: true,
        });
      } catch (error) {
        logger.warn('🔀 Failed to update advisory message, posting reason in thread', { error });
        const threadTs = value.originalThreadTs || body.message?.thread_ts || value.originalTs;
        if (threadTs) {
          await this.deps.slackApi.postMessage(value.originalChannel, reasonText, { threadTs });
        } else {
          await this.deps.slackApi.postMessage(value.originalChannel, reasonText);
        }
      }
    } catch (error) {
      logger.error('🔀 handleStop FAILED', error);
    }
  }

  private buildLinks(prUrl?: string): SessionLinks | undefined {
    if (!prUrl) return undefined;
    const provider: SessionLink['provider'] = prUrl.includes('github.com') ? 'github' : 'unknown';
    return {
      pr: {
        url: prUrl,
        type: 'pr',
        provider,
        label: 'PR',
      },
    };
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
  originalThreadTs: string;
  userMessage: string;
  userId: string;
}): { text: string; blocks: any[] } {
  logger.info('🔀 buildChannelRouteBlocks', {
    prUrl: params.prUrl,
    targetChannelId: params.targetChannelId,
    targetChannelName: params.targetChannelName,
    originalChannel: params.originalChannel,
    originalTs: params.originalTs,
    originalThreadTs: params.originalThreadTs,
    userId: params.userId,
    userMessagePreview: params.userMessage?.substring(0, 50),
  });

  const value: RouteActionValue = {
    targetChannel: params.targetChannelId,
    targetChannelName: params.targetChannelName,
    originalChannel: params.originalChannel,
    originalTs: params.originalTs,
    originalThreadTs: params.originalThreadTs,
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
