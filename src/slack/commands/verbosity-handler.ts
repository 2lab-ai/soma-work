import { userSettingsStore } from '../../user-settings-store';
import { CommandParser } from '../command-parser';
import { getVerbosityFlags, type LogVerbosity, VERBOSITY_NAMES } from '../output-flags';
import type { CommandContext, CommandDependencies, CommandHandler, CommandResult } from './types';

/**
 * Handles verbosity commands (status/set)
 */
export class VerbosityHandler implements CommandHandler {
  constructor(private deps: CommandDependencies) {}

  canHandle(text: string): boolean {
    return CommandParser.isVerbosityCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, channel, threadTs, say } = ctx;
    const parsed = CommandParser.parseVerbosityCommand(ctx.text);

    if (parsed.action === 'set' && parsed.level) {
      const resolved = userSettingsStore.resolveVerbosityInput(parsed.level);
      if (resolved) {
        userSettingsStore.setUserDefaultLogVerbosity(user, resolved);

        // Also apply to the current session live
        const session = this.deps.claudeHandler.getSession(channel, threadTs);
        if (session) {
          session.logVerbosity = getVerbosityFlags(resolved);
        }

        await say({
          text: `✅ *Log Verbosity Changed*\n\nVerbosity is now: *${resolved}*\n\n_Applied to current and future sessions._`,
          thread_ts: threadTs,
        });
      } else {
        const validNames = VERBOSITY_NAMES.map((n) => `\`${n}\``).join(', ');
        await say({
          text: `❌ *Unknown Verbosity Level*\n\n\`${parsed.level}\` is not a valid level.\n\n*Available levels:* ${validNames}`,
          thread_ts: threadTs,
        });
      }
    } else {
      // Status
      const current = userSettingsStore.getUserDefaultLogVerbosity(user);
      const levelList = VERBOSITY_NAMES.map((name) =>
        name === current ? `• *${name}* _(current)_` : `• ${name}`,
      ).join('\n');

      await say({
        text: `📊 *Log Verbosity*\n\nCurrent: *${current}*\n\n*Available levels:*\n${levelList}\n\n_Use \`verbosity <level>\` to change._`,
        thread_ts: threadTs,
      });
    }

    return { handled: true };
  }
}
