import { CommandHandler, CommandContext, CommandResult, CommandDependencies } from './types';
import { CommandParser } from '../command-parser';
import { Logger } from '../../logger';
import fs from 'fs';
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
      const size = this.getDirSize(dir);
      totalBytes += size;
      const sizeStr = this.formatBytes(size);
      const dirName = path.basename(dir);
      lines.push(`  • \`${dirName}\` — ${sizeStr}`);
    }

    lines.push(`  *합계: ${this.formatBytes(totalBytes)}*\n`);
    return lines.join('\n');
  }

  /**
   * Get the total size of a directory in bytes (non-throwing).
   */
  private getDirSize(dirPath: string): number {
    try {
      if (!fs.existsSync(dirPath)) return 0;
      return this.calcDirSize(dirPath);
    } catch {
      return 0;
    }
  }

  private calcDirSize(dirPath: string): number {
    let total = 0;
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          total += this.calcDirSize(fullPath);
        } else if (entry.isFile()) {
          try {
            total += fs.statSync(fullPath).size;
          } catch { /* skip inaccessible files */ }
        }
      }
    } catch { /* skip inaccessible dirs */ }
    return total;
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / Math.pow(1024, i);
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
  }
}
