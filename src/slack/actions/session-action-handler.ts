import { SlackApiHelper } from '../slack-api-helper';
import { SessionUiManager } from '../session-manager';
import { ReactionManager } from '../reaction-manager';
import { RequestCoordinator } from '../request-coordinator';
import { ThreadHeaderBuilder } from '../thread-header-builder';
import { ActionPanelBuilder } from '../action-panel-builder';
import { ClaudeHandler } from '../../claude-handler';
import { ConversationSession } from '../../types';
import { Logger } from '../../logger';
import { RespondFn } from './types';

interface SessionActionContext {
  slackApi: SlackApiHelper;
  claudeHandler: ClaudeHandler;
  sessionManager: SessionUiManager;
  reactionManager?: ReactionManager;
  requestCoordinator?: RequestCoordinator;
}

/**
 * 세션 종료 및 유휴 관련 액션 핸들러
 */
export class SessionActionHandler {
  private logger = new Logger('SessionActionHandler');

  constructor(private ctx: SessionActionContext) {}

  /**
   * Handle close session confirm button (from /close command)
   */
  async handleCloseConfirm(body: any, respond: RespondFn): Promise<void> {
    try {
      const sessionKey = body.actions[0].value;
      const userId = body.user?.id;

      const session = this.ctx.claudeHandler.getSessionByKey(sessionKey);
      if (!session) {
        await respond({
          response_type: 'ephemeral',
          text: '❌ 세션을 찾을 수 없습니다. 이미 종료되었을 수 있습니다.',
          replace_original: false,
        });
        return;
      }

      if (session.ownerId !== userId) {
        await respond({
          response_type: 'ephemeral',
          text: '❌ 세션 소유자만 종료할 수 있습니다.',
          replace_original: false,
        });
        return;
      }

      // Add zzz emoji before termination (while session still has data)
      if (session.threadTs) {
        await this.ctx.reactionManager?.setSessionExpired(sessionKey, session.channelId, session.threadTs);
      }

      // Update UI to closed state before terminating
      await this.updateSessionUiAsClosed(session);

      // Abort active AI request before deleting session
      this.ctx.requestCoordinator?.abortSession(sessionKey);

      const success = this.ctx.claudeHandler.terminateSession(sessionKey);
      if (success) {
        await respond({
          text: '✅ 세션이 종료되었습니다.',
          replace_original: true,
        });
      } else {
        await respond({
          response_type: 'ephemeral',
          text: '❌ 세션 종료에 실패했습니다.',
          replace_original: false,
        });
      }
    } catch (error) {
      this.logger.error('Error processing close confirm', error);
      await respond({
        response_type: 'ephemeral',
        text: '❌ 세션 종료 중 오류가 발생했습니다.',
        replace_original: false,
      });
    }
  }

  /**
   * Handle close session cancel button
   */
  async handleCloseCancel(_body: any, respond: RespondFn): Promise<void> {
    try {
      await respond({
        text: '취소되었습니다.',
        replace_original: true,
      });
    } catch (error) {
      this.logger.warn('Failed to respond to close cancel', error);
    }
  }

  /**
   * Handle idle close session button (from 12h idle check)
   */
  async handleIdleClose(body: any, respond: RespondFn): Promise<void> {
    try {
      const sessionKey = body.actions[0].value;
      const userId = body.user?.id;

      const session = this.ctx.claudeHandler.getSessionByKey(sessionKey);
      if (!session) {
        await respond({
          text: '✅ 세션이 이미 종료되었습니다.',
          replace_original: true,
        });
        return;
      }

      if (session.ownerId !== userId) {
        await respond({
          response_type: 'ephemeral',
          text: '❌ 세션 소유자만 종료할 수 있습니다.',
          replace_original: false,
        });
        return;
      }

      // Add zzz emoji before termination
      if (session.threadTs) {
        await this.ctx.reactionManager?.setSessionExpired(sessionKey, session.channelId, session.threadTs);
      }

      // Update UI to closed state before terminating
      await this.updateSessionUiAsClosed(session);

      // Abort active AI request before deleting session
      this.ctx.requestCoordinator?.abortSession(sessionKey);

      const success = this.ctx.claudeHandler.terminateSession(sessionKey);
      if (success) {
        await respond({
          text: '✅ 세션이 종료되었습니다.',
          replace_original: true,
        });
      } else {
        await respond({
          response_type: 'ephemeral',
          text: '❌ 세션 종료에 실패했습니다.',
          replace_original: false,
        });
      }
    } catch (error) {
      this.logger.error('Error processing idle close', error);
      try {
        await respond({
          response_type: 'ephemeral',
          text: '❌ 세션 종료 중 오류가 발생했습니다. 다시 시도해주세요.',
          replace_original: false,
        });
      } catch (respondError) {
        this.logger.error('Failed to send error response for idle close', respondError);
      }
    }
  }

