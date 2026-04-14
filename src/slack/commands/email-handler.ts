import { userSettingsStore } from '../../user-settings-store';
import { CommandParser } from '../command-parser';
import type { CommandContext, CommandHandler, CommandResult } from './types';

/**
 * Handles email commands (show email / set email <address>)
 */
export class EmailHandler implements CommandHandler {
  canHandle(text: string): boolean {
    return CommandParser.isEmailCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, text, threadTs, say } = ctx;
    const action = CommandParser.parseEmailCommand(text);

    if (action.action === 'status') {
      const currentEmail = userSettingsStore.getUserEmail(user);
      if (currentEmail) {
        await say({
          text: `📧 *Email*: \`${currentEmail}\``,
          thread_ts: threadTs,
        });
      } else {
        await say({
          text: `📧 *Email*: 설정되지 않음\n\n\`set email <your-email>\` 명령으로 이메일을 설정해주세요.`,
          thread_ts: threadTs,
        });
      }
    } else if (action.action === 'set') {
      // Basic email format validation
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(action.email)) {
        await say({
          text: `❌ *잘못된 이메일 형식*: \`${action.email}\`\n\n올바른 형식: \`set email you@company.com\``,
          thread_ts: threadTs,
        });
        return { handled: true };
      }

      userSettingsStore.setUserEmail(user, action.email);
      await say({
        text: `✅ *이메일 설정 완료*: \`${action.email}\`\n\n이제 Co-Authored-By 등에 이 이메일이 사용됩니다.`,
        thread_ts: threadTs,
      });
    }

    return { handled: true };
  }
}
