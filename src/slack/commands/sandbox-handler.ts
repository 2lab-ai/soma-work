import { isAdminUser } from '../../admin-utils';
import { getSandboxOffAllowed } from '../../config';
import { isSandboxOffInEffect } from '../../sandbox/admin-sandbox-profile';
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
/** Reply to an admin's `sandbox off` on a host whose operator has not allowed it. */
export const SANDBOX_OFF_NOT_ALLOWED_TEXT =
  `🛡️ *Sandbox stays ON*\n\nAdmins run in the admin sandbox: every network domain, gh and local servers work, while the ` +
  `secret store, the approval records and the deployment stay out of reach. The home package caches are read-only: ` +
  `give the install command its own cache in your temp directory (\`npm install --cache /tmp/<your user id>/npm\`, or the tool's cache option). ` +
  `Turning it off is allowed only by the host's operator (\`SOMA_SANDBOX_OFF_ALLOWED=true\` in \`.env\`), for an emergency.`;

export class SandboxHandler implements CommandHandler {
  canHandle(text: string): boolean {
    return CommandParser.isSandboxCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, text, threadTs, say } = ctx;
    const { target, action } = CommandParser.parseSandboxCommand(text);

    // The state sessions actually run with (env-access WU2, #1210).
    const sandboxDisabled = isSandboxOffInEffect({
      isAdmin: isAdminUser(user),
      requested: userSettingsStore.getUserSandboxDisabled(user),
      hostAllows: getSandboxOffAllowed(),
    });

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

      if (action === 'off' && !getSandboxOffAllowed()) {
        // env-access WU2 (#1210): admins run in the admin sandbox; only the host's operator allows off.
        await say({ text: SANDBOX_OFF_NOT_ALLOWED_TEXT, thread_ts: threadTs });
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
