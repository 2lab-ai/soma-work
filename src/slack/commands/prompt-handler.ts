import { isAdminUser } from '../../admin-utils';
import { Logger } from '../../logger';
import { CommandParser } from '../command-parser';
import type { CommandContext, CommandDependencies, CommandHandler, CommandResult } from './types';

/**
 * Handles "show prompt" command — displays the system prompt snapshot for the current session.
 * Admin-only: non-admin users receive a permission denied message.
 *
 * The system prompt is captured each time streamQuery() builds one and stored
 * on ConversationSession.systemPrompt (in-memory only, not persisted to disk).
 *
 * When the prompt exceeds Slack's message size limit, the full prompt is
 * uploaded as a .txt file instead of being truncated.
 */
export class PromptHandler implements CommandHandler {
  private logger = new Logger('PromptHandler');

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
      await this.deps.slackApi.postSystemMessage(
        channel,
        '💡 No active session in this thread. Start a conversation first!',
        { threadTs },
      );
      return { handled: true };
    }

    if (!session.systemPrompt) {
      await this.deps.slackApi.postSystemMessage(
        channel,
        '📋 *System Prompt*\n\nNo system prompt captured yet. Send a message first so the prompt is built.',
        { threadTs },
      );
      return { handled: true };
    }

    const prompt = session.systemPrompt;
    const charCount = prompt.length;
    const workflow = session.workflow || 'default';

    // Slack has a ~4000 char limit per message text block.
    const MAX_DISPLAY = 3800;
    const truncated = prompt.length > MAX_DISPLAY;

    const header = [
      '📋 *System Prompt Snapshot*',
      `*Workflow:* \`${workflow}\`  |  *Length:* ${charCount.toLocaleString()} chars`,
    ].join('\n');

    if (truncated) {
      // Upload full prompt as a text file instead of truncating
      await this.deps.slackApi.postSystemMessage(channel, `${header}\n\n📎 Full prompt attached as file.`, {
        threadTs,
      });

      try {
        await this.deps.slackApi.getClient().filesUploadV2({
          channel_id: channel,
          thread_ts: threadTs,
          content: prompt,
          filename: `system-prompt-${workflow}.txt`,
          title: `System Prompt (${workflow}) — ${charCount.toLocaleString()} chars`,
        });
      } catch (err) {
        this.logger.error('Failed to upload prompt file, falling back to truncated display', { error: err });
        const displayPrompt = `${prompt.slice(0, MAX_DISPLAY)}\n\n... (truncated)`;
        await this.deps.slackApi.postSystemMessage(
          channel,
          `⚠️ File upload failed. Showing first ${MAX_DISPLAY.toLocaleString()} chars.\n\n\`\`\`\n${displayPrompt}\n\`\`\``,
          { threadTs },
        );
      }
    } else {
      await this.deps.slackApi.postSystemMessage(channel, `${header}\n\n\`\`\`\n${prompt}\n\`\`\``, { threadTs });
    }

    return { handled: true };
  }
}
