import { CommandHandler, CommandContext, CommandResult } from './types';
import { CommandParser } from '../command-parser';
import { userSettingsStore } from '../../user-settings-store';

/**
 * Handles bypass permission commands
 */
export class BypassHandler implements CommandHandler {
  canHandle(text: string): boolean {
    return CommandParser.isBypassCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, text, threadTs, say } = ctx;
    const bypassAction = CommandParser.parseBypassCommand(text);

    if (bypassAction === 'status') {
      const currentBypass = userSettingsStore.getUserBypassPermission(user);
      await say({
        text: `🔐 *Permission Bypass Status*\n\nYour current setting: \`${currentBypass ? 'ON' : 'OFF'}\`\n\n${currentBypass ? '⚠️ Claude will execute tools without asking for permission.' : '✅ Claude will ask for permission before executing sensitive tools.'}`,
        thread_ts: threadTs,
      });
    } else if (bypassAction === 'on') {
      userSettingsStore.setUserBypassPermission(user, true);
      await say({
        text: `✅ *Permission Bypass Enabled*\n\nClaude will now execute tools without asking for permission.\n\n⚠️ _Use with caution - this allows Claude to perform actions automatically._`,
        thread_ts: threadTs,
      });
    } else if (bypassAction === 'off') {
      userSettingsStore.setUserBypassPermission(user, false);
      await say({
        text: `✅ *Permission Bypass Disabled*\n\nClaude will now ask for your permission before executing sensitive tools.`,
        thread_ts: threadTs,
      });
    }

    return { handled: true };
  }
}
