import { SlackApiHelper } from './slack-api-helper';
import { Logger } from '../logger';
import { SessionUsage } from '../types';

interface ContextState {
  channel: string;
  ts: string;
  currentEmoji: string | null;
}

/**
 * Context Window 사용량 추적 및 이모지 시각화
 * 스레드 첫 메시지에 남은 context window 비율을 이모지로 표시
 */
export class ContextWindowManager {
  private logger = new Logger('ContextWindowManager');
  private slackApi: SlackApiHelper;

  // Track context emoji per session (separate from status emoji)
  private contextState: Map<string, ContextState> = new Map();

  // Emoji thresholds (checked in order, first match wins)
  private static readonly EMOJI_THRESHOLDS = [
    { min: 80, emoji: '80p' },
    { min: 60, emoji: '60p' },
    { min: 40, emoji: '40p' },
    { min: 20, emoji: '20p' },
    { min: 0, emoji: '0p' },
  ];

  constructor(slackApi: SlackApiHelper) {
    this.slackApi = slackApi;
  }

  /**
   * Set the original message for context emoji (thread's first message)
   * Called from SessionInitializer when session starts
   * NOTE: Does NOT preserve existing emoji - new session = fresh start
   */
  setOriginalMessage(sessionKey: string, channel: string, ts: string): void {
    this.contextState.set(sessionKey, {
      channel,
      ts,
      currentEmoji: null, // Always start fresh - no emoji preservation
    });
  }

  /**
   * Get current emoji for a session
   */
  getCurrentEmoji(sessionKey: string): string | null {
    return this.contextState.get(sessionKey)?.currentEmoji ?? null;
  }

  /**
   * Calculate remaining context window percentage
   */
  calculateRemainingPercent(usage: SessionUsage): number {
    const usedTokens = usage.currentInputTokens + usage.currentOutputTokens;
    const contextWindow = usage.contextWindow;
    return Math.max(0, Math.min(100, ((contextWindow - usedTokens) / contextWindow) * 100));
  }

  /**
   * Get emoji for percentage (first threshold that matches)
   */
  getEmojiForPercent(percent: number): string {
    for (const threshold of ContextWindowManager.EMOJI_THRESHOLDS) {
      if (percent >= threshold.min) {
        return threshold.emoji;
      }
    }
    return '0p'; // Fallback
  }

  /**
   * Update context emoji on thread's first message
   * Removes old context emoji if different, adds new one
   */
  async updateContextEmoji(sessionKey: string, percent: number): Promise<void> {
    const state = this.contextState.get(sessionKey);
    if (!state) {
      this.logger.warn('No context state found for session', { sessionKey });
      return;
    }

    const newEmoji = this.getEmojiForPercent(percent);

    // Skip if same emoji
    if (state.currentEmoji === newEmoji) {
      this.logger.debug('Context emoji unchanged', { sessionKey, emoji: newEmoji, percent: Math.round(percent) });
      return;
    }

    // Remove old context emoji
    if (state.currentEmoji) {
      await this.slackApi.removeReaction(state.channel, state.ts, state.currentEmoji);
      this.logger.debug('Removed old context emoji', {
        sessionKey,
        oldEmoji: state.currentEmoji,
      });
    }

    // Add new context emoji
    const success = await this.slackApi.addReaction(state.channel, state.ts, newEmoji);
    if (success) {
      state.currentEmoji = newEmoji;
      this.logger.info('Updated context emoji', {
        sessionKey,
        emoji: newEmoji,
        percent: Math.round(percent),
      });
    }
  }

  /**
   * Handle prompt too long error - force 0p emoji
   */
  async handlePromptTooLong(sessionKey: string): Promise<void> {
    await this.updateContextEmoji(sessionKey, 0);
    this.logger.warn('Context overflow - set 0p emoji', { sessionKey });
  }

  /**
   * Cleanup session state
   */
  cleanup(sessionKey: string): void {
    this.contextState.delete(sessionKey);
    this.logger.debug('Cleaned up context state', { sessionKey });
  }

  /**
   * Cleanup session state AND remove emoji from Slack
   * Use this when resetting session (new/renew commands)
   * @returns The removed emoji name, or null if none was set
   */
  async cleanupWithReaction(sessionKey: string): Promise<string | null> {
    const state = this.contextState.get(sessionKey);
    if (!state) {
      this.logger.debug('No context state to cleanup', { sessionKey });
      return null;
    }

    const removedEmoji = state.currentEmoji;

    // Remove emoji from Slack using stored channel/ts (correct location!)
    if (state.currentEmoji) {
      await this.slackApi.removeReaction(state.channel, state.ts, state.currentEmoji);
      this.logger.debug('Removed context emoji during cleanup', {
        sessionKey,
        emoji: state.currentEmoji,
        channel: state.channel,
        ts: state.ts,
      });
    }

    // Delete state
    this.contextState.delete(sessionKey);
    this.logger.debug('Cleaned up context state with reaction', { sessionKey });

    return removedEmoji;
  }

  /**
   * Get the stored original message info (channel, ts) for a session
   * Useful for cleanup operations that need the correct ts
   */
  getOriginalMessage(sessionKey: string): { channel: string; ts: string } | null {
    const state = this.contextState.get(sessionKey);
    if (!state) return null;
    return { channel: state.channel, ts: state.ts };
  }
}
