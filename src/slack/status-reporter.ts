import { WebClient } from '@slack/web-api';
import { Logger } from '../logger';

export type StatusType = 'thinking' | 'working' | 'waiting' | 'completed' | 'error' | 'cancelled';

interface StatusConfig {
  text: string;
  emoji: string;
}

const STATUS_CONFIG: Record<StatusType, StatusConfig> = {
  thinking: { text: '🤔 *Thinking...*', emoji: 'thinking_face' },
  working: { text: '⚙️ *Working...*', emoji: 'gear' },
  waiting: { text: '✋ *Waiting for input...*', emoji: 'raised_hand' },
  completed: { text: '✅ *Task completed*', emoji: 'white_check_mark' },
  error: { text: '❌ *Error occurred*', emoji: 'x' },
  cancelled: { text: '⏹️ *Cancelled*', emoji: 'octagonal_sign' },
};

export interface StatusMessage {
  channel: string;
  ts: string;
}

/**
 * Manages status message updates during Claude processing
 * Handles the status message lifecycle: create -> update -> finalize
 */
export class StatusReporter {
  private logger = new Logger('StatusReporter');
  private statusMessages: Map<string, StatusMessage> = new Map();

  constructor(private client: WebClient) {}

  /**
   * Create initial status message and return its timestamp
   * @param tag Optional verbose tag prefix (e.g. "[STATUS_MESSAGE @compact]")
   */
  async createStatusMessage(
    channel: string,
    threadTs: string,
    sessionKey: string,
    initialStatus: StatusType = 'thinking',
    tag: string = ''
  ): Promise<string | undefined> {
    try {
      const config = STATUS_CONFIG[initialStatus];
      const result = await this.client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: tag + config.text,
      });

      if (result.ts) {
        this.statusMessages.set(sessionKey, { channel, ts: result.ts });
        this.logger.debug('Created status message', {
          sessionKey,
          status: initialStatus,
          ts: result.ts,
        });
        return result.ts;
      }
    } catch (error) {
      this.logger.error('Failed to create status message', error);
    }
    return undefined;
  }

  /**
   * Update the status message for a session
   */
  async updateStatus(sessionKey: string, status: StatusType): Promise<void> {
    const statusMessage = this.statusMessages.get(sessionKey);
    if (!statusMessage) {
      this.logger.debug('No status message to update', { sessionKey });
      return;
    }

    try {
      const config = STATUS_CONFIG[status];
      await this.client.chat.update({
        channel: statusMessage.channel,
        ts: statusMessage.ts,
        text: config.text,
      });
      this.logger.debug('Updated status message', { sessionKey, status });
    } catch (error) {
      this.logger.error('Failed to update status message', { sessionKey, status, error });
    }
  }

  /**
   * Update status message using explicit channel and ts (for callback contexts)
   * @param tag Optional verbose tag prefix
   */
  async updateStatusDirect(
    channel: string,
    ts: string,
    status: StatusType,
    tag: string = ''
  ): Promise<void> {
    try {
      const config = STATUS_CONFIG[status];
      await this.client.chat.update({
        channel,
        ts,
        text: tag + config.text,
      });
      this.logger.debug('Updated status message directly', { channel, ts, status });
    } catch (error) {
      this.logger.error('Failed to update status message directly', { channel, ts, status, error });
    }
  }

  /**
   * Get the reaction emoji for a status type
   */
  getStatusEmoji(status: StatusType): string {
    return STATUS_CONFIG[status].emoji;
  }

  /**
   * Get the status message for a session
   */
  getStatusMessage(sessionKey: string): StatusMessage | undefined {
    return this.statusMessages.get(sessionKey);
  }

  /**
   * Clean up status tracking for a session
   */
  cleanup(sessionKey: string): void {
    this.statusMessages.delete(sessionKey);
    this.logger.debug('Cleaned up status tracking', { sessionKey });
  }
}
