import { CommandHandler, CommandContext, CommandResult, CommandDependencies } from './types';
import { CommandParser } from '../command-parser';
import { Logger } from '../../logger';
import { getDirSizeBytes, formatBytes } from '../../utils/dir-size';
import path from 'path';

/**
 * Handles close command - close current thread's session with confirmation.
 * Shows summary of source working directories that will be deleted.
 */
export class CloseHandler implements CommandHandler {
  private logger = new Logger('CloseHandler');

  constructor(private deps: CommandDependencies) {}

  canHandle(text: string): boolean {
    return CommandParser.isCloseCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, channel, threadTs, say } = ctx;

    try {
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

      // Build cleanup summary for source working dirs
      const cleanupSummary = this.buildCleanupSummary(session.sourceWorkingDirs);

      const confirmText = [
        `🔒 *세션 종료 확인*\n`,
        session.title ? `*${session.title}*\n` : '',
        cleanupSummary,
        '이 세션을 종료하시겠습니까?',
      ].filter(Boolean).join('\n');

      // Post confirmation message with buttons
      await say({
        text: '이 세션을 종료하시겠습니까?',
        thread_ts: threadTs,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: confirmText,
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
    } catch (error) {
      this.logger.error('Close command failed', error);
      await ctx.say({
        text: '❌ 세션 종료 처리 중 오류가 발생했습니다.',
        thread_ts: ctx.threadTs,
      });
      return { handled: true };
    }
  }

  /**
   * Build a human-readable summary of directories to be deleted on session close.
   * Returns empty string if no dirs are tracked.
   */
  private buildCleanupSummary(dirs?: string[]): string {
    if (!dirs?.length) return '';

    const lines: string[] = ['🗑️ *삭제 예정 디렉토리:*'];
    let totalBytes = 0;

    for (const dir of dirs) {
      const size = getDirSizeBytes(dir);
      totalBytes += size;
      const dirName = path.basename(dir);
      lines.push(`  • \`${dirName}\` — ${formatBytes(size)}`);
    }

    lines.push(`  *합계: ${formatBytes(totalBytes)}*\n`);
    return lines.join('\n');
  }
}
