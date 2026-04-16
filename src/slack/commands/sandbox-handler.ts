import { isAdminUser } from '../../admin-utils';
import { DEV_DOMAIN_ALLOWLIST } from '../../sandbox/dev-domain-allowlist';
import { userSettingsStore } from '../../user-settings-store';
import { CommandParser } from '../command-parser';
import { renderSandboxCard } from '../z/topics/sandbox-topic';
import type { CommandContext, CommandHandler, CommandResult } from './types';

/**
 * Handles sandbox + network toggle commands.
 *
 *   `sandbox [on|off|status]`          — admin-only for on/off; ON by default
 *   `sandbox network [on|off|status]`  — any user; ON by default
 *
 * Phase 2 (#507): bare `sandbox` / `sandbox status` renders a Block Kit card
 * via the /z topic module. Explicit on/off/network subcommands retain their
 * prior text output for CLI-style back-compat.
 */
export class SandboxHandler implements CommandHandler {
  canHandle(text: string): boolean {
    return CommandParser.isSandboxCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, text, threadTs, say } = ctx;
    const { target, action } = CommandParser.parseSandboxCommand(text);

    const sandboxDisabled = userSettingsStore.getUserSandboxDisabled(user);

    if (action === 'status') {
      // Phase 2: render Block Kit card by default.
      const { text: fallback, blocks } = await renderSandboxCard({
        userId: user,
        issuedAt: Date.now(),
      });
      await say({ text: fallback ?? '🛡️ Sandbox', blocks, thread_ts: threadTs });
      return { handled: true };
    }

    if (target === 'sandbox') {
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
          text:
            `⚠️ *Sandbox Disabled*\n\nBash commands will run without sandbox isolation starting from your next message.\n\n` +
            `_Use \`sandbox on\` to re-enable._`,
          thread_ts: threadTs,
        });
      } else {
        userSettingsStore.setUserSandboxDisabled(user, false);
        await say({
          text: `✅ *Sandbox Enabled*\n\nBash commands will run in a sandboxed environment starting from your next message.`,
          thread_ts: threadTs,
        });
      }
      return { handled: true };
    }

    // target === 'network' — any user can toggle
    if (action === 'off') {
      userSettingsStore.setUserNetworkDisabled(user, true);
      const effective = sandboxDisabled
        ? '_Note: sandbox is currently OFF, so this setting is stored but inactive until you turn sandbox back on._'
        : '_Takes effect on your next message. Outbound network in the sandbox will no longer be restricted by the dev allowlist._';
      await say({
        text: `⚠️ *Sandbox Network Allowlist Disabled*\n\n${effective}`,
        thread_ts: threadTs,
      });
    } else {
      userSettingsStore.setUserNetworkDisabled(user, false);
      const effective = sandboxDisabled
        ? '_Note: sandbox is currently OFF, so this setting is stored but inactive until you turn sandbox back on._'
        : `_Takes effect on your next message. Outbound traffic inside the sandbox is restricted to the preset dev allowlist (${DEV_DOMAIN_ALLOWLIST.length} domains)._`;
      await say({
        text: `✅ *Sandbox Network Allowlist Enabled*\n\n${effective}`,
        thread_ts: threadTs,
      });
    }
    return { handled: true };
  }
}
