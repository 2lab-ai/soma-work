import { CommandHandler, CommandContext, CommandResult } from './types';
import { CommandParser } from '../command-parser';
import { llmChatConfigStore } from '../../llm-chat-config-store';

const ADMIN_USER_ID = process.env.ADMIN_USER_ID;

/**
 * Handles llm_chat configuration commands (set/show/reset)
 *
 * Commands:
 *   show llm_chat              - Display current config (all users)
 *   set llm_chat <p> <k> <v>  - Update a setting (admin only)
 *   reset llm_chat             - Reset to defaults (admin only)
 */
export class LlmChatHandler implements CommandHandler {
  canHandle(text: string): boolean {
    return CommandParser.isLlmChatCommand(text);
  }

  private isAdmin(userId: string): boolean {
    return !!ADMIN_USER_ID && userId === ADMIN_USER_ID;
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { text, user, threadTs, say } = ctx;
    const action = CommandParser.parseLlmChatCommand(text);

    switch (action.action) {
      case 'show': {
        const display = llmChatConfigStore.formatForDisplay();
        await say({
          text: `⚙️ *LLM Chat Configuration*\n\n\`\`\`\n${display}\n\`\`\`\n\n_Use \`set llm_chat <provider> <key> <value>\` to change settings (admin only)._`,
          thread_ts: threadTs,
        });
        break;
      }
      case 'reset': {
        if (!this.isAdmin(user)) {
          await say({
            text: `🔒 *Permission Denied*\n\nOnly admins can reset LLM chat configuration.`,
            thread_ts: threadTs,
          });
          break;
        }
        llmChatConfigStore.reset();
        const display = llmChatConfigStore.formatForDisplay();
        await say({
          text: `🔄 *LLM Chat Config Reset*\n\nConfiguration reset to defaults:\n\`\`\`\n${display}\n\`\`\``,
          thread_ts: threadTs,
        });
        break;
      }
      case 'set': {
        if (!this.isAdmin(user)) {
          await say({
            text: `🔒 *Permission Denied*\n\nOnly admins can modify LLM chat configuration.`,
            thread_ts: threadTs,
          });
          break;
        }
        const error = llmChatConfigStore.set(action.provider, action.key, action.value);
        if (error) {
          await say({
            text: `❌ *Configuration Error*\n\n${error}`,
            thread_ts: threadTs,
          });
        } else {
          await say({
            text: `✅ *LLM Chat Config Updated*\n\n\`${action.provider}.${action.key}\` → \`${action.value}\`\n\n_This change applies to new llm_chat calls in this session._`,
            thread_ts: threadTs,
          });
        }
        break;
      }
      case 'error': {
        await say({
          text: `❌ *Invalid Command*\n\n${action.message}`,
          thread_ts: threadTs,
        });
        break;
      }
    }

    return { handled: true };
  }
}
