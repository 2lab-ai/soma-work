import { SlackApiHelper } from './slack-api-helper';
import { McpCallTracker } from '../mcp-call-tracker';
import { Logger } from '../logger';

interface McpStatusMessage {
  ts: string;
  channel: string;
  serverName: string;
  toolName: string;
}

/**
 * MCP 도구 실행 상태 메시지를 관리하는 클래스
 * 실행 시간이 긴 MCP 호출에 대해 진행 상황을 표시
 */
export class McpStatusDisplay {
  private logger = new Logger('McpStatusDisplay');
  private statusIntervals: Map<string, NodeJS.Timeout> = new Map();
  private statusMessages: Map<string, McpStatusMessage> = new Map();

  constructor(
    private slackApi: SlackApiHelper,
    private mcpCallTracker: McpCallTracker
  ) {}

  /**
   * MCP 호출에 대한 주기적 상태 업데이트 시작
   * - codex: 즉시 상태 표시, 30초마다 업데이트
   * - 기타: 10초 후 상태 표시, 30초마다 업데이트
   */
  async startStatusUpdate(
    callId: string,
    serverName: string,
    toolName: string,
    channel: string,
    threadTs: string
  ): Promise<void> {
    const isCodex = serverName === 'codex';
    const initialDelay = isCodex ? 0 : 10000;

    const predicted = this.mcpCallTracker.getPredictedDuration(serverName, toolName);

    const createOrUpdateStatusMessage = async (isInitial: boolean) => {
      const elapsed = this.mcpCallTracker.getElapsedTime(callId);
      if (elapsed === null) {
        return;
      }

      const statusText = this.buildStatusText(serverName, toolName, elapsed, predicted);
      const msgInfo = this.statusMessages.get(callId);

      if (isInitial || !msgInfo) {
        try {
          const result = await this.slackApi.postMessage(channel, statusText, { threadTs });
          if (result.ts) {
            this.statusMessages.set(callId, { ts: result.ts, channel, serverName, toolName });
          }
        } catch (error) {
          this.logger.warn('Failed to create MCP status message', error);
        }
      } else {
        try {
          await this.slackApi.updateMessage(msgInfo.channel, msgInfo.ts, statusText);
          this.logger.debug('Updated MCP status message', { callId, elapsed });
        } catch (error) {
          this.logger.warn('Failed to update MCP status message', error);
        }
      }
    };

    if (isCodex) {
      // Codex: 즉시 상태 메시지 생성
      await createOrUpdateStatusMessage(true);

      // 30초마다 업데이트
      const interval = setInterval(async () => {
        const elapsed = this.mcpCallTracker.getElapsedTime(callId);
        if (elapsed === null) {
          await this.stopStatusUpdate(callId);
          return;
        }
        await createOrUpdateStatusMessage(false);
      }, 30000);

      this.statusIntervals.set(callId, interval);
    } else {
      // 기타: 10초 후 상태 표시
      const initialTimeout = setTimeout(async () => {
        const elapsed = this.mcpCallTracker.getElapsedTime(callId);
        if (elapsed === null) {
          return;
        }

        await createOrUpdateStatusMessage(true);

        // 30초마다 업데이트
        const interval = setInterval(async () => {
          const currentElapsed = this.mcpCallTracker.getElapsedTime(callId);
          if (currentElapsed === null) {
            await this.stopStatusUpdate(callId);
            return;
          }
          await createOrUpdateStatusMessage(false);
        }, 30000);

        this.statusIntervals.set(callId, interval);
      }, initialDelay);

      this.statusIntervals.set(callId, initialTimeout as unknown as NodeJS.Timeout);
    }
  }

  /**
   * MCP 호출의 상태 업데이트 중지 및 완료 메시지 표시
   */
  async stopStatusUpdate(callId: string, duration?: number | null): Promise<void> {
    this.logger.debug('Stopping MCP status update', { callId, duration });

    // 타이머 정리
    const timer = this.statusIntervals.get(callId);
    if (timer) {
      clearInterval(timer);
      clearTimeout(timer);
      this.statusIntervals.delete(callId);
      this.logger.debug('Cleared timer for MCP call', { callId });
    }

    // 상태 메시지를 완료 상태로 업데이트
    const msgInfo = this.statusMessages.get(callId);
    if (msgInfo) {
      try {
        let completedText = `✅ *MCP 완료: ${msgInfo.serverName} → ${msgInfo.toolName}*`;
        if (duration !== null && duration !== undefined) {
          completedText += ` (${McpCallTracker.formatDuration(duration)})`;
        }

        await this.slackApi.updateMessage(msgInfo.channel, msgInfo.ts, completedText);
        this.logger.debug('Updated MCP status message to completed', { callId, duration });
      } catch (error) {
        this.logger.warn('Failed to update MCP status message to completed', error);
      }
      this.statusMessages.delete(callId);
    }
  }

  /**
   * 상태 텍스트 생성
   */
  private buildStatusText(
    serverName: string,
    toolName: string,
    elapsed: number,
    predicted: number | null
  ): string {
    let statusText = `⏳ *MCP 실행 중: ${serverName} → ${toolName}*\n`;
    statusText += `경과 시간: ${McpCallTracker.formatDuration(elapsed)}`;

    if (predicted) {
      const remaining = Math.max(0, predicted - elapsed);
      const progress = Math.min(100, (elapsed / predicted) * 100);
      statusText += `\n예상 시간: ${McpCallTracker.formatDuration(predicted)}`;
      if (remaining > 0) {
        statusText += ` | 남은 시간: ~${McpCallTracker.formatDuration(remaining)}`;
      }
      statusText += `\n진행률: ${progress.toFixed(0)}%`;

      // 프로그레스 바
      const progressBarLength = 20;
      const filledLength = Math.round((progress / 100) * progressBarLength);
      const emptyLength = progressBarLength - filledLength;
      const progressBar = '█'.repeat(filledLength) + '░'.repeat(emptyLength);
      statusText += ` \`${progressBar}\``;
    }

    return statusText;
  }

  /**
   * 특정 callId에 대한 상태 메시지 정보 조회
   */
  getStatusMessageInfo(callId: string): McpStatusMessage | undefined {
    return this.statusMessages.get(callId);
  }

  /**
   * 활성 상태 업데이트 개수 조회
   */
  getActiveCount(): number {
    return this.statusIntervals.size;
  }
}
