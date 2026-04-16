import { EFFORT_LEVELS, userSettingsStore } from '../../user-settings-store';
import { CommandParser } from '../command-parser';
import type { CommandContext, CommandDependencies, CommandHandler, CommandResult } from './types';

/**
 * Handles `effort` / `effort <level>` — user-global default effort setter.
 *
 * Persists via `userSettingsStore.setUserDefaultEffort()` and mirrors the new
 * value onto the current session so the change takes effect immediately
 * (matching the existing `verbosity` handler's live-apply behavior).
 *
 * Session-only changes (`%effort` / `$effort`) are handled by
 * `SessionCommandHandler` — kept distinct to preserve the invariant:
 *   bare command  = user-global, persisted
 *   prefixed form = session-scoped, not persisted
 */
export class EffortHandler implements CommandHandler {
  constructor(private deps: CommandDependencies) {}

  canHandle(text: string): boolean {
    return CommandParser.isEffortCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, channel, threadTs, say } = ctx;
    const parsed = CommandParser.parseEffortCommand(ctx.text);

    if (parsed.action === 'set' && parsed.level) {
      const resolved = userSettingsStore.resolveEffortInput(parsed.level);
      if (resolved) {
        userSettingsStore.setUserDefaultEffort(user, resolved);

        // Apply live to the current session so the caller sees the change
        // on this turn, not only on the next new session.
        const session = this.deps.claudeHandler.getSession(channel, threadTs);
        if (session) {
          session.effort = resolved;
        }

        await say({
          text: `✅ *Effort Changed*\n\nDefault effort is now: *${resolved}*\n\n_Applied to current and future sessions._`,
          thread_ts: threadTs,
        });
      } else {
        const validNames = EFFORT_LEVELS.map((n) => `\`${n}\``).join(', ');
        await say({
          text: `❌ *Unknown Effort Level*\n\n\`${parsed.level}\` is not a valid level.\n\n*Available levels:* ${validNames}`,
          thread_ts: threadTs,
        });
      }
    } else {
      // Status
      const current = userSettingsStore.getUserDefaultEffort(user);
      const levelList = EFFORT_LEVELS.map((name) => (name === current ? `• *${name}* _(current)_` : `• ${name}`)).join(
        '\n',
      );

      await say({
        text: `🎚 *Effort*\n\nCurrent default: *${current}*\n\n*Available levels:*\n${levelList}\n\n_Use \`effort <level>\` to change (persists). Use \`%effort <level>\` for session-only._`,
        thread_ts: threadTs,
      });
    }

    return { handled: true };
  }
}
