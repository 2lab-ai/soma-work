import { CommandHandler, CommandContext, CommandResult, CommandDependencies } from './types';
import { CommandParser } from '../command-parser';

/**
 * Handles /renew command - save context and generate handoff message
 * Creates a formatted message that can be copied to continue in a new session
 */
export class RenewHandler implements CommandHandler {
  constructor(private deps: CommandDependencies) {}

  canHandle(text: string): boolean {
    return CommandParser.isRenewCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { channel, threadTs, say, text } = ctx;

    const sessionKey = this.deps.claudeHandler.getSessionKey(channel, threadTs);
    const session = this.deps.claudeHandler.getSession(channel, threadTs);

    // Extract user message after /renew command (e.g., "/renew PR 리뷰해줘" → "PR 리뷰해줘")
    const userMessage = text.replace(/^\/?\s*renew\s*/i, '').trim();

    // Check if there's an active session
    if (!session || !session.sessionId) {
      await say({
        text: '💡 No active session to renew. Start a conversation first!',
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    // Check if a request is in progress
    if (this.deps.requestCoordinator.isRequestActive(sessionKey)) {
      await say({
        text: '⚠️ Cannot renew while a request is in progress. Please wait for the current response to complete.',
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    // Check if already in renew process
    if (session.renewState) {
      await say({
        text: '⚠️ Renew is already in progress. Please wait for it to complete.',
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    // Set renew state and save user message for after load
    session.renewState = 'pending_save';
    session.renewUserMessage = userMessage || undefined;

    await say({
      text: userMessage
        ? `🔄 Saving context for handoff...\n_Load 후 지시사항: "${userMessage}"_`
        : '🔄 Saving context for handoff...',
      thread_ts: threadTs,
    });

    // Return /save as the prompt to continue with
    // CRITICAL: Claude must READ the skill body to get the JSON output format
    const savePrompt = `**CRITICAL: You MUST execute the save skill correctly.**

1. **READ the skill file first**: Use the Skill tool to invoke "local:save"
2. The skill body contains the EXACT JSON output format required
3. You MUST output a valid JSON block with "save_result" at the end
4. Without the correct JSON output, the renew flow will FAIL

DO NOT improvise. DO NOT skip reading the skill instructions.
Invoke the Skill tool with skill="local:save" NOW.`;

    return { handled: true, continueWithPrompt: savePrompt };
  }
}