import { CommandHandler, CommandContext, CommandResult, CommandDependencies } from './types';
import { CommandParser } from '../command-parser';
import { Logger } from '../../logger';
import { userSettingsStore, THEME_NAMES, type SessionTheme } from '../../user-settings-store';

/**
 * Handles session commands (sessions/all_sessions/terminate)
 */
export class SessionHandler implements CommandHandler {
  private logger = new Logger('SessionHandler');

  constructor(private deps: CommandDependencies) {}

  canHandle(text: string): boolean {
    return CommandParser.isSessionsCommand(text) ||
           CommandParser.isAllSessionsCommand(text) ||
           CommandParser.parseTerminateCommand(text) !== null;
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, channel, text, threadTs, say } = ctx;

    // Session theme command (e.g., "session theme=A")
    if (CommandParser.isSessionThemeCommand(text)) {
      const parsed = CommandParser.parseSessionThemeCommand(text);
      if (parsed) {
        const resolved = userSettingsStore.resolveThemeInput(parsed.theme);
        if (resolved === null) {
          const validThemes = Object.entries(THEME_NAMES)
            .map(([k, v]) => `\`${k}\` (${v})`)
            .join(', ');
          await say({
            text: `❌ 알 수 없는 테마: \`${parsed.theme}\`\n사용 가능: ${validThemes}, \`rotate\` (자동 순환)`,
            thread_ts: threadTs,
          });
        } else if (resolved === 'rotate') {
          userSettingsStore.setUserSessionTheme(user, undefined);
          await say({
            text: `🎨 세션 테마가 *자동 순환* 모드로 설정되었습니다. 매번 다른 테마가 표시됩니다.`,
            thread_ts: threadTs,
          });
        } else {
          userSettingsStore.setUserSessionTheme(user, resolved);
          await say({
            text: `🎨 세션 테마가 *${resolved} (${THEME_NAMES[resolved]})* 로 고정되었습니다.\n해제: \`session theme=rotate\``,
            thread_ts: threadTs,
          });
        }
      }
      return { handled: true };
    }

    // Sessions command (user's sessions)
    if (CommandParser.isSessionsCommand(text)) {
      const { isPublic } = CommandParser.parseSessionsCommand(text);

      if (isPublic) {
        // Public: channel-visible, no kill buttons
        const { text: msgText, blocks } = await this.deps.sessionUiManager.formatUserSessionsBlocks(
          user,
          { showControls: false }
        );
        await say({
          text: msgText,
          blocks,
          thread_ts: threadTs,
        });
      } else {
        // Default: ephemeral (user-only), with kill buttons
        const { text: msgText, blocks } = await this.deps.sessionUiManager.formatUserSessionsBlocks(
          user,
          { showControls: true }
        );
        try {
          await this.deps.slackApi.postEphemeral(
            channel,
            user,
            msgText,
            threadTs,
            blocks
          );
        } catch (error) {
          this.logger.warn('postEphemeral failed, falling back to regular message', error);
          // Fallback to regular message if ephemeral fails
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
