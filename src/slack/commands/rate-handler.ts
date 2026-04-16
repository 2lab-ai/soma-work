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
        text: `⭐ *Model Rating*: \`${rating}/10\`\n\n\`rate +\` / \`rate -\` 명령으로 점수를 변경할 수 있습니다.`,
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
        text: `⭐ *Rating*: \`${oldRating}\` → \`${newRating}/10\` (+1)`,
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
        text: `⭐ *Rating*: \`${oldRating}\` → \`${newRating}/10\` (-1)`,
        thread_ts: threadTs,
      });
    }

    return { handled: true };
  }
}
