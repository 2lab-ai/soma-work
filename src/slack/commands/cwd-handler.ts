import { renderCwdCard } from '../z/topics/cwd-topic';
import type { CommandContext, CommandDependencies, CommandHandler, CommandResult } from './types';

/**
 * Handles working directory commands (cwd).
 *
 * Working directories are now fixed per user: {BASE_DIRECTORY}/{userId}/
 * - Users cannot set custom working directories (security isolation).
 * - Phase 2 (#507): `cwd` (get) renders a read-only Block Kit card via the
 *   /z cwd topic module. The legacy set-path branch still emits a plain
 *   system message explaining why it is disabled.
 */
export class CwdHandler implements CommandHandler {
  constructor(private deps: CommandDependencies) {}

  canHandle(text: string): boolean {
    return this.deps.workingDirManager.parseSetCommand(text) !== null || this.deps.workingDirManager.isGetCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, channel, threadTs, text } = ctx;

    // Check for set command - now disabled
    const setDirPath = this.deps.workingDirManager.parseSetCommand(text);
    if (setDirPath) {
      await this.deps.slackApi.postSystemMessage(
        channel,
        '⚠️ Working directory 설정은 비활성화되었습니다.\n' +
          '각 사용자는 고유한 디렉토리(`BASE_DIRECTORY/{userId}/`)를 자동으로 사용합니다.\n' +
          '`cwd` 명령으로 현재 디렉토리를 확인하세요.',
        { threadTs },
      );
      return { handled: true };
    }

    // Check for get command - render Block Kit card.
    if (this.deps.workingDirManager.isGetCommand(text)) {
      try {
        const { text: fallback, blocks } = await renderCwdCard({
          userId: user,
          issuedAt: Date.now(),
        });
        await this.deps.slackApi.postSystemMessage(channel, fallback ?? '📁 Working Directory', {
          threadTs,
          blocks,
        });
      } catch {
        // Fallback: original formatted text message.
        const directory = this.deps.workingDirManager.getWorkingDirectory(channel, threadTs, user);
        await this.deps.slackApi.postSystemMessage(
          channel,
          this.deps.workingDirManager.formatDirectoryMessage(directory, ''),
          { threadTs },
        );
      }
      return { handled: true };
    }

    return { handled: false };
  }
}
