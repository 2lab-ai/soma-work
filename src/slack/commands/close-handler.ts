import { CommandHandler, CommandContext, CommandResult, CommandDependencies } from './types';
import { CommandParser } from '../command-parser';

/**
 * Handles close command - close current thread's session with confirmation
 */
export class CloseHandler implements CommandHandler {
  constructor(private deps: CommandDependencies) {}

  canHandle(text: string): boolean {
    return CommandParser.isCloseCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, channel, threadTs, say } = ctx;

    // Check if there's an active session in this thread
    const session = this.deps.claudeHandler.getSession(channel, threadTs);
    if (!session) {
      await say({
        text: '📭 이 스레드에 활성 세션이 없습니다.',
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    // Only owner can close
    if (session.ownerId !== user) {
      await say({
        text: '❌ 세션 소유자만 세션을 종료할 수 있습니다.',
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    const sessionKey = this.deps.claudeHandler.getSessionKey(channel, threadTs);

    // Post confirmation message with buttons
    await say({
      text: '이 세션을 종료하시겠습니까?',
      thread_ts: threadTs,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `🔒 *세션 종료 확인*\n\n${session.title ? `*${session.title}*\n` : ''}이 세션을 종료하시겠습니까?`,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: '✅ 종료',
                emoji: true,
              },
              style: 'danger',
              value: sessionKey,
              action_id: 'close_session_confirm',
            },
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: '취소',
                emoji: true,
              },
              value: sessionKey,
              action_id: 'close_session_cancel',
            },
          ],
        },
      ],
    });

    return { handled: true };
  }
}
