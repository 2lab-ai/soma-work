/**
 * ChannelRouteActionHandler — Handles channel routing actions
 * when a PR link is detected in the wrong channel.
 *
 * Actions:
 * - channel_route_move: Delete advisory message, create thread in correct channel
 * - channel_route_stop: Delete advisory message, stop processing
 */

import type { ClaudeHandler } from '../../claude-handler';
import { Logger } from '../../logger';
import type { SessionLink, SessionLinks } from '../../types';
import { userSettingsStore } from '../../user-settings-store';
import { MessageFormatter } from '../message-formatter';
import type { SlackApiHelper } from '../slack-api-helper';
import { ThreadHeaderBuilder } from '../thread-header-builder';

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
  advisoryTs?: string;
  userMessage: string;
  userId: string;
  prUrl?: string;
  advisoryEphemeral?: boolean;
  // Bot message ts posted to the original thread during init (dispatch status,
  // conversation-history link, etc.). Only these are deleted on Move/Stay.
  // Serialized into the Slack button value so cleanup works across restarts
  // and after the original session has been terminated. Never contains model replies.
  cleanupTs?: string[];
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
      if (!(await this.enforceOwner(value, body, respond))) {
        return;
      }
      const originalThreadTs = value.originalThreadTs || body.message?.thread_ts;
      const sessionThreadTs = originalThreadTs || value.originalTs;
      const isEphemeralAdvisory = value.advisoryEphemeral === true;

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

      const advisoryTs = value.advisoryTs;
      if (!isEphemeralAdvisory && advisoryTs) {
        // Delete the advisory message
        try {
          logger.debug('🔀 Deleting advisory message', { channel: value.originalChannel, ts: advisoryTs });
          await this.deps.slackApi.deleteMessage(value.originalChannel, advisoryTs);
        } catch (e) {
          logger.debug('🔀 Advisory message already gone', { error: (e as Error).message });
        }
      } else if (!isEphemeralAdvisory && !advisoryTs) {
        logger.warn('🔀 Advisory message ts missing; skip delete', { value });
      }

      if (!originalThreadTs) {
        logger.warn('🔀 Missing original thread ts', { value });
      } else {
        logger.debug('🔀 Deleting tracked init clutter in original thread', {
          channel: value.originalChannel,
          threadTs: originalThreadTs,
          cleanupTsCount: value.cleanupTs?.length ?? 0,
        });
        // Delete only the init clutter we tracked (dispatch status, conversation-history link).
        // Deleting all bot-authored messages here would also wipe prior model replies (#516).
        for (const cleanupTs of value.cleanupTs || []) {
          try {
            await this.deps.slackApi.deleteMessage(value.originalChannel, cleanupTs);
          } catch (error) {
            logger.debug('🔀 Failed to delete source-thread cleanup message', {
              channel: value.originalChannel,
              cleanupTs,
              error,
            });
          }
        }
      }

      // Terminate original ghost session
      if (sessionThreadTs) {
        const origKey = this.deps.claudeHandler.getSessionKey(value.originalChannel, sessionThreadTs);
        logger.info('🔀 Terminating original session', {
          origKey,
          channel: value.originalChannel,
          threadTs: sessionThreadTs,
        });
        this.deps.claudeHandler.terminateSession(origKey);
      }

      await this.routeToChannel(value, userId, value.targetChannel, value.targetChannelName, originalThreadTs);
    } catch (error) {
      logger.error('🔀 handleMove FAILED', error);
      try {
        await respond({ text: '⚠️ 채널 이동에 실패했습니다.', replace_original: true });
      } catch {}
    }
  }

  /**
   * Handle "Continue in current channel" button click
   */
  async handleStay(body: any, respond: any): Promise<void> {
    try {
      const action = body.actions?.[0];
      const rawValue = action?.value || '{}';
      const value: RouteActionValue = JSON.parse(rawValue);
      const userId = body.user?.id;
      if (!(await this.enforceOwner(value, body, respond))) {
        return;
      }
      const originalThreadTs = value.originalThreadTs || body.message?.thread_ts;
      const sessionThreadTs = originalThreadTs || value.originalTs;
      const isEphemeralAdvisory = value.advisoryEphemeral === true;

      logger.info('🔀 handleStay START', {
        userId,
        originalChannel: value.originalChannel,
        originalTs: value.originalTs,
        originalThreadTs,
        sessionThreadTs,
        prUrl: value.prUrl,
        userMessage: value.userMessage?.substring(0, 50),
      });

      if (!value.originalChannel || !userId) {
        logger.warn('🔀 handleStay: Invalid action value', { value, userId });
        return;
      }

      const advisoryTs = value.advisoryTs;
      if (!isEphemeralAdvisory && advisoryTs) {
        try {
          logger.debug('🔀 Deleting advisory message', { channel: value.originalChannel, ts: advisoryTs });
          await this.deps.slackApi.deleteMessage(value.originalChannel, advisoryTs);
        } catch (e) {
          logger.debug('🔀 Advisory message already gone', { error: (e as Error).message });
        }
      } else if (!isEphemeralAdvisory && !advisoryTs) {
        logger.warn('🔀 Advisory message ts missing; skip delete', { value });
      }

      if (!originalThreadTs) {
        logger.warn('🔀 Missing original thread ts', { value });
      } else {
        logger.debug('🔀 Deleting tracked init clutter in original thread', {
          channel: value.originalChannel,
          threadTs: originalThreadTs,
          cleanupTsCount: value.cleanupTs?.length ?? 0,
        });
        // Delete only the init clutter we tracked — see handleMove above (#516).
        for (const cleanupTs of value.cleanupTs || []) {
          try {
            await this.deps.slackApi.deleteMessage(value.originalChannel, cleanupTs);
          } catch (error) {
            logger.debug('🔀 Failed to delete source-thread cleanup message', {
              channel: value.originalChannel,
              cleanupTs,
              error,
            });
          }
        }
      }

      if (sessionThreadTs) {
        const origKey = this.deps.claudeHandler.getSessionKey(value.originalChannel, sessionThreadTs);
        logger.info('🔀 Terminating original session', {
          origKey,
          channel: value.originalChannel,
          threadTs: sessionThreadTs,
        });
        this.deps.claudeHandler.terminateSession(origKey);
      }

      await this.routeToChannel(value, userId, value.originalChannel, 'current', originalThreadTs);
    } catch (error) {
      logger.error('🔀 handleStay FAILED', error);
      try {
        await respond({ text: '⚠️ 현재 채널에서 진행하지 못했습니다.', replace_original: true });
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
      if (!(await this.enforceOwner(value, body, respond))) {
        return;
      }

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

  private async enforceOwner(value: RouteActionValue, body: any, respond: any): Promise<boolean> {
    const actorId = body.user?.id;
    if (!actorId || !value.userId || actorId !== value.userId) {
      try {
        await respond({
          text: '⚠️ 세션 오너만 이 버튼을 사용할 수 있습니다.',
          response_type: 'ephemeral',
          replace_original: false,
        });
      } catch (error) {
        logger.warn('🔀 Failed to respond to non-owner action', { error });
      }
      return false;
    }
    return true;
  }

  private buildLinks(prUrl?: string): SessionLinks | undefined {
    if (!prUrl) return undefined;
    const provider: SessionLink['provider'] = prUrl.includes('github.com') ? 'github' : 'unknown';
    // Extract PR number from URL (e.g., /pull/591 → "PR #591")
    const prMatch = prUrl.match(/\/pull\/(\d+)/);
    const label = prMatch ? `PR #${prMatch[1]}` : 'PR';
    return {
      pr: {
        url: prUrl,
        type: 'pr',
        provider,
        label,
      },
    };
  }

  private async routeToChannel(
    value: RouteActionValue,
    userId: string,
    targetChannel: string,
    targetChannelName: string,
    originalThreadTs?: string,
  ): Promise<void> {
    const threadRootText = value.prUrl ? `<@${userId}> 님의 작업 요청 — ${value.prUrl}` : `<@${userId}> 님의 작업 요청`;

    const ownerName = await this.deps.slackApi.getUserName(userId);
    const links = this.buildLinks(value.prUrl);
    // Generate title from user message, but fall back to PR label if it's just a URL placeholder
    const generated = MessageFormatter.generateSessionTitle(value.userMessage || threadRootText);
    const title = generated === '[link]' || generated === '새 대화' ? undefined : generated;
    const headerPayload = ThreadHeaderBuilder.build({
      title,
      workflow: 'default',
      ownerName,
      ownerId: userId,
      links,
      theme: userSettingsStore.getUserSessionTheme(userId),
    });

    logger.info('🔀 Creating thread in target channel', {
      targetChannel,
      targetChannelName,
      threadRootText: threadRootText.substring(0, 80),
    });

    const postResult = await this.deps.slackApi.postMessage(targetChannel, headerPayload.text, {
      attachments: headerPayload.attachments,
      blocks: headerPayload.blocks,
    });

    if (!postResult?.ts) {
      logger.error('🔀 Failed to create thread in target channel - no ts returned', {
        targetChannel,
        postResult,
      });
      return;
    }

    logger.info('🔀 Thread root created, constructing synthetic event', {
      targetChannel,
      threadRootTs: postResult.ts,
    });

    const syntheticEvent = {
      text: value.userMessage,
      user: userId,
      channel: targetChannel,
      ts: `synthetic_${Date.now()}`,
      thread_ts: postResult.ts,
      routeContext: {
        skipAutoBotThread: true,
        sourceChannel: value.originalChannel,
        sourceThreadTs: originalThreadTs,
      },
    };

    const syntheticSay = async (msg: any) => {
      return this.deps.slackApi.postMessage(targetChannel, msg.text, { threadTs: postResult.ts, blocks: msg.blocks });
    };

    this.deps.claudeHandler.setBotThread(targetChannel, postResult.ts, postResult.ts);

    logger.info('🔀 Processing synthetic message in target channel', {
      channel: targetChannel,
      threadTs: postResult.ts,
      syntheticTs: syntheticEvent.ts,
      skipAutoBotThread: true,
    });

    await this.deps.messageHandler(syntheticEvent, syntheticSay);

    this.deps.claudeHandler.setBotThread(targetChannel, postResult.ts, postResult.ts);

    logger.info('🔀 routeToChannel COMPLETE', {
      from: value.originalChannel,
      to: targetChannel,
      targetChannelName,
      user: userId,
      threadRootTs: postResult.ts,
    });
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
  advisoryTs?: string;
  userMessage: string;
  userId: string;
  advisoryEphemeral?: boolean;
  allowStay?: boolean;
  allowMove?: boolean;
  moveButtonText?: string;
  messageText?: string;
  sectionText?: string;
  /** Init-clutter ts to be deleted on Move/Stay. See RouteActionValue.cleanupTs. */
  cleanupTs?: string[];
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
    advisoryTs: params.advisoryTs,
    userMessage: params.userMessage,
    userId: params.userId,
    prUrl: params.prUrl,
    advisoryEphemeral: params.advisoryEphemeral,
    cleanupTs: params.cleanupTs,
  };
  const valueStr = JSON.stringify(value);

  const text = params.messageText || `이 repo는 #${params.targetChannelName} 채널의 작업입니다. 이동하시겠습니까?`;

  const showStay = params.allowStay === true;
  const showMove = params.allowMove !== false;
  const moveButtonText = params.moveButtonText || '이동';
  const sectionText =
    params.sectionText || `🔀 이 repo는 <#${params.targetChannelId}> 채널의 작업입니다.\n이동하시겠습니까?`;

  const actionElements: any[] = [];
  if (showMove) {
    actionElements.push({
      type: 'button',
      text: { type: 'plain_text', text: moveButtonText, emoji: true },
      style: 'primary',
      value: valueStr,
      action_id: 'channel_route_move',
    });
  }
  actionElements.push({
    type: 'button',
    text: { type: 'plain_text', text: '작업 중지', emoji: true },
    value: valueStr,
    action_id: 'channel_route_stop',
  });
  if (showStay) {
    actionElements.push({
      type: 'button',
      text: { type: 'plain_text', text: '현재 채널에서 진행', emoji: true },
      value: valueStr,
      action_id: 'channel_route_stay',
    });
  }

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: sectionText,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `👤 <@${params.userId}> 님만 버튼을 사용할 수 있습니다.`,
        },
      ],
    },
    {
      type: 'actions',
      elements: actionElements,
    },
  ];

  return { text, blocks };
}
