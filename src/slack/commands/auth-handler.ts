import { isAdminUser } from '../../admin-utils';
import { switchLlmuxAccount } from '../../auth/llmux-client';
import { CommandParser } from '../command-parser';
import { applyAuthMode, renderAuthCard } from '../z/topics/auth-topic';
import type { CommandContext, CommandHandler, CommandResult } from './types';

/**
 * Handles auth backend commands (#llmux runtime switch):
 *   - `auth`                     — show the auth card (mode + llmux pool /
 *                                  legacy cct card). Non-admin sees the
 *                                  readonly variant (no emails, no buttons).
 *   - `auth llmux` / `auth cct`  — flip the runtime auth mode (admin only).
 *     (`set auth llmux|cct` is an accepted alias.)
 *   - `auth switch <name>`       — llmux manual account switch (admin only).
 *
 * llmux settings (`ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`) and account
 * add/remove are card-modal only — secrets must not transit chat text.
 */
export class AuthHandler implements CommandHandler {
  canHandle(text: string): boolean {
    return CommandParser.isAuthCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, text, threadTs, say } = ctx;
    const action = CommandParser.parseAuthCommand(text);

    const denyNonAdmin = async (): Promise<CommandResult> => {
      await say({ text: '⛔ Admin only command', thread_ts: threadTs });
      return { handled: true };
    };

    if (action.action === 'set-mode') {
      if (!isAdminUser(user)) return denyNonAdmin();
      const result = await applyAuthMode({ userId: user, mode: action.mode });
      const detail = result.description ? `\n${result.description}` : '';
      await say({ text: `${result.summary}${detail}`, thread_ts: threadTs });
      return { handled: true };
    }

    if (action.action === 'switch') {
      if (!isAdminUser(user)) return denyNonAdmin();
      try {
        const result = await switchLlmuxAccount(action.target);
        await say({ text: `🔀 llmux account → *${result.current}*`, thread_ts: threadTs });
      } catch (err) {
        await say({ text: `❌ Switch failed: ${(err as Error).message}`, thread_ts: threadTs });
      }
      return { handled: true };
    }

    // status — card render. Viewer mode (admin/readonly) is derived inside
    // renderAuthCard, so non-admin gets the masked readonly card.
    const { text: fallback, blocks } = await renderAuthCard({ userId: user, issuedAt: Date.now() });
    await say({ text: fallback ?? '🔐 Auth', blocks, thread_ts: threadTs });
    return { handled: true };
  }
}
