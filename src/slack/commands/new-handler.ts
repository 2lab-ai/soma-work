import { CommandHandler, CommandContext, CommandResult, CommandDependencies } from './types';
import { CommandParser } from '../command-parser';

/**
 * Handles /new command - resets session context while preserving metadata
 * Allows starting a fresh conversation in the same thread
 */
export class NewHandler implements CommandHandler {
  constructor(private deps: CommandDependencies) {}

  canHandle(text: string): boolean {
    return CommandParser.isNewCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { channel, text, threadTs, say } = ctx;

    const { prompt } = CommandParser.parseNewCommand(text);

    // Check if there's an active request in progress (P1 race condition fix)
    const sessionKey = this.deps.claudeHandler.getSessionKey(channel, threadTs);
    if (this.deps.requestCoordinator.isRequestActive(sessionKey)) {
      await say({
        text: '⚠️ Cannot reset session while a request is in progress. Please wait for the current response to complete or cancel it first.',
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    // Reset session context
    const wasReset = this.deps.claudeHandler.resetSessionContext(channel, threadTs);

    if (wasReset) {
      // Session existed and was reset (state → INITIALIZING, dispatch will re-run)
      if (prompt) {
        // Has follow-up prompt - send brief confirmation and continue with prompt
        await say({
          text: '🔄 Session reset. Re-dispatching workflow...',
          thread_ts: threadTs,
        });
        return { handled: true, continueWithPrompt: prompt };
      } else {
        // No follow-up prompt - just confirmation
        await say({
          text: '🔄 Session reset. Workflow will be re-dispatched on next message.',
          thread_ts: threadTs,
        });
        return { handled: true };
      }
    } else {
      // No existing session - create info message
      if (prompt) {
        // No session to reset, but has prompt - just process it as new conversation
        await say({
          text: '💡 Starting new conversation...',
          thread_ts: threadTs,
        });
        return { handled: true, continueWithPrompt: prompt };
      } else {
        // No session and no prompt
        await say({
          text: '💡 No existing session in this thread. Just start typing to begin a new conversation!',
          thread_ts: threadTs,
        });
        return { handled: true };
      }
    }
  }
}
