import { COMPACT_THRESHOLD_MAX, COMPACT_THRESHOLD_MIN, validateCompactThreshold } from '../../user-settings-store';
import { CommandParser } from '../command-parser';
import type { CommandContext, CommandDependencies, CommandHandler, CommandResult } from './types';

/**
 * Handles `/compact-threshold` command (#617, AC1/AC2/AC7):
 *
 * - `/compact-threshold`         → reply with `Current threshold: N%`.
 * - `/compact-threshold <int>`   → validate 50–95, persist via
 *   `userSettingsStore.setUserCompactThreshold`, reply `Updated to N%`.
 * - `/compact-threshold <bad>`   → reply with the exact validator error message.
 *
 * All replies go to the current thread via `slackApi.postSystemMessage`.
 */
export class CompactThresholdHandler implements CommandHandler {
  constructor(private deps: CommandDependencies) {}

  canHandle(text: string): boolean {
    return CommandParser.isCompactThresholdCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { channel, threadTs, text, user } = ctx;
    const { rawArg } = CommandParser.parseCompactThresholdCommand(text);

    // AC7: no argument → current-value query.
    if (rawArg === undefined) {
      const current = this.deps.userSettingsStore.getUserCompactThreshold(user);
      await this.deps.slackApi.postSystemMessage(channel, `Current threshold: ${current}%`, { threadTs });
      return { handled: true };
    }

    // AC1: argument present → validate + persist. `validateCompactThreshold`
    // rejects NaN and non-integers ("abc", "3.5") with the same error message.
    try {
      const validated = validateCompactThreshold(Number(rawArg));
      this.deps.userSettingsStore.setUserCompactThreshold(user, validated);
      await this.deps.slackApi.postSystemMessage(channel, `Updated to ${validated}%`, { threadTs });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'invalid compactThreshold';
      await this.deps.slackApi.postSystemMessage(
        channel,
        `❌ ${msg} (allowed range: ${COMPACT_THRESHOLD_MIN}–${COMPACT_THRESHOLD_MAX})`,
        { threadTs },
      );
    }
    return { handled: true };
  }
}
