import { CommandHandler, CommandContext, CommandResult, CommandDependencies } from './types';

/**
 * Handles working directory commands (cwd)
 *
 * Working directories are now fixed per user: {BASE_DIRECTORY}/{userId}/
 * - Users cannot set custom working directories
 * - The cwd command only shows the current fixed directory
 */
export class CwdHandler implements CommandHandler {
  constructor(private deps: CommandDependencies) {}

  canHandle(text: string): boolean {
    return this.deps.workingDirManager.parseSetCommand(text) !== null ||
           this.deps.workingDirManager.isGetCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, channel, threadTs, text, say } = ctx;

    // Check for set command - now disabled
    const setDirPath = this.deps.workingDirManager.parseSetCommand(text);
    if (setDirPath) {
      await say({
        text: '⚠️ Working directory 설정은 비활성화되었습니다.\n' +
              '각 사용자는 고유한 디렉토리(`BASE_DIRECTORY/{userId}/`)를 자동으로 사용합니다.\n' +
              '`cwd` 명령으로 현재 디렉토리를 확인하세요.',
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    // Check for get command - show fixed directory
    if (this.deps.workingDirManager.isGetCommand(text)) {
      const directory = this.deps.workingDirManager.getWorkingDirectory(
        channel,
        threadTs,
        user
      );

      await say({
        text: this.deps.workingDirManager.formatDirectoryMessage(directory, ''),
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    return { handled: false };
  }
}
