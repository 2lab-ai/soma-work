import { CommandParser } from '../command-parser';
import { buildHelpCard } from '../z/ui-builder';
import type { CommandContext, CommandHandler, CommandResult } from './types';

/**
 * Handles `help` — renders the Block Kit `/z` help card (Phase 2, #507).
 *
 * Emits both the legacy text fallback (for screen readers and Slack clients
 * without Block Kit support) and the categorized navigation blocks so any
 * entry point (`/z`, `/z help`, `help` in a DM/thread) produces the same card.
 */
export class HelpHandler implements CommandHandler {
  canHandle(text: string): boolean {
    return CommandParser.isHelpCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { threadTs, say } = ctx;

    await say({
      text: CommandParser.getHelpMessage(),
      blocks: buildHelpCard({ issuedAt: Date.now() }),
      thread_ts: threadTs,
    });

    return { handled: true };
  }
}
