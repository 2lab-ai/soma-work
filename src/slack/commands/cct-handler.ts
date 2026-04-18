import { isAdminUser } from '../../admin-utils';
import { getTokenManager, type TokenSummary } from '../../token-manager';
import { CommandParser } from '../command-parser';
import { renderCctCard } from '../z/topics/cct-topic';
import type { CommandContext, CommandHandler, CommandResult } from './types';

/**
 * Handles CCT token management commands (admin only):
 * - `cct` — show token status (Block Kit card in Phase 2)
 * - `cct set <name>` — switch active token (text ack, back-compat)
 * - `cct next` — rotate to next available token (text ack, back-compat)
 *
 * Legacy `set_cct` / `nextcct` underscore aliases were removed in #506.
 */
export class CctHandler implements CommandHandler {
  canHandle(text: string): boolean {
    return CommandParser.isCctCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, text, threadTs, say } = ctx;

    // Admin check
    if (!isAdminUser(user)) {
      await say({
        text: '⛔ Admin only command',
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    const action = CommandParser.parseCctCommand(text);
    const tm = getTokenManager();
    const tokens = tm.listTokens();

    if (tokens.length === 0) {
      await say({
        text: 'No CCT tokens configured. Set `CLAUDE_CODE_OAUTH_TOKEN_LIST` environment variable.',
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    if (action.action === 'status') {
      // Phase 2 (#507): render Block Kit card by default.
      const { text: fallback, blocks } = await renderCctCard({
        userId: user,
        issuedAt: Date.now(),
      });
      await say({ text: fallback ?? '🔑 CCT', blocks, thread_ts: threadTs });
    } else if (action.action === 'next') {
      const result = await tm.rotateToNext();
      if (result) {
        const active = tm.getActiveToken();
        await say({
          text: `🔄 Rotated to next token: *${active?.name ?? result.name}* (${active?.kind ?? 'setup_token'})`,
          thread_ts: threadTs,
        });
      } else {
        await say({
          text: '⚠️ Only one token available, cannot rotate.',
          thread_ts: threadTs,
        });
      }
    } else if (action.action === 'set') {
      const match = tokens.find((t: TokenSummary) => t.name === action.target);
      if (match) {
        await tm.applyToken(match.slotId);
        const active = tm.getActiveToken();
        await say({
          text: `✅ Active token switched to *${active?.name ?? match.name}* (${active?.kind ?? match.kind})`,
          thread_ts: threadTs,
        });
      } else {
        const available = tokens.map((t: TokenSummary) => `\`${t.name}\``).join(', ');
        await say({
          text: `❌ Unknown token: \`${action.target}\`\nAvailable: ${available}`,
          thread_ts: threadTs,
        });
      }
    }

    return { handled: true };
  }
}
