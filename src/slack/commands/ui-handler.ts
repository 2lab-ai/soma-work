import { CommandHandler, CommandContext, CommandResult, CommandDependencies } from './types';
import { CommandParser } from '../command-parser';
import { userSettingsStore } from '../../user-settings-store';
import { UI_MODE_NAMES, type UiMode } from '../progress/ui-mode';

/**
 * Handles `ui` command (persistent UI mode setting).
 * - `ui` → show current UI mode
 * - `ui message` → set to traditional messages (default)
 * - `ui agent` → set to Thinking Steps
 */
export class UiHandler implements CommandHandler {
  constructor(private deps: CommandDependencies) {}

  canHandle(text: string): boolean {
    return CommandParser.isUiCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, channel, threadTs, say } = ctx;
    const parsed = CommandParser.parseUiCommand(ctx.text);

    if (parsed.action === 'set' && parsed.mode) {
      const resolved = userSettingsStore.resolveUiModeInput(parsed.mode);
      if (resolved) {
        userSettingsStore.setUserDefaultUiMode(user, resolved);

        // Also apply to the current session live
        const session = this.deps.claudeHandler.getSession(channel, threadTs);
        if (session) {
          session.uiMode = resolved;
        }

        await say({
          text: `✅ *UI Mode Changed*\n\nUI mode is now: *${resolved}*\n\n_Applied to current and future sessions._`,
          thread_ts: threadTs,
        });
      } else {
        const validNames = UI_MODE_NAMES.map(n => `\`${n}\``).join(', ');
        await say({
          text: `❌ *Unknown UI Mode*\n\n\`${parsed.mode}\` is not a valid mode.\n\n*Available modes:* ${validNames}`,
          thread_ts: threadTs,
        });
      }
    } else {
      // Status
      const current = userSettingsStore.getUserDefaultUiMode(user);
      const modeDescriptions: Record<UiMode, string> = {
        message: 'Traditional Slack messages (default)',
        agent: 'Thinking Steps UI (plan/task_card)',
      };
      const modeList = UI_MODE_NAMES
        .map(name => name === current
          ? `• *${name}* — ${modeDescriptions[name]} _(current)_`
          : `• ${name} — ${modeDescriptions[name]}`)
        .join('\n');

      await say({
        text: `🖥️ *UI Mode*\n\nCurrent: *${current}*\n\n*Available modes:*\n${modeList}\n\n_Use \`ui <mode>\` to change._`,
        thread_ts: threadTs,
      });
    }

    return { handled: true };
  }
}
