import { addMemory, clearAllMemory, formatMemoryForDisplay, removeMemoryByIndex } from '../../user-memory-store';
import { CommandParser } from '../command-parser';
import type { CommandContext, CommandHandler, CommandResult } from './types';

/**
 * Handles memory commands (show/clear)
 */
export class MemoryHandler implements CommandHandler {
  canHandle(text: string): boolean {
    return CommandParser.isMemoryCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, text, threadTs, say } = ctx;
    const action = CommandParser.parseMemoryCommand(text);

    if (action.action === 'show') {
      const display = formatMemoryForDisplay(user);
      await say({ text: display, thread_ts: threadTs });
    } else if (action.action === 'save') {
      const result = addMemory(user, action.target, action.content);
      if (result.ok) {
        await say({ text: `✅ Saved to ${action.target}: "${action.content}"`, thread_ts: threadTs });
      } else {
        await say({ text: `❌ ${result.message}`, thread_ts: threadTs });
      }
    } else if (action.action === 'clear') {
      if (action.index !== undefined) {
        // Clear specific entry by number
        // Try memory first, then user
        const memResult = removeMemoryByIndex(user, 'memory', action.index);
        if (memResult.ok) {
          await say({ text: `✅ Memory entry #${action.index} removed.`, thread_ts: threadTs });
        } else {
          // Try user profile
          const usrResult = removeMemoryByIndex(user, 'user', action.index);
          if (usrResult.ok) {
            await say({ text: `✅ User profile entry #${action.index} removed.`, thread_ts: threadTs });
          } else {
            await say({ text: `❌ ${memResult.message}`, thread_ts: threadTs });
          }
        }
      } else {
        // Clear all
        clearAllMemory(user);
        await say({ text: '🗑️ All memory and user profile entries cleared.', thread_ts: threadTs });
      }
    }

    return { handled: true };
  }
}
