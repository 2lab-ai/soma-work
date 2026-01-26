import { CommandHandler, CommandContext, CommandResult, CommandDependencies } from './types';
import { CommandParser } from '../command-parser';

/**
 * Handles session commands (sessions/all_sessions/terminate)
 */
export class SessionHandler implements CommandHandler {
  constructor(private deps: CommandDependencies) {}

  canHandle(text: string): boolean {
    return CommandParser.isSessionsCommand(text) ||
           CommandParser.isAllSessionsCommand(text) ||
           CommandParser.parseTerminateCommand(text) !== null;
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, channel, text, threadTs, say } = ctx;

    // Sessions command (user's sessions)
    if (CommandParser.isSessionsCommand(text)) {
      const { text: msgText, blocks } = await this.deps.sessionUiManager.formatUserSessionsBlocks(user);
      await say({
        text: msgText,
        blocks,
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    // All sessions command
    if (CommandParser.isAllSessionsCommand(text)) {
      await say({
        text: await this.deps.sessionUiManager.formatAllSessions(),
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    // Terminate command
    const terminateMatch = CommandParser.parseTerminateCommand(text);
    if (terminateMatch) {
      await this.deps.sessionUiManager.handleTerminateCommand(terminateMatch, user, channel, threadTs, say);
      return { handled: true };
    }

    return { handled: false };
  }
}
