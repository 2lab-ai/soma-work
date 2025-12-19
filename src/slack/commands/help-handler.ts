import { CommandHandler, CommandContext, CommandResult } from './types';
import { CommandParser } from '../command-parser';

/**
 * Handles help command
 */
export class HelpHandler implements CommandHandler {
  canHandle(text: string): boolean {
    return CommandParser.isHelpCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { threadTs, say } = ctx;

    await say({
      text: CommandParser.getHelpMessage(),
      thread_ts: threadTs,
    });

    return { handled: true };
  }
}
