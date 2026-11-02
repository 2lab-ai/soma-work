import { applyLang, renderLangCard } from '../z/topics/lang-topic';
import type { CommandContext, CommandHandler, CommandResult } from './types';

/** `lang`, `lang status`, `lang ko|en` (and `language …`, and `set ko|en` as `/z` translates it). */
const LANG_COMMAND = /^\/?(?:lang|language)(?:\s+(?:set\s+)?(\S+))?\s*$/i;

/**
 * #772 — the user's display language from Slack.
 *
 *   - bare `lang` / `lang status` → the `/z lang` card
 *   - `lang ko|en` → applyLang + a text ack in the language just chosen
 */
export class LangHandler implements CommandHandler {
  canHandle(text: string): boolean {
    return LANG_COMMAND.test(text.trim());
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, text, threadTs, say } = ctx;
    const arg = text.trim().match(LANG_COMMAND)?.[1];
    if (!arg || arg.toLowerCase() === 'status') {
      const { text: fallback, blocks } = await renderLangCard({ userId: user, issuedAt: Date.now() });
      await say({ text: fallback ?? '🌐 표시 언어', blocks, thread_ts: threadTs });
      return { handled: true };
    }
    const result = await applyLang({ userId: user, value: arg });
    await say({
      text: result.ok
        ? `✅ ${result.summary}\n\n${result.description ?? ''}`.trim()
        : `${result.summary}\n\n${result.description ?? ''}`.trim(),
      thread_ts: threadTs,
    });
    return { handled: true };
  }
}
