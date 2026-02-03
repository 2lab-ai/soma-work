import { App } from '@slack/bolt';
import { Logger } from '../logger';

export interface MessageOptions {
  threadTs?: string;
  blocks?: any[];
  attachments?: any[];
}

/**
 * Rate limiting 설정
 */
interface RateLimitConfig {
  bucketSize: number;      // 최대 버스트 크기
  refillRate: number;      // 초당 리필 토큰 수
  minInterval: number;     // 최소 요청 간격 (ms)
}

const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  bucketSize: 10,          // 최대 10개 버스트
  refillRate: 3,           // 초당 3개 리필
  minInterval: 100,        // 최소 100ms 간격
};

/**
 * Slack API 호출을 위한 헬퍼 클래스
 * Slack Web API를 래핑하여 일관된 에러 처리와 로깅 제공
 * Rate limiting을 통해 API 리미트 방지
 */
export class SlackApiHelper {
  private logger = new Logger('SlackApiHelper');
  private botUserId: string | null = null;

  // Rate limiting state
  private tokens: number;
  private lastRefill: number;
  private lastRequest: number = 0;
  private queue: Array<{
    execute: () => Promise<any>;
    resolve: (value: any) => void;
    reject: (error: any) => void;
  }> = [];
  private processing = false;
  private rateLimit: RateLimitConfig;

  constructor(private app: App, rateLimit?: Partial<RateLimitConfig>) {
    this.rateLimit = { ...DEFAULT_RATE_LIMIT, ...rateLimit };
    this.tokens = this.rateLimit.bucketSize;
    this.lastRefill = Date.now();
  }

  /**
   * Get the underlying Slack WebClient for direct API access
   */
  getClient() {
    return this.app.client;
  }

