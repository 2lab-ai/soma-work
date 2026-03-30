import { CommandHandler, CommandContext, CommandResult, CommandDependencies } from './types';
import { CommandParser } from '../command-parser';
import { isAdminUser } from '../../admin-utils';

/**
 * Handles "show prompt" command — displays the system prompt snapshot for the current session.
 * Admin-only: non-admin users receive a permission denied message.
 *
 * The system prompt is captured each time streamQuery() builds one and stored
 * on ConversationSession.systemPrompt (in-memory only, not persisted to disk).
 */
export class PromptHandler implements CommandHandler {
  constructor(private deps: CommandDependencies) {}

  canHandle(text: string): boolean {
    return CommandParser.isShowPromptCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, channel, threadTs } = ctx;

    // Admin gate
    if (!isAdminUser(user)) {
      await this.deps.slackApi.postSystemMessage(channel, '⛔ Admin only command', { threadTs });
      return { handled: true };
    }

    const session = this.deps.claudeHandler.getSession(channel, threadTs);

    if (!session) {
      await this.deps.slackApi.postSystemMessage(channel,
        '💡 No active session in this thread. Start a conversation first!',
        { threadTs }
      );
      return { handled: true };
    }

    if (!session.systemPrompt) {
      await this.deps.slackApi.postSystemMessage(channel,
        '📋 *System Prompt*\n\nNo system prompt captured yet. Send a message first so the prompt is built.',
        { threadTs }
      );
      return { handled: true };
    }

    const prompt = session.systemPrompt;
    const charCount = prompt.length;
    const workflow = session.workflow || 'default';

    // Slack has a ~4000 char limit per message text block.
    // For large prompts, truncate and indicate the full length.
    const MAX_DISPLAY = 3800;
    const truncated = prompt.length > MAX_DISPLAY;
    const displayPrompt = truncated
      ? prompt.slice(0, MAX_DISPLAY) + '\n\n... (truncated)'
      : prompt;

    const header = [
      '📋 *System Prompt Snapshot*',
      `*Workflow:* \`${workflow}\`  |  *Length:* ${charCount.toLocaleString()} chars`,
      truncated ? `⚠️ Prompt exceeds display limit. Showing first ${MAX_DISPLAY.toLocaleString()} chars.` : '',
    ].filter(Boolean).join('\n');

    await this.deps.slackApi.postSystemMessage(channel,
      `${header}\n\n\`\`\`\n${displayPrompt}\n\`\`\``,
      { threadTs }
    );

    return { handled: true };
  }
}
