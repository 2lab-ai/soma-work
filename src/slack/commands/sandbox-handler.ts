import { isAdminUser } from '../../admin-utils';
import { userSettingsStore } from '../../user-settings-store';
import { CommandParser } from '../command-parser';
import type { CommandContext, CommandHandler, CommandResult } from './types';

/**
 * Handles sandbox toggle commands. Only admin users can change sandbox state.
 * Sandbox is ON by default for all users.
 */
export class SandboxHandler implements CommandHandler {
  canHandle(text: string): boolean {
    return CommandParser.isSandboxCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, text, threadTs, say } = ctx;
    const action = CommandParser.parseSandboxCommand(text);

    if (action === 'status') {
      const sandboxDisabled = userSettingsStore.getUserSandboxDisabled(user);
      await say({
        text: `🛡️ *Sandbox Status*\n\nYour current setting: \`${sandboxDisabled ? 'OFF' : 'ON'}\`\n\n${sandboxDisabled ? '⚠️ Sandbox is disabled. Bash commands run without isolation.' : '✅ Sandbox is enabled. Bash commands run in an isolated environment.'}`,
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    // on/off requires admin
    if (!isAdminUser(user)) {
      await say({
        text: `🚫 *Permission Denied*\n\nOnly admin users can change sandbox settings. Sandbox remains *ON* for your safety.`,
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    if (action === 'off') {
      userSettingsStore.setUserSandboxDisabled(user, true);
      await say({
        text: `⚠️ *Sandbox Disabled*\n\nBash commands will now run without sandbox isolation.\n\n_This setting applies to your sessions only. Use \`sandbox on\` to re-enable._`,
        thread_ts: threadTs,
      });
    } else if (action === 'on') {
      userSettingsStore.setUserSandboxDisabled(user, false);
      await say({
        text: `✅ *Sandbox Enabled*\n\nBash commands will now run in a sandboxed environment.`,
        thread_ts: threadTs,
      });
    }

    return { handled: true };
  }
}
