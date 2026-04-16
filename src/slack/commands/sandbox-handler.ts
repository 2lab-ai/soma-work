import { isAdminUser } from '../../admin-utils';
import { DEV_DOMAIN_ALLOWLIST } from '../../sandbox/dev-domain-allowlist';
import { userSettingsStore } from '../../user-settings-store';
import { CommandParser } from '../command-parser';
import type { CommandContext, CommandHandler, CommandResult } from './types';

/**
 * Handles sandbox + network toggle commands.
 *
 *   `sandbox [on|off|status]`          — admin-only for on/off; ON by default
 *   `sandbox network [on|off|status]`  — any user; ON by default
 *
 * Sandbox is an OS-level isolation layer captured at `query()` init, so
 * toggles take effect on the next user turn (next `query()` call), not mid-
 * session. The handler always surfaces the combined (sandbox × network)
 * state so users understand the effective posture.
 */
export class SandboxHandler implements CommandHandler {
  canHandle(text: string): boolean {
    return CommandParser.isSandboxCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, text, threadTs, say } = ctx;
    const { target, action } = CommandParser.parseSandboxCommand(text);

    const sandboxDisabled = userSettingsStore.getUserSandboxDisabled(user);
    const networkDisabled = userSettingsStore.getUserNetworkDisabled(user);

    if (action === 'status') {
      await say({ text: this.formatStatus(sandboxDisabled, networkDisabled), thread_ts: threadTs });
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

  /** Render the combined sandbox × network state. */
  private formatStatus(sandboxDisabled: boolean, networkDisabled: boolean): string {
    const sandboxLine = sandboxDisabled
      ? '• Sandbox: `OFF` — bash runs without isolation'
      : '• Sandbox: `ON` — bash runs in an isolated environment';

    let networkLine: string;
    if (networkDisabled) {
      networkLine = sandboxDisabled
        ? '• Network allowlist: `OFF` _(stored; inactive while sandbox is OFF)_'
        : '• Network allowlist: `OFF` — outbound traffic is not restricted to the dev allowlist';
    } else {
      networkLine = sandboxDisabled
        ? `• Network allowlist: \`ON\` _(stored; inactive while sandbox is OFF)_`
        : `• Network allowlist: \`ON\` — outbound restricted to ${DEV_DOMAIN_ALLOWLIST.length} preset dev domains`;
    }

    return [
      `🛡️ *Sandbox Status*`,
      '',
      sandboxLine,
      networkLine,
      '',
      '_`sandbox on|off` is admin-only. `sandbox network on|off` is available to all users. Changes apply from your next message._',
    ].join('\n');
  }
}
