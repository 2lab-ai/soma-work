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
    const { channel, threadTs, text } = ctx;

    const sessionKey = this.deps.claudeHandler.getSessionKey(channel, threadTs);
    const session = this.deps.claudeHandler.getSession(channel, threadTs);

    // Extract user message after /renew command (e.g., "/renew PR 리뷰해줘" → "PR 리뷰해줘")
    const userMessage = text.replace(/^\/?\s*renew\s*/i, '').trim();

    // Check if there's an active session
    if (!session || !session.sessionId) {
      await this.deps.slackApi.postSystemMessage(channel,
        '💡 No active session to renew. Start a conversation first!',
        { threadTs }
      );
      return { handled: true };
    }

    // Check if a request is in progress
    if (this.deps.requestCoordinator.isRequestActive(sessionKey)) {
      await this.deps.slackApi.postSystemMessage(channel,
        '⚠️ Cannot renew while a request is in progress. Please wait for the current response to complete.',
        { threadTs }
      );
      return { handled: true };
    }

    // Check if already in renew process
    if (session.renewState) {
      await this.deps.slackApi.postSystemMessage(channel,
        '⚠️ Renew is already in progress. Please wait for it to complete.',
        { threadTs }
      );
      return { handled: true };
    }

    // Set renew state and save user message for after load
    session.renewState = 'pending_save';
    session.renewUserMessage = userMessage || undefined;

    await this.deps.slackApi.postSystemMessage(channel,
      userMessage
        ? `🔄 Saving context for handoff...\n_Load 후 지시사항: "${userMessage}"_`
        : '🔄 Saving context for handoff...',
      { threadTs }
    );

    // Return /save as the prompt to continue with.
    // Tool-first strategy: SAVE_CONTEXT_RESULT command is preferred, JSON output is fallback only.
    const savePrompt = `Follow this exact sequence:

1. Invoke Skill tool: skill="local:save"
2. If save succeeds, invoke model-command tool:
   - tool: mcp__model-command__run
   - args: {
       "commandId": "SAVE_CONTEXT_RESULT",
       "params": { "result": <save-result-payload> }
     }
3. If model-command tool is unavailable, output fallback JSON:
   {"save_result": <save-result-payload>}

Do not skip step 2 when model-command tool is available.`;

    return { handled: true, continueWithPrompt: savePrompt };
  }
}
