import { CommandParser } from '../command-parser';
import type { CommandContext, CommandDependencies, CommandHandler, CommandResult } from './types';

/**
 * Handles /compact command - triggers forced context compaction via SDK.
 * Sends the literal '/compact' as a prompt to the Claude SDK,
 * which recognizes it as a built-in command and performs server-side compaction.
 */
export class CompactHandler implements CommandHandler {
  constructor(private deps: CommandDependencies) {}

  canHandle(text: string): boolean {
    return CommandParser.isCompactCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { channel, threadTs } = ctx;

    const sessionKey = this.deps.claudeHandler.getSessionKey(channel, threadTs);
    const session = this.deps.claudeHandler.getSession(channel, threadTs);

    if (!session?.sessionId) {
      await this.deps.slackApi.postSystemMessage(channel, '💡 No active session. Start a conversation first.', {
        threadTs,
      });
      return { handled: true };
    }

    if (this.deps.requestCoordinator.isRequestActive(sessionKey)) {
      await this.deps.slackApi.postSystemMessage(
        channel,
        '⚠️ Cannot compact while a request is in progress. Please wait.',
        { threadTs },
      );
      return { handled: true };
    }

    await this.deps.slackApi.postSystemMessage(channel, '🗜️ Triggering context compaction...', { threadTs });

    // Dashboard v2.1 — compactionCount is incremented on the SDK's
    // onCompactBoundary callback inside stream-executor, not here.
    // /compact delegates compaction to the SDK via continueWithPrompt, so
    // the success signal is the callback — bumping twice would double-count.

    return { handled: true, continueWithPrompt: '/compact' };
  }
}