  /**
   * Handle idle keep session button (from 12h idle check)
   * Refreshes the session's lastActivity to prevent auto-close
   */
  async handleIdleKeep(body: any, respond: RespondFn): Promise<void> {
    try {
      const sessionKey = body.actions[0].value;

      // Clear lifecycle emojis (idle moon)
      const session = this.ctx.claudeHandler.getSessionByKey(sessionKey);
      if (session?.threadTs) {
        await this.ctx.reactionManager?.clearSessionLifecycleEmojis(session.channelId, session.threadTs);
      }

      const refreshed = this.ctx.claudeHandler.refreshSessionActivityByKey(sessionKey);
      if (!refreshed) {
        await respond({
          text: '세션이 이미 종료되었습니다.',
          replace_original: true,
        });
        return;
      }

      await respond({
        text: '🔄 세션이 유지됩니다. 타이머가 리셋되었습니다.',
        replace_original: true,
      });
    } catch (error) {
      this.logger.error('Error processing idle keep', error);
      try {
        await respond({
          response_type: 'ephemeral',
          text: '❌ 세션 유지 처리 중 오류가 발생했습니다. 스레드에 메시지를 보내 활동을 갱신해주세요.',
          replace_original: false,
        });
      } catch (respondError) {
        this.logger.error('Failed to send error response for idle keep', respondError);
      }
    }
  }

  /**
   * Handle refresh sessions button
   */
  async handleRefreshSessions(body: any, respond: RespondFn): Promise<void> {
    try {
      const userId = body.user?.id;
      if (!userId) return;

      const { text, blocks } = await this.ctx.sessionManager.formatUserSessionsBlocks(userId, { showControls: true });
      await respond({
        text,
        blocks,
        replace_original: true,
      });
    } catch (error) {
      this.logger.error('Error refreshing sessions', error);
    }
  }

  async handleTerminateSession(body: any, respond: RespondFn): Promise<void> {
    try {
      const sessionKey = body.actions[0].value;
      const userId = body.user?.id;
      const channel = body.channel?.id;

      this.logger.info('Session termination requested', { sessionKey, userId });

      const session = this.ctx.claudeHandler.getSessionByKey(sessionKey);

      if (!session) {
        await respond({
          response_type: 'ephemeral',
          text: '❌ 세션을 찾을 수 없습니다. 이미 종료되었을 수 있습니다.',
          replace_original: false,
        });
        return;
      }

      if (session.ownerId !== userId) {
        await respond({
          response_type: 'ephemeral',
          text: '❌ 이 세션을 종료할 권한이 없습니다. 세션 소유자만 종료할 수 있습니다.',
          replace_original: false,
        });
        return;
      }

      // Add zzz emoji before termination
      if (session.threadTs) {
        await this.ctx.reactionManager?.setSessionExpired(sessionKey, session.channelId, session.threadTs);
      }

      // Update UI to closed state before terminating
      await this.updateSessionUiAsClosed(session);

      // Abort active AI request before deleting session
      this.ctx.requestCoordinator?.abortSession(sessionKey);

      const channelName = await this.ctx.slackApi.getChannelName(session.channelId);
      const success = this.ctx.claudeHandler.terminateSession(sessionKey);

      if (success) {
        const { text: newText, blocks: newBlocks } = await this.ctx.sessionManager.formatUserSessionsBlocks(userId);
        await respond({
          text: newText,
          blocks: newBlocks,
          replace_original: true,
        });

        await this.ctx.slackApi.postEphemeral(
          channel,
          userId,
          `✅ 세션이 종료되었습니다: *${session.title || channelName}*`
        );

        if (session.threadTs) {
          try {
            await this.ctx.slackApi.postMessage(
              session.channelId,
              `🔒 *세션이 종료되었습니다*\n\n<@${userId}>에 의해 세션이 종료되었습니다. 새로운 대화를 시작하려면 다시 메시지를 보내주세요.`,
              { threadTs: session.threadTs }
            );
          } catch (error) {
            this.logger.warn('Failed to notify original thread about session termination', error);
          }
        }
      } else {
        await respond({
          response_type: 'ephemeral',
          text: '❌ 세션 종료에 실패했습니다.',
          replace_original: false,
        });
      }
    } catch (error) {
      this.logger.error('Error processing session termination', error);
      await respond({
        response_type: 'ephemeral',
        text: '❌ 세션 종료 중 오류가 발생했습니다.',
        replace_original: false,
      });
    }
  }

  /**
   * Update thread header and action panel to show closed state.
   * Errors are logged but do not block session termination.
   */
  private async updateSessionUiAsClosed(session: ConversationSession): Promise<void> {
    const channelId = session.channelId;

    // Update thread header (bot-initiated threads only)
    if (session.threadRootTs) {
      try {
        const headerPayload = ThreadHeaderBuilder.fromSession(session, { closed: true });
        await this.ctx.slackApi.updateMessage(
          channelId,
          session.threadRootTs,
          headerPayload.text,
          headerPayload.blocks
        );
      } catch (error) {
        this.logger.warn('Failed to update thread header as closed', { error });
      }
    }

    // Update action panel
    if (session.actionPanel?.messageTs) {
      try {
        const panelPayload = ActionPanelBuilder.build({
          sessionKey: '',
          workflow: session.workflow,
          closed: true,
          contextRemainingPercent: this.getContextRemainingPercent(session),
        });
        await this.ctx.slackApi.updateMessage(
          channelId,
          session.actionPanel.messageTs,
          panelPayload.text,
          panelPayload.blocks
        );
      } catch (error) {
        this.logger.warn('Failed to update action panel as closed', { error });
      }
    }
  }

  private getContextRemainingPercent(session: ConversationSession): number | undefined {
    const usage = session.usage;
    if (!usage || usage.contextWindow <= 0) return undefined;
    const usedTokens = usage.currentInputTokens + usage.currentOutputTokens;
    const remainingPercent = ((usage.contextWindow - usedTokens) / usage.contextWindow) * 100;
    return Math.max(0, Math.min(100, Number(remainingPercent.toFixed(1))));
  }
}
