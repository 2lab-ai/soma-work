import { App } from '@slack/bolt';
import { Logger } from '../logger';

export interface MessageOptions {
  threadTs?: string;
  blocks?: any[];
  attachments?: any[];
}

/**
 * Slack API 호출을 위한 헬퍼 클래스
 * Slack Web API를 래핑하여 일관된 에러 처리와 로깅 제공
 */
export class SlackApiHelper {
  private logger = new Logger('SlackApiHelper');
  private botUserId: string | null = null;

  constructor(private app: App) {}

  /**
   * 사용자 ID로 사용자 이름 조회
   */
  async getUserName(userId: string): Promise<string> {
    try {
      const result = await this.app.client.users.info({ user: userId });
      return result.user?.real_name || result.user?.name || userId;
    } catch (error) {
      this.logger.warn('Failed to get user name', { userId, error });
      return userId;
    }
  }

  /**
   * 채널 ID로 채널 이름 조회
   * DM 채널은 'DM' 반환
   */
  async getChannelName(channelId: string): Promise<string> {
    try {
      if (channelId.startsWith('D')) {
        return 'DM';
      }
      const result = await this.app.client.conversations.info({ channel: channelId });
      return `#${(result.channel as any)?.name || channelId}`;
    } catch (error) {
      this.logger.warn('Failed to get channel name', { channelId, error });
      return channelId;
    }
  }

  /**
   * 메시지 퍼머링크 조회
   */
  async getPermalink(channel: string, messageTs: string): Promise<string | null> {
    try {
      const result = await this.app.client.chat.getPermalink({
        channel,
        message_ts: messageTs,
      });
      return result.permalink || null;
    } catch (error) {
      this.logger.warn('Failed to get permalink', { channel, messageTs, error });
      return null;
    }
  }

  /**
   * 봇 사용자 ID 조회 (캐싱됨)
   */
  async getBotUserId(): Promise<string> {
    if (!this.botUserId) {
      try {
        const response = await this.app.client.auth.test();
        this.botUserId = response.user_id as string;
      } catch (error) {
        this.logger.error('Failed to get bot user ID', error);
        this.botUserId = '';
      }
    }
    return this.botUserId;
  }

  /**
   * 메시지 전송
   */
  async postMessage(
    channel: string,
    text: string,
    options?: MessageOptions
  ): Promise<{ ts?: string; channel?: string }> {
    try {
      const result = await this.app.client.chat.postMessage({
        channel,
        text,
        thread_ts: options?.threadTs,
        blocks: options?.blocks,
        attachments: options?.attachments,
      });
      return { ts: result.ts, channel: result.channel };
    } catch (error) {
      this.logger.error('Failed to post message', { channel, error });
      throw error;
    }
  }

  /**
   * 메시지 업데이트
   */
  async updateMessage(
    channel: string,
    ts: string,
    text: string,
    blocks?: any[],
    attachments?: any[]
  ): Promise<void> {
    try {
      await this.app.client.chat.update({
        channel,
        ts,
        text,
        blocks,
        attachments,
      });
    } catch (error) {
      this.logger.warn('Failed to update message', { channel, ts, error });
      throw error;
    }
  }

  /**
   * 임시 메시지 전송 (특정 사용자에게만 보임)
   */
  async postEphemeral(
    channel: string,
    user: string,
    text: string,
    threadTs?: string
  ): Promise<void> {
    try {
      await this.app.client.chat.postEphemeral({
        channel,
        user,
        text,
        thread_ts: threadTs,
      });
    } catch (error) {
      this.logger.warn('Failed to post ephemeral message', { channel, user, error });
      throw error;
    }
  }

  /**
   * 리액션 추가
   * @returns true if successful or already exists, false on actual failure
   */
  async addReaction(channel: string, ts: string, emoji: string): Promise<boolean> {
    try {
      await this.app.client.reactions.add({
        channel,
        timestamp: ts,
        name: emoji,
      });
      return true;
    } catch (error: any) {
      // 이미 추가된 리액션은 성공으로 간주
      if (error?.data?.error === 'already_reacted') {
        return true;
      }
      this.logger.warn('Failed to add reaction', { channel, ts, emoji, error });
      return false;
    }
  }

  /**
   * 리액션 제거
   */
  async removeReaction(channel: string, ts: string, emoji: string): Promise<void> {
    try {
      await this.app.client.reactions.remove({
        channel,
        timestamp: ts,
        name: emoji,
      });
    } catch (error: any) {
      // 존재하지 않는 리액션 에러는 무시
      if (error?.data?.error !== 'no_reaction') {
        this.logger.debug('Failed to remove reaction (might not exist)', { channel, ts, emoji });
      }
    }
  }

  /**
   * 채널 정보 조회
   */
  async getChannelInfo(channelId: string): Promise<any> {
    try {
      const result = await this.app.client.conversations.info({ channel: channelId });
      return result.channel;
    } catch (error) {
      this.logger.warn('Failed to get channel info', { channelId, error });
      return null;
    }
  }

  /**
   * 모달 열기
   */
  async openModal(triggerId: string, view: any): Promise<void> {
    try {
      await this.app.client.views.open({
        trigger_id: triggerId,
        view,
      });
    } catch (error) {
      this.logger.error('Failed to open modal', { triggerId, error });
      throw error;
    }
  }
}
