import { SlackApiHelper } from '../slack-api-helper';
import { ClaudeHandler } from '../../claude-handler';
import { Logger } from '../../logger';
import { MessageHandler, SayFn, RespondFn } from './types';

interface PRActionContext {
  slackApi: SlackApiHelper;
  claudeHandler: ClaudeHandler;
  messageHandler: MessageHandler;
}

/**
 * PR merge action handler.
 * Delegates merge execution to the session AI via message injection.
 */
export class PRActionHandler {
  private logger = new Logger('PRActionHandler');

  constructor(private ctx: PRActionContext) {}

  async handleMerge(body: any, respond: RespondFn): Promise<void> {
    try {
      const action = body.actions[0];
      const valueData = JSON.parse(action.value);
      const { sessionKey, prUrl, prLabel, headBranch, baseBranch } = valueData;
      const userId = body.user?.id;
      const channel = body.channel?.id;

      this.logger.info('PR merge requested', { sessionKey, prUrl, prLabel, userId });

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
          text: '❌ 세션 소유자만 이 작업을 수행할 수 있습니다.',
          replace_original: false,
        });
        return;
      }

      const threadTs = session.threadTs;
      if (!threadTs) {
        await respond({
          response_type: 'ephemeral',
          text: '❌ 세션의 스레드를 찾을 수 없습니다.',
          replace_original: false,
        });
        return;
      }

      // Acknowledge to user
      await respond({
        response_type: 'ephemeral',
        text: `🔀 ${prLabel} 머지 요청을 전달합니다...`,
        replace_original: false,
      });

      // Inject message into session thread for AI to execute
      const injectedText = `PR을 머지해주세요.\nURL: ${prUrl}\nSource: ${headBranch} → Target: ${baseBranch}\nsquash merge로 진행하고, 머지 후 소스 브랜치를 삭제해주세요.`;
      this.ctx.claudeHandler.setActivityStateByKey(sessionKey, 'working');
      const say = this.createSayFn(session.channelId);
      await this.ctx.messageHandler(
        { user: userId, channel: session.channelId, thread_ts: threadTs, ts: '', text: injectedText },
        say
      );
    } catch (error) {
      this.logger.error('Error processing PR merge', error);
      try {
        await respond({
          response_type: 'ephemeral',
          text: '❌ PR 머지 처리 중 오류가 발생했습니다.',
          replace_original: false,
        });
      } catch (respondError) {
        this.logger.error('Failed to send error response', respondError);
      }
    }
  }

  private createSayFn(channel: string): SayFn {
    return async (args: any) => {
      const msgArgs = typeof args === 'string' ? { text: args } : args;
      return this.ctx.slackApi.postMessage(channel, msgArgs.text, {
        threadTs: msgArgs.thread_ts,
        blocks: msgArgs.blocks,
        attachments: msgArgs.attachments,
      });
    };
  }
}
