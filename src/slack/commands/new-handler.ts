import { Logger } from '../../logger';
import { CommandParser } from '../command-parser';
import type { CommandContext, CommandDependencies, CommandHandler, CommandResult } from './types';

/**
 * Handles /new command - resets session context while preserving metadata
 * Allows starting a fresh conversation in the same thread
 */
export class NewHandler implements CommandHandler {
  private logger = new Logger('NewHandler');

  constructor(private deps: CommandDependencies) {}

  canHandle(text: string): boolean {
    return CommandParser.isNewCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { channel, text, threadTs } = ctx;

    const { prompt } = CommandParser.parseNewCommand(text);

    // Check if there's an active request in progress (P1 race condition fix)
    const sessionKey = this.deps.claudeHandler.getSessionKey(channel, threadTs);
    if (this.deps.requestCoordinator.isRequestActive(sessionKey)) {
      await this.deps.slackApi.postSystemMessage(
        channel,
        '⚠️ Cannot reset session while a request is in progress. Please wait for the current response to complete or cancel it first.',
        { threadTs },
      );
      return { handled: true };
    }

    // Cleanup emojis before resetting session (prevents duplicate emojis)
    await this.cleanupEmojisBeforeReset(sessionKey);

    // Reset session context
    const wasReset = this.deps.claudeHandler.resetSessionContext(channel, threadTs);

    if (wasReset) {
      // Session existed and was reset (state → INITIALIZING, dispatch will re-run)
      // Get session info for detailed log
      const session = this.deps.claudeHandler.getSession(channel, threadTs);
      const resetDetails = [
        '🔄 *Session Reset Complete*',
        '',
        '> *초기화된 항목:*',
        '> • 대화 기록 (conversation history)',
        '> • 컨텍스트 윈도우 (context window)',
        '> • 워크플로우 분류 (workflow classification)',
        '',
        '> *유지된 항목:*',
        `> • 작업 디렉토리: \`${session?.workingDirectory || 'default'}\``,
        `> • 모델: \`${session?.model || 'default'}\``,
        `> • 소유자: <@${session?.ownerId}>`,
      ];

      if (prompt) {
        // Has follow-up prompt - send detailed confirmation and continue with prompt
        resetDetails.push('', `_Re-dispatching with: "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"_`);
        await this.deps.slackApi.postSystemMessage(channel, resetDetails.join('\n'), { threadTs });
        return { handled: true, continueWithPrompt: prompt };
      } else {
        // No follow-up prompt - just detailed confirmation
        resetDetails.push('', '_다음 메시지로 새 워크플로우가 시작됩니다._');
        await this.deps.slackApi.postSystemMessage(channel, resetDetails.join('\n'), { threadTs });
        return { handled: true };
      }
    } else {
      // No existing session - create info message
      if (prompt) {
        // No session to reset, but has prompt - just process it as new conversation
        await this.deps.slackApi.postSystemMessage(channel, '💡 Starting new conversation...', { threadTs });
        return { handled: true, continueWithPrompt: prompt };
      } else {
        // No session and no prompt
        await this.deps.slackApi.postSystemMessage(
          channel,
          '💡 No existing session in this thread. Just start typing to begin a new conversation!',
          { threadTs },
        );
        return { handled: true };
      }
    }
  }

  /**
   * Cleanup emojis before resetting session to prevent duplicate emojis
   * Uses stored channel/ts from contextWindowManager/reactionManager to ensure correct location
   */
  private async cleanupEmojisBeforeReset(sessionKey: string): Promise<void> {
    try {
      // Remove context window emoji using stored channel/ts (correct location!)
      // This is important because threadTs from command might differ from original message ts
      await this.deps.contextWindowManager.cleanupWithReaction(sessionKey);

      // Remove status emoji using stored original message info
      const originalMsg = this.deps.reactionManager.getOriginalMessage(sessionKey);
      const statusEmoji = this.deps.reactionManager.getCurrentReaction(sessionKey);
      if (statusEmoji && originalMsg) {
        await this.deps.slackApi.removeReaction(originalMsg.channel, originalMsg.ts, statusEmoji);
        this.logger.debug('Removed status emoji before reset', {
          statusEmoji,
          sessionKey,
          ts: originalMsg.ts,
        });
      }

      // Cleanup internal state
      this.deps.reactionManager.cleanup(sessionKey);
    } catch (error) {
      // Ignore emoji removal errors (emoji might already be removed)
      this.logger.debug('Error during emoji cleanup (may be expected)', { error });
    }
  }
}
