import { CommandHandler, CommandContext, CommandResult } from './types';
import { CommandParser } from '../command-parser';
import { llmChatConfigStore } from '../../llm-chat-config-store';
import { isAdminUser } from '../../admin-utils';

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

  /** Returns true if admin, otherwise sends permission denied and returns false. */
  private async requireAdmin(userId: string, reply: (msg: string) => Promise<unknown>): Promise<boolean> {
    if (isAdminUser(userId)) return true;
    await reply(`🔒 *Permission Denied*\n\nOnly admins can modify LLM chat configuration.`);
    return false;
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { text, user, threadTs, say } = ctx;
    const action = CommandParser.parseLlmChatCommand(text);

    const reply = (message: string) => say({ text: message, thread_ts: threadTs });

    switch (action.action) {
      case 'show': {
        const display = llmChatConfigStore.formatForDisplay();
        await reply(`⚙️ *LLM Chat Configuration*\n\n\`\`\`\n${display}\n\`\`\`\n\n_Use \`set llm_chat <provider> <key> <value>\` to change settings (admin only)._`);
        break;
      }
      case 'reset': {
        if (!await this.requireAdmin(user, reply)) break;
        llmChatConfigStore.reset();
        const display = llmChatConfigStore.formatForDisplay();
        await reply(`🔄 *LLM Chat Config Reset*\n\nConfiguration reset to defaults:\n\`\`\`\n${display}\n\`\`\``);
        break;
      }
      case 'set': {
        if (!await this.requireAdmin(user, reply)) break;
        const error = llmChatConfigStore.set(action.provider, action.key, action.value);
        if (error) {
          await reply(`❌ *Configuration Error*\n\n${error}`);
        } else {
          await reply(`✅ *LLM Chat Config Updated*\n\n\`${action.provider}.${action.key}\` → \`${action.value}\`\n\n_This change applies to new llm_chat calls in this session._`);
        }
        break;
      }
      case 'error': {
        await reply(`❌ *Invalid Command*\n\n${action.message}`);
        break;
      }
    }

    return { handled: true };
  }
}
