import { SlackApiHelper } from './slack-api-helper';
import { Logger } from '../logger';
import { Todo } from '../todo-manager';

interface OriginalMessage {
  channel: string;
  ts: string;
}

/**
 * 메시지 리액션 상태를 관리하는 클래스
 * 세션별로 원본 메시지와 현재 리액션을 추적
 */
export class ReactionManager {
  private logger = new Logger('ReactionManager');
  private originalMessages: Map<string, OriginalMessage> = new Map();
  private currentReactions: Map<string, string> = new Map();
  // Track pending MCP calls per session
  private pendingMcpCalls: Map<string, Set<string>> = new Map();
  // Track pre-MCP reaction to restore after MCP completes
  private preMcpReactions: Map<string, string> = new Map();

  constructor(private slackApi: SlackApiHelper) {}

  /**
   * 세션의 원본 메시지 정보 설정
   */
  setOriginalMessage(sessionKey: string, channel: string, ts: string): void {
    this.originalMessages.set(sessionKey, { channel, ts });
  }

  /**
   * 세션의 원본 메시지 정보 조회
   */
  getOriginalMessage(sessionKey: string): OriginalMessage | undefined {
    return this.originalMessages.get(sessionKey);
  }

  /**
   * 메시지 리액션 업데이트
   * 이전 리액션을 제거하고 새 리액션 추가
   */
  async updateReaction(sessionKey: string, emoji: string): Promise<void> {
    const originalMessage = this.originalMessages.get(sessionKey);
    if (!originalMessage) {
      return;
    }

    // 이미 동일한 리액션이 설정되어 있으면 스킵
    const currentEmoji = this.currentReactions.get(sessionKey);
    if (currentEmoji === emoji) {
      this.logger.debug('Reaction already set, skipping', { sessionKey, emoji });
      return;
    }

    // 이전 리액션 제거
    if (currentEmoji) {
      await this.slackApi.removeReaction(
        originalMessage.channel,
        originalMessage.ts,
        currentEmoji
      );
      this.logger.debug('Removed previous reaction', { sessionKey, emoji: currentEmoji });
    }

    // 새 리액션 추가
    const success = await this.slackApi.addReaction(
      originalMessage.channel,
      originalMessage.ts,
      emoji
    );

    // 성공한 경우에만 현재 리액션 상태 업데이트
    if (success) {
      this.currentReactions.set(sessionKey, emoji);
      this.logger.debug('Updated message reaction', {
        sessionKey,
        emoji,
        previousEmoji: currentEmoji,
        channel: originalMessage.channel,
        ts: originalMessage.ts,
      });
    } else {
      this.logger.warn('Failed to update message reaction, state not updated', {
        sessionKey,
        emoji,
      });
    }
  }

  /**
   * Todo 진행 상황에 따른 리액션 업데이트
   */
  async updateTaskProgressReaction(sessionKey: string, todos: Todo[]): Promise<void> {
    if (todos.length === 0) {
      return;
    }

    const completed = todos.filter((t) => t.status === 'completed').length;
    const inProgress = todos.filter((t) => t.status === 'in_progress').length;
    const total = todos.length;

    let emoji: string;
    if (completed === total) {
      emoji = 'white_check_mark'; // 모든 태스크 완료
    } else if (inProgress > 0) {
      emoji = 'arrows_counterclockwise'; // 태스크 진행 중
    } else {
      emoji = 'clipboard'; // 태스크 대기 중
    }

    await this.updateReaction(sessionKey, emoji);
  }

  /**
   * MCP 호출 시작 시 모래시계 이모지 설정
   */
  async setMcpPending(sessionKey: string, callId: string): Promise<void> {
    let pending = this.pendingMcpCalls.get(sessionKey);
    if (!pending) {
      pending = new Set();
      this.pendingMcpCalls.set(sessionKey, pending);
    }

    // Save current reaction before switching to hourglass (only on first MCP)
    if (pending.size === 0) {
      const currentEmoji = this.currentReactions.get(sessionKey);
      if (currentEmoji && currentEmoji !== 'hourglass_flowing_sand') {
        this.preMcpReactions.set(sessionKey, currentEmoji);
      }
      // Set hourglass reaction
      await this.updateReaction(sessionKey, 'hourglass_flowing_sand');
      this.logger.debug('Set MCP pending reaction', { sessionKey, callId });
    }

    pending.add(callId);
  }

  /**
   * MCP 호출 완료 시 모래시계 이모지 제거
   */
  async clearMcpPending(sessionKey: string, callId: string): Promise<void> {
    const pending = this.pendingMcpCalls.get(sessionKey);
    if (!pending) return;

    pending.delete(callId);

    // If no more pending MCP calls, restore previous reaction
    if (pending.size === 0) {
      this.pendingMcpCalls.delete(sessionKey);
      const preMcpEmoji = this.preMcpReactions.get(sessionKey);
      this.preMcpReactions.delete(sessionKey);

      if (preMcpEmoji) {
        await this.updateReaction(sessionKey, preMcpEmoji);
        this.logger.debug('Restored pre-MCP reaction', { sessionKey, emoji: preMcpEmoji });
      }
    }
  }

  /**
   * 세션에 대기 중인 MCP 호출이 있는지 확인
   */
  hasPendingMcp(sessionKey: string): boolean {
    const pending = this.pendingMcpCalls.get(sessionKey);
    return pending ? pending.size > 0 : false;
  }

  /**
   * 세션 정리 시 리액션 상태 제거
   */
  cleanup(sessionKey: string): void {
    this.originalMessages.delete(sessionKey);
    this.currentReactions.delete(sessionKey);
    this.pendingMcpCalls.delete(sessionKey);
    this.preMcpReactions.delete(sessionKey);
    this.logger.debug('Cleaned up reaction state', { sessionKey });
  }

  /**
   * 현재 리액션 조회
   */
  getCurrentReaction(sessionKey: string): string | undefined {
    return this.currentReactions.get(sessionKey);
  }
}
