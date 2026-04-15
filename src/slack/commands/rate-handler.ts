import { userSettingsStore } from '../../user-settings-store';
import { CommandParser } from '../command-parser';
import type { CommandContext, CommandHandler, CommandResult } from './types';

/**
 * Handles rate commands (rate / rate + / rate -)
 * Allows users to rate the model's response quality.
 * The rating is visible to the model via <your_rating> context tag.
 */
export class RateHandler implements CommandHandler {
  canHandle(text: string): boolean {
    return CommandParser.isRateCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, text, threadTs, say } = ctx;
    const action = CommandParser.parseRateCommand(text);

    if (action.action === 'status') {
      const rating = userSettingsStore.getUserRating(user);
      await say({
        text: `\u2B50 *Model Rating*: \`${rating}/10\`\n\n\`rate +\` / \`rate -\` \uBA85\uB839\uC73C\uB85C \uC810\uC218\uB97C \uBCC0\uACBD\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.`,
        thread_ts: threadTs,
      });
    } else if (action.action === 'up') {
      const oldRating = userSettingsStore.getUserRating(user);
      const newRating = Math.min(10, oldRating + 1);
      userSettingsStore.setUserRating(user, newRating);
      if (newRating !== oldRating) {
        userSettingsStore.setPendingRatingChange(user, { from: oldRating, to: newRating });
      }
      await say({
        text: `\u2B50 *Rating*: \`${oldRating}\` \u2192 \`${newRating}/10\` (+1)`,
        thread_ts: threadTs,
      });
    } else if (action.action === 'down') {
      const oldRating = userSettingsStore.getUserRating(user);
      const newRating = Math.max(0, oldRating - 1);
      userSettingsStore.setUserRating(user, newRating);
      if (newRating !== oldRating) {
        userSettingsStore.setPendingRatingChange(user, { from: oldRating, to: newRating });
      }
      await say({
        text: `\u2B50 *Rating*: \`${oldRating}\` \u2192 \`${newRating}/10\` (-1)`,
        thread_ts: threadTs,
      });
    }

    return { handled: true };
  }
}
