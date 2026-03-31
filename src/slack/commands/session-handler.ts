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

    // Session theme command (e.g., "sessions theme=A", "theme", "theme set B")
    if (CommandParser.isSessionThemeCommand(text)) {
      const parsed = CommandParser.parseSessionThemeCommand(text);
      if (parsed && parsed.theme === null) {
        // Query: show current theme
        const current = userSettingsStore.getUserSessionTheme(user);
        const themeList = Object.entries(THEME_NAMES)
          .map(([k, v]) => k === current ? `*\`${k}\` ${v}* ← 현재` : `\`${k}\` ${v}`)
          .join('\n');
        await say({
          text: `🎨 *현재 테마: ${current} (${THEME_NAMES[current]})*\n\n${themeList}\n\n변경: \`theme set <A-L>\` · 초기화: \`theme set default\``,
          thread_ts: threadTs,
        });
        return { handled: true };
      }
      if (parsed && parsed.theme !== null) {
        const resolved = userSettingsStore.resolveThemeInput(parsed.theme);
        if (resolved === null) {
          const validThemes = Object.entries(THEME_NAMES)
            .map(([k, v]) => `\`${k}\` (${v})`)
            .join(', ');
          await say({
            text: `❌ 알 수 없는 테마: \`${parsed.theme}\`\n사용 가능: ${validThemes}, \`reset\` (기본값으로 초기화)`,
            thread_ts: threadTs,
          });
        } else if (resolved === 'reset') {
          userSettingsStore.setUserSessionTheme(user, undefined);
          await say({
            text: `🎨 테마가 *기본값 (Default Rich Card)* 으로 초기화되었습니다.`,
            thread_ts: threadTs,
          });
        } else {
          userSettingsStore.setUserSessionTheme(user, resolved);
          await say({
            text: `🎨 테마가 *${THEME_NAMES[resolved]}* 로 설정되었습니다. 모든 UI에 적용됩니다.\n초기화: \`sessions theme=reset\``,
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

      const { text: msgText, blocks } = await this.deps.sessionUiManager.formatUserSessionsBlocks(
        user,
        { showControls: !isPublic }
      );

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
          await this.deps.slackApi.postEphemeral(
            channel,
            user,
            msgText,
            threadTs,
            blocks
          );
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
