import { userSettingsStore } from '../../user-settings-store';
import { CommandParser } from '../command-parser';
import { applyEmail, renderEmailCard } from '../z/topics/email-topic';
import type { CommandContext, CommandHandler, CommandResult } from './types';

/**
 * Handles email commands (show email / set email <address>).
 *
 * Phase 2 (#507): bare `email` renders a Block Kit card with a "변경" modal
 * button. `set email <address>` keeps the CLI-style text ack for back-compat.
 */
export class EmailHandler implements CommandHandler {
  canHandle(text: string): boolean {
    return CommandParser.isEmailCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, text, threadTs, say } = ctx;
    const action = CommandParser.parseEmailCommand(text);

    if (action.action === 'status') {
      try {
        const { text: fallback, blocks } = await renderEmailCard({
          userId: user,
          issuedAt: Date.now(),
        });
        await say({ text: fallback ?? '📧 Email', blocks, thread_ts: threadTs });
      } catch {
        // Fallback to plain text if card render fails.
        const currentEmail = userSettingsStore.getUserEmail(user);
        if (currentEmail) {
          await say({ text: `📧 *Email*: \`${currentEmail}\``, thread_ts: threadTs });
        } else {
          await say({
            text: `📧 *Email*: 설정되지 않음\n\n\`set email <your-email>\` 명령으로 이메일을 설정해주세요.`,
            thread_ts: threadTs,
          });
        }
      }
    } else if (action.action === 'set') {
      const result = await applyEmail({ userId: user, value: action.email });
      if (result.ok) {
        await say({
          text: `✅ *이메일 설정 완료*: \`${action.email}\`\n\n${result.description ?? ''}`,
          thread_ts: threadTs,
        });
      } else {
        await say({
          text: `${result.summary}\n\n${result.description ?? ''}`,
          thread_ts: threadTs,
        });
      }
    }

    return { handled: true };
  }
}
