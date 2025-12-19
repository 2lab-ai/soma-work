import { CommandHandler, CommandContext, CommandResult, CommandDependencies } from './types';

/**
 * Handles working directory commands (cwd set/get)
 */
export class CwdHandler implements CommandHandler {
  constructor(private deps: CommandDependencies) {}

  canHandle(text: string): boolean {
    return this.deps.workingDirManager.parseSetCommand(text) !== null ||
           this.deps.workingDirManager.isGetCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, channel, threadTs, text, say } = ctx;
    const isDM = channel.startsWith('D');

    // Check for set command
    const setDirPath = this.deps.workingDirManager.parseSetCommand(text);
    if (setDirPath) {
      const result = this.deps.workingDirManager.setWorkingDirectory(
        channel,
        setDirPath,
        threadTs !== ctx.threadTs ? threadTs : undefined, // Only pass if it's a real thread
        user
      );

      if (result.success) {
        const context = threadTs ? 'this thread' : (isDM ? 'this conversation' : 'this channel');
        await say({
          text: `✅ Working directory set for ${context}: \`${result.resolvedPath}\`\n_This will be your default for future conversations._`,
          thread_ts: threadTs,
        });
      } else {
        await say({
          text: `❌ ${result.error}`,
          thread_ts: threadTs,
        });
      }
      return { handled: true };
    }

    // Check for get command
    if (this.deps.workingDirManager.isGetCommand(text)) {
      const directory = this.deps.workingDirManager.getWorkingDirectory(
        channel,
        threadTs !== ctx.threadTs ? threadTs : undefined,
        user
      );
      const context = threadTs ? 'this thread' : (isDM ? 'this conversation' : 'this channel');

      await say({
        text: this.deps.workingDirManager.formatDirectoryMessage(directory, context),
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    return { handled: false };
  }
}
