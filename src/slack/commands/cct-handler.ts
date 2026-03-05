import { CommandHandler, CommandContext, CommandResult } from './types';
import { CommandParser } from '../command-parser';
import { isAdminUser } from '../../admin-utils';
import { tokenManager, TokenManager } from '../../token-manager';

/**
 * Handles CCT token management commands (admin only):
 * - `cct` — show token status
 * - `set_cct cctN` — switch active token
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
    const tokens = tokenManager.getAllTokens();

    if (tokens.length === 0) {
      await say({
        text: 'No CCT tokens configured. Set `CLAUDE_CODE_OAUTH_TOKEN_LIST` environment variable.',
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    if (action.action === 'status') {
      const active = tokenManager.getActiveToken();
      const now = new Date();
      const lines = tokens.map(t => {
        const masked = TokenManager.maskToken(t.value);
        const parts = [`${t.name}=\`${masked}\``];
        if (t.name === active.name) parts.push('*(active)*');
        if (t.cooldownUntil && t.cooldownUntil > now) {
          parts.push(`_(rate limited until ${t.cooldownUntil.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })})_`);
        }
        return parts.join(' ');
      });

      await say({
        text: `🔑 *CCT Token Status*\n\n${lines.join('\n')}`,
        thread_ts: threadTs,
      });
    } else if (action.action === 'set') {
      const success = tokenManager.setActiveToken(action.target);
      if (success) {
        const active = tokenManager.getActiveToken();
        await say({
          text: `✅ Active token switched to *${active.name}* (\`${TokenManager.maskToken(active.value)}\`)`,
          thread_ts: threadTs,
        });
      } else {
        const available = tokens.map(t => `\`${t.name}\``).join(', ');
        await say({
          text: `❌ Unknown token: \`${action.target}\`\nAvailable: ${available}`,
          thread_ts: threadTs,
        });
      }
    }

    return { handled: true };
  }
}
