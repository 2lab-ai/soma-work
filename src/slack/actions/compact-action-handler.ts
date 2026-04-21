import type { ClaudeHandler } from '../../claude-handler';
import { Logger } from '../../logger';
import type { SlackApiHelper } from '../slack-api-helper';
import type { MessageHandler, RespondFn, SayFn } from './types';

interface CompactActionContext {
  slackApi: SlackApiHelper;
  claudeHandler: ClaudeHandler;
  messageHandler: MessageHandler;
}

/**
 * Handles the `/compact` confirmation buttons.
 *
 * The `/compact` slash command posts a yes/no Block Kit prompt (see
 * `CompactHandler.execute`). This handler services the two resulting buttons:
 *   • `compact_confirm` — replace the prompt with "🗜️ Triggering context
 *     compaction..." and re-dispatch the SDK trigger through the message
 *     pipeline as `/compact --yes` so the CompactHandler takes the confirmed
 *     branch and returns `{ continueWithPrompt: '/compact' }`.
 *   • `compact_cancel`  — replace the prompt with "취소되었습니다."
 *
 * Owner guard: only the session owner may confirm/cancel.
 */
export class CompactActionHandler {
  private logger = new Logger('CompactActionHandler');

  constructor(private ctx: CompactActionContext) {}

  async handleConfirm(body: any, respond: RespondFn): Promise<void> {
    try {
      const sessionKey = body.actions?.[0]?.value;
      const userId = body.user?.id;
      const channel = body.channel?.id;
      // `body.message.thread_ts` is the thread the prompt was posted in; `ts`
      // is the prompt message itself. For the message-pipeline re-dispatch we
      // need the thread root, falling back to the message ts when the prompt
      // was the thread root itself.
      const threadTs: string | undefined = body.message?.thread_ts || body.message?.ts;

      if (!sessionKey || !userId || !channel || !threadTs) {
        this.logger.warn('compact_confirm: missing payload fields', {
          hasSessionKey: !!sessionKey,
          hasUserId: !!userId,
          hasChannel: !!channel,
          hasThreadTs: !!threadTs,
        });
        await respond({
          response_type: 'ephemeral',
          text: '❌ 압축 확인 요청을 처리할 수 없습니다. 잠시 후 다시 시도해주세요.',
          replace_original: false,
        });
        return;
      }

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
          text: '❌ 세션 소유자만 압축을 진행할 수 있습니다.',
          replace_original: false,
        });
        return;
      }

      // Replace the prompt in-place — matches the close-confirm UX.
      await respond({
        text: '🗜️ 컨텍스트 압축을 시작합니다...',
        replace_original: true,
      });

      // Re-enter the pipeline with `/compact --yes`. CompandHandler.canHandle
      // now matches the `--yes` variant and parseCompactCommand reports
      // `{ confirmed: true }`, so the confirmed branch runs: announce +
      // `continueWithPrompt: '/compact'` → SDK performs compaction.
      const say: SayFn = async (args: any) => {
        const msgArgs = typeof args === 'string' ? { text: args } : args;
        return this.ctx.slackApi.postMessage(channel, msgArgs.text, {
          threadTs: msgArgs.thread_ts,
          blocks: msgArgs.blocks,
          attachments: msgArgs.attachments,
        });
      };
      await this.ctx.messageHandler(
        {
          user: userId,
          channel,
          thread_ts: threadTs,
          ts: body.message?.ts ?? '',
          text: '/compact --yes',
        },
        say,
      );
    } catch (error) {
      this.logger.error('Error processing compact confirm', error);
      try {
        await respond({
          response_type: 'ephemeral',
          text: '❌ 압축 진행 중 오류가 발생했습니다.',
          replace_original: false,
        });
      } catch (respondError) {
        this.logger.error('Failed to send error response for compact confirm', respondError);
      }
    }
  }

  async handleCancel(_body: any, respond: RespondFn): Promise<void> {
    try {
      await respond({
        text: '취소되었습니다.',
        replace_original: true,
      });
    } catch (error) {
      this.logger.warn('Failed to respond to compact cancel', error);
    }
  }
}
