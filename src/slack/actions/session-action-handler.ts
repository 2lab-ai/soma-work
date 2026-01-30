import { SlackApiHelper } from '../slack-api-helper';
import { SessionUiManager } from '../session-manager';
import { ClaudeHandler } from '../../claude-handler';
import { Logger } from '../../logger';
import { RespondFn } from './types';

interface SessionActionContext {
  slackApi: SlackApiHelper;
  claudeHandler: ClaudeHandler;
  sessionManager: SessionUiManager;
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
    await respond({
      text: '취소되었습니다.',
      replace_original: true,
    });
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
    }
  }

  /**
   * Handle idle keep session button (from 12h idle check)
   * Refreshes the session's lastActivity to prevent auto-close
   */
  async handleIdleKeep(body: any, respond: RespondFn): Promise<void> {
    try {
      const sessionKey = body.actions[0].value;
      const session = this.ctx.claudeHandler.getSessionByKey(sessionKey);

      if (!session) {
        await respond({
          text: '세션이 이미 종료되었습니다.',
          replace_original: true,
        });
        return;
      }

      // Refresh activity timestamp
      session.lastActivity = new Date();
      // Clear warning state so it can warn again later
      session.lastWarningSentAt = undefined;
      session.warningMessageTs = undefined;

      await respond({
        text: '🔄 세션이 유지됩니다. 타이머가 리셋되었습니다.',
        replace_original: true,
      });
    } catch (error) {
      this.logger.error('Error processing idle keep', error);
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
}
