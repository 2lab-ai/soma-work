import { CommandHandler, CommandContext, CommandResult, CommandDependencies } from './types';
import { CommandParser } from '../command-parser';

/**
 * Handles /renew command - save → reset → load workflow
 * Automates context renewal for long-running sessions
 */
export class RenewHandler implements CommandHandler {
  constructor(private deps: CommandDependencies) {}

  canHandle(text: string): boolean {
    return CommandParser.isRenewCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { channel, threadTs, say } = ctx;

    const sessionKey = this.deps.claudeHandler.getSessionKey(channel, threadTs);
    const session = this.deps.claudeHandler.getSession(channel, threadTs);

    // Check if there's an active session
    if (!session || !session.sessionId) {
      await say({
        text: '💡 No active session to renew. Start a conversation first!',
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    // Check if a request is in progress
    if (this.deps.requestCoordinator.isRequestActive(sessionKey)) {
      await say({
        text: '⚠️ Cannot renew while a request is in progress. Please wait for the current response to complete.',
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    // Check if already in renew process
    if (session.renewState) {
      await say({
        text: '⚠️ Renew is already in progress. Please wait for it to complete.',
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    // Set renew state and save current workflow
    session.renewState = 'pending_save';
    session.savedWorkflow = session.workflow;

    await say({
      text: '🔄 Starting renew process...\n• Saving current context\n• Will reset and reload automatically',
      thread_ts: threadTs,
    });

    // Return /save as the prompt to continue with
    return { handled: true, continueWithPrompt: '/save' };
  }
}
