import { userSettingsStore } from '../../user-settings-store';
import { CommandParser } from '../command-parser';
import { getVerbosityFlags, VERBOSITY_NAMES } from '../output-flags';
import { applyVerbosity, renderVerbosityCard } from '../z/topics/verbosity-topic';
import type { CommandContext, CommandDependencies, CommandHandler, CommandResult } from './types';

/**
 * Handles verbosity commands (status/set).
 *
 * Phase 2 (#507):
 *   - bare `verbosity` → Block Kit setting card
 *   - `verbosity <level>` → apply + text ack (also applied to current session)
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
      const result = await applyVerbosity({ userId: user, value: parsed.level });
      if (result.ok) {
        // Apply to the current session live — mirrors legacy behaviour.
        const resolved = userSettingsStore.resolveVerbosityInput(parsed.level);
        if (resolved) {
          const session = this.deps.claudeHandler.getSession(channel, threadTs);
          if (session) {
            session.logVerbosity = getVerbosityFlags(resolved);
          }
        }

        await say({
          text: `✅ *Log Verbosity Changed*\n\n${result.summary}\n\n_Applied to current and future sessions._`,
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
      const { text: fallback, blocks } = await renderVerbosityCard({
        userId: user,
        issuedAt: Date.now(),
      });
      await say({ text: fallback ?? '📊 Verbosity', blocks, thread_ts: threadTs });
    }

    return { handled: true };
  }
}
