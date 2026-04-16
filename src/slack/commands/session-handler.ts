import { Logger } from '../../logger';
import { userSettingsStore } from '../../user-settings-store';
import { CommandParser } from '../command-parser';
import { applyTheme, renderThemeCard } from '../z/topics/theme-topic';
import type { CommandContext, CommandDependencies, CommandHandler, CommandResult } from './types';

/**
 * Handles session commands (sessions/all_sessions/terminate)
 */
export class SessionHandler implements CommandHandler {
  private logger = new Logger('SessionHandler');

  constructor(private deps: CommandDependencies) {}

  canHandle(text: string): boolean {
    return (
      CommandParser.isSessionsCommand(text) ||
      CommandParser.isAllSessionsCommand(text) ||
      CommandParser.parseTerminateCommand(text) !== null
    );
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, channel, text, threadTs, say } = ctx;

    // Session theme command (e.g., "sessions theme=A", "theme", "theme set B")
    //
    // Phase 2 (#507): bare `theme` renders Block Kit via /z topic module.
    // Explicit `theme set <v>` retains text ack for CLI back-compat.
    if (CommandParser.isSessionThemeCommand(text)) {
      const parsed = CommandParser.parseSessionThemeCommand(text);
      if (parsed && parsed.theme === null) {
        const { text: fallback, blocks } = await renderThemeCard({
          userId: user,
          issuedAt: Date.now(),
        });
        await say({ text: fallback ?? '🎨 Theme', blocks, thread_ts: threadTs });
        return { handled: true };
      }
      if (parsed && parsed.theme !== null) {
        const result = await applyTheme({ userId: user, value: parsed.theme });
        if (result.ok) {
          await say({
            text: `✅ ${result.summary}${result.description ? `\n\n${result.description}` : ''}`,
            thread_ts: threadTs,
          });
        } else {
          await say({
            text: `${result.summary}${result.description ? `\n\n${result.description}` : ''}`,
            thread_ts: threadTs,
          });
        }
      }
      return { handled: true };
    }

    // Sessions command (user's sessions)
    if (CommandParser.isSessionsCommand(text)) {
      const { isPublic } = CommandParser.parseSessionsCommand(text);
      const isDm = channel.startsWith('D');

      const { text: msgText, blocks } = await this.deps.sessionUiManager.formatUserSessionsBlocks(user, {
        showControls: !isPublic,
      });

      if (isPublic || isDm) {
        // Public: channel-visible by design; DM: ephemeral unreliable, use say() directly
        await say({
          text: msgText,
          blocks,
          thread_ts: threadTs,
        });
      } else {
        // Channel: ephemeral (user-only) with fallback
        try {
          await this.deps.slackApi.postEphemeral(channel, user, msgText, threadTs, blocks);
        } catch (error) {
          this.logger.warn('postEphemeral failed, falling back to regular message', error);
          await say({
            text: msgText,
            blocks,
            thread_ts: threadTs,
          });
        }
      }
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