  /**
   * Rate limit 큐에 API 호출 추가
   */
  private async enqueue<T>(execute: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ execute, resolve, reject });
      this.processQueue();
    });
  }

  /**
   * 큐 처리
   */
  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;

    while (this.queue.length > 0) {
      // 토큰 리필
      this.refillTokens();

      // 토큰이 없으면 대기
      if (this.tokens < 1) {
        const waitTime = Math.ceil(1000 / this.rateLimit.refillRate);
        this.logger.debug('Rate limit: waiting for token', {
          waitTime,
          queueLength: this.queue.length,
        });
        await this.sleep(waitTime);
        continue;
      }

      // 최소 간격 보장
      const elapsed = Date.now() - this.lastRequest;
      if (elapsed < this.rateLimit.minInterval) {
        await this.sleep(this.rateLimit.minInterval - elapsed);
      }

      // 요청 실행
      const item = this.queue.shift()!;
      this.tokens--;
      this.lastRequest = Date.now();

      try {
        const result = await item.execute();
        item.resolve(result);
      } catch (error: any) {
        // Rate limit 에러 처리
        if (error?.data?.error === 'ratelimited') {
          const retryAfter = parseInt(error?.data?.headers?.['retry-after'] || '5', 10);
          this.logger.warn('Slack rate limited, waiting', { retryAfter });
          this.tokens = 0; // 토큰 비우기
          await this.sleep(retryAfter * 1000);
          // 다시 큐에 넣기
          this.queue.unshift(item);
        } else {
          item.reject(error);
        }
      }
    }

    this.processing = false;
  }

  /**
   * 토큰 리필
   */
  private refillTokens(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    const refill = elapsed * this.rateLimit.refillRate;

    if (refill >= 1) {
      this.tokens = Math.min(this.rateLimit.bucketSize, this.tokens + Math.floor(refill));
      this.lastRefill = now;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 큐 상태 조회
   */
  getQueueStatus(): { queueLength: number; tokens: number } {
    return {
      queueLength: this.queue.length,
      tokens: this.tokens,
    };
  }

  /**
   * 사용자 ID로 사용자 이름 조회
   */
  async getUserName(userId: string): Promise<string> {
    try {
      const result = await this.enqueue(() =>
        this.app.client.users.info({ user: userId })
      );
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
      const result = await this.enqueue(() =>
        this.app.client.conversations.info({ channel: channelId })
      );
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
      const result = await this.enqueue(() =>
        this.app.client.chat.getPermalink({
          channel,
          message_ts: messageTs,
        })
      );
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
        const response = await this.enqueue(() =>
          this.app.client.auth.test()
        );
        this.botUserId = response.user_id as string;
      } catch (error) {
        this.logger.error('Failed to get bot user ID', error);
        this.botUserId = '';
      }
    }
    return this.botUserId;
  }

  /**
   * 시스템 메시지 전송 (⚡ zap 리액션으로 모델 응답과 구분)
   * 프로그램에서 직접 보내는 메시지에 사용
   */
  async postSystemMessage(
    channel: string,
    text: string,
    options?: MessageOptions
  ): Promise<{ ts?: string; channel?: string }> {
    const result = await this.postMessage(channel, text, options);
    if (result.ts) {
      await this.addReaction(channel, result.ts, 'zap');
    }
    return result;
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
      const result = await this.enqueue(() =>
        this.app.client.chat.postMessage({
          channel,
          text,
          thread_ts: options?.threadTs,
          blocks: options?.blocks,
          attachments: options?.attachments,
        })
      );
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
      await this.enqueue(() =>
        this.app.client.chat.update({
          channel,
          ts,
          text,
          blocks,
          attachments,
        })
      );
    } catch (error) {
      this.logger.warn('Failed to update message', { channel, ts, error });
      throw error;
    }
  }

  /**
   * 메시지 삭제 (봇이 보낸 메시지만 삭제 가능)
   */
  async deleteMessage(channel: string, ts: string): Promise<void> {
    try {
      await this.enqueue(() =>
        this.app.client.chat.delete({ channel, ts })
      );
    } catch (error) {
      this.logger.warn('Failed to delete message', { channel, ts, error });
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
    threadTs?: string,
    blocks?: any[]
  ): Promise<void> {
    try {
      await this.enqueue(() =>
        this.app.client.chat.postEphemeral({
          channel,
          user,
          text,
          thread_ts: threadTs,
          blocks,
        })
      );
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
      await this.enqueue(() =>
        this.app.client.reactions.add({
          channel,
          timestamp: ts,
          name: emoji,
        })
      );
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
      await this.enqueue(() =>
        this.app.client.reactions.remove({
          channel,
          timestamp: ts,
          name: emoji,
        })
      );
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
      const result = await this.enqueue(() =>
        this.app.client.conversations.info({ channel: channelId })
      );
      return result.channel;
    } catch (error) {
      this.logger.warn('Failed to get channel info', { channelId, error });
      return null;
    }
  }

  /**
   * Assistant thread status 설정 (네이티브 스피너)
   */
  async setAssistantStatus(channelId: string, threadTs: string, status: string): Promise<void> {
    await this.enqueue(() =>
      this.app.client.assistant.threads.setStatus({
        channel_id: channelId,
        thread_ts: threadTs,
        status,
      })
    );
  }

  /**
   * Assistant thread title 설정 (DM 히스토리용)
   */
  async setAssistantTitle(channelId: string, threadTs: string, title: string): Promise<void> {
    await this.enqueue(() =>
      this.app.client.assistant.threads.setTitle({
        channel_id: channelId,
        thread_ts: threadTs,
        title,
      })
    );
  }

  /**
   * 모달 열기
   */
  async openModal(triggerId: string, view: any): Promise<void> {
    try {
      await this.enqueue(() =>
        this.app.client.views.open({
          trigger_id: triggerId,
          view,
        })
      );
    } catch (error) {
      this.logger.error('Failed to open modal', { triggerId, error });
      throw error;
    }
  }
}
