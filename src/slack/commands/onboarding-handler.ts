import { Logger } from '../../logger';
import { CommandParser } from '../command-parser';
import type { CommandContext, CommandDependencies, CommandHandler, CommandResult } from './types';

/**
 * Handles /onboarding command - force-run onboarding workflow on demand
 */
export class OnboardingHandler implements CommandHandler {
  private logger = new Logger('OnboardingHandler');

  constructor(private deps: CommandDependencies) {}

  canHandle(text: string): boolean {
    return CommandParser.isOnboardingCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { channel, text, threadTs } = ctx;
    const { prompt } = CommandParser.parseOnboardingCommand(text);
    const sessionKey = this.deps.claudeHandler.getSessionKey(channel, threadTs);

    if (this.deps.requestCoordinator.isRequestActive(sessionKey)) {
      await this.deps.slackApi.postSystemMessage(
        channel,
        '⚠️ Cannot start onboarding while a request is in progress. Please wait for the current response to complete.',
        { threadTs },
      );
      return { handled: true };
    }

    const existingSession = this.deps.claudeHandler.getSession(channel, threadTs);
    if (existingSession?.sessionId) {
      await this.cleanupEmojisBeforeReset(sessionKey);
      this.deps.claudeHandler.resetSessionContext(channel, threadTs);
    }

    const session = this.deps.claudeHandler.getSession(channel, threadTs);
    if (session) {
      session.isOnboarding = true;
      session.renewState = null;
      session.renewUserMessage = undefined;
      session.renewSaveResult = undefined;
    }

    await this.deps.slackApi.postSystemMessage(
      channel,
      [
        '🧭 *Onboarding workflow started*',
        '',
        '이번 턴에서 현재 계정 설정 상태를 점검하고,',
        '사용 가능한 워크플로우/`new`/`renew` 실습 가이드까지 안내합니다.',
      ].join('\n'),
      { threadTs },
    );

    return {
      handled: true,
      continueWithPrompt: prompt || '온보딩을 시작해줘.',
      forceWorkflow: 'onboarding',
    };
  }

  /**
   * Cleanup emojis before resetting session to prevent duplicate emojis
   */
  private async cleanupEmojisBeforeReset(sessionKey: string): Promise<void> {
    try {
      await this.deps.contextWindowManager.cleanupWithReaction(sessionKey);

      const originalMsg = this.deps.reactionManager.getOriginalMessage(sessionKey);
      const statusEmoji = this.deps.reactionManager.getCurrentReaction(sessionKey);
      if (statusEmoji && originalMsg) {
        await this.deps.slackApi.removeReaction(originalMsg.channel, originalMsg.ts, statusEmoji);
        this.logger.debug('Removed status emoji before onboarding reset', {
          statusEmoji,
          sessionKey,
          ts: originalMsg.ts,
        });
      }

      this.deps.reactionManager.cleanup(sessionKey);
    } catch (error) {
      this.logger.debug('Error during emoji cleanup for onboarding reset (may be expected)', { error });
    }
  }
}
