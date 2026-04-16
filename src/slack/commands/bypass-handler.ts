import { CommandParser } from '../command-parser';
import { applyBypass, renderBypassCard } from '../z/topics/bypass-topic';
import type { CommandContext, CommandHandler, CommandResult } from './types';

/**
 * Handles bypass permission commands.
 *
 * Phase 2 (#507):
 *   - bare `bypass` / `bypass status` → Block Kit card via renderBypassCard
 *   - `bypass on|off` → applyBypass + text ack (back-compat)
 */
export class BypassHandler implements CommandHandler {
  canHandle(text: string): boolean {
    return CommandParser.isBypassCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, text, threadTs, say } = ctx;
    const bypassAction = CommandParser.parseBypassCommand(text);

    if (bypassAction === 'status') {
      const { text: fallback, blocks } = await renderBypassCard({
        userId: user,
        issuedAt: Date.now(),
      });
      await say({ text: fallback ?? '🔐 Bypass', blocks, thread_ts: threadTs });
    } else if (bypassAction === 'on' || bypassAction === 'off') {
      const result = await applyBypass({ userId: user, value: bypassAction });
      if (result.ok) {
        await say({
          text: `✅ *Permission Bypass Updated*\n\n${result.summary}\n\n${result.description ?? ''}`,
          thread_ts: threadTs,
        });
      } else {
        await say({
          text: `❌ ${result.summary}\n\n${result.description ?? ''}`,
          thread_ts: threadTs,
        });
      }
    }

    return { handled: true };
  }
}
