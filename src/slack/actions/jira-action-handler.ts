import { SlackApiHelper } from '../slack-api-helper';
import { ClaudeHandler } from '../../claude-handler';
import { Logger } from '../../logger';
import { MessageHandler, SayFn, RespondFn } from './types';

interface JiraActionContext {
  slackApi: SlackApiHelper;
  claudeHandler: ClaudeHandler;
  messageHandler: MessageHandler;
}

/**
 * Jira issue transition action handler.
 * Delegates transition execution to the session AI via message injection.
 */
export class JiraActionHandler {
  private logger = new Logger('JiraActionHandler');

  constructor(private ctx: JiraActionContext) {}

  async handleTransition(body: any, respond: RespondFn): Promise<void> {
    try {
      const action = body.actions[0];
      const valueData = JSON.parse(action.value);
      const { sessionKey, issueKey, transitionId, transitionName } = valueData;
      const userId = body.user?.id;
      const channel = body.channel?.id;

      this.logger.info('Jira transition requested', { sessionKey, issueKey, transitionId, transitionName, userId });

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
        text: `🔄 Jira 이슈 ${issueKey} 상태를 "${transitionName}"으로 변경 요청을 전달합니다...`,
        replace_original: false,
      });

      // Inject message into session thread for AI to execute
      const injectedText = `Jira 이슈 ${issueKey} 상태를 "${transitionName}"(으)로 변경해주세요.`;
      this.ctx.claudeHandler.setActivityStateByKey(sessionKey, 'working');
      const say = this.createSayFn(session.channelId);
      await this.ctx.messageHandler(
        { user: userId, channel: session.channelId, thread_ts: threadTs, ts: '', text: injectedText },
        say
      );
    } catch (error) {
      this.logger.error('Error processing Jira transition', error);
      try {
        await respond({
          response_type: 'ephemeral',
          text: '❌ Jira 상태 전환 처리 중 오류가 발생했습니다.',
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
