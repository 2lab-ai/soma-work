import { SlackApiHelper } from './slack-api-helper';
import { McpCallTracker } from '../mcp-call-tracker';
import { Logger } from '../logger';

interface StatusMessage {
  ts: string;
  channel: string;
  displayType: string;
  displayLabel: string;
  paramsSummary?: string;
}

export interface StatusUpdateConfig {
  displayType: string;   // "MCP", "Subagent", etc.
  displayLabel: string;  // "codex → query", "General Purpose", etc.
  initialDelay: number;  // 0 = immediate, 10000 = 10s delay
  predictKey: { serverName: string; toolName: string };
  paramsSummary?: string; // compact params e.g. "(prompt: hello world)"
}

interface ProgressEntry {
  callId: string;
  displayType: string;
  displayLabel: string;
  paramsSummary?: string;
  status: 'running' | 'completed';
  startTime: number;
  duration?: number;
  predicted: number | null;
}

interface ConsolidatedGroup {
  groupId: string;
  channel: string;
  threadTs: string;
  messageTs: string | null;
  entries: Map<string, ProgressEntry>;
  debounceTimer: NodeJS.Timeout | null;
  updateInterval: NodeJS.Timeout | null;
}

/**
 * 도구 실행 상태 메시지를 관리하는 클래스
 * MCP 호출, Subagent 등 실행 시간이 긴 호출에 대해 진행 상황을 표시
 */
export class McpStatusDisplay {
  private logger = new Logger('McpStatusDisplay');
  private statusIntervals: Map<string, NodeJS.Timeout> = new Map();
  private statusMessages: Map<string, StatusMessage> = new Map();
  private groups: Map<string, ConsolidatedGroup> = new Map();
  private callIdToGroupId: Map<string, string> = new Map();

  constructor(
    private slackApi: SlackApiHelper,
    private mcpCallTracker: McpCallTracker
  ) {}

  /**
   * 호출에 대한 주기적 상태 업데이트 시작
   */
  async startStatusUpdate(
    callId: string,
    config: StatusUpdateConfig,
    channel: string,
    threadTs: string
  ): Promise<void> {
    const predicted = this.mcpCallTracker.getPredictedDuration(
      config.predictKey.serverName,
      config.predictKey.toolName
    );

    const createOrUpdateStatusMessage = async (isInitial: boolean) => {
      const elapsed = this.mcpCallTracker.getElapsedTime(callId);
      if (elapsed === null) return;

      const statusText = this.buildStatusText(config.displayType, config.displayLabel, elapsed, predicted, config.paramsSummary);
      const msgInfo = this.statusMessages.get(callId);

      if (isInitial || !msgInfo) {
        try {
          const result = await this.slackApi.postMessage(channel, statusText, { threadTs });
          if (result.ts) {
            this.statusMessages.set(callId, {
              ts: result.ts,
              channel,
              displayType: config.displayType,
              displayLabel: config.displayLabel,
              paramsSummary: config.paramsSummary,
            });
          }
        } catch (error) {
          this.logger.warn('Failed to create status message', error);
        }
      } else {
        try {
          await this.slackApi.updateMessage(msgInfo.channel, msgInfo.ts, statusText);
          this.logger.debug('Updated status message', { callId, elapsed });
        } catch (error) {
          this.logger.warn('Failed to update status message', error);
        }
      }
    };

    if (config.initialDelay === 0) {
      // 즉시 상태 메시지 생성
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
      // 지연 후 상태 표시
      const initialTimeout = setTimeout(async () => {
        const elapsed = this.mcpCallTracker.getElapsedTime(callId);
        if (elapsed === null) return;

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
      }, config.initialDelay);

      this.statusIntervals.set(callId, initialTimeout as unknown as NodeJS.Timeout);
    }
  }

  /**
   * 호출의 상태 업데이트 중지 및 완료 메시지 표시
   */
  async stopStatusUpdate(callId: string, duration?: number | null): Promise<void> {
    this.logger.debug('Stopping status update', { callId, duration });

    // 타이머 정리
    const timer = this.statusIntervals.get(callId);
    if (timer) {
      clearInterval(timer);
      clearTimeout(timer);
      this.statusIntervals.delete(callId);
      this.logger.debug('Cleared timer', { callId });
    }

    // 상태 메시지를 완료 상태로 업데이트
    const msgInfo = this.statusMessages.get(callId);
    if (msgInfo) {
      try {
        let completedText = `🟢 *${msgInfo.displayType} 완료: ${msgInfo.displayLabel}*`;
        if (msgInfo.paramsSummary) {
          completedText += ` ${msgInfo.paramsSummary}`;
        }
        if (duration !== null && duration !== undefined) {
          completedText += ` (${McpCallTracker.formatDuration(duration)})`;
        }

        await this.slackApi.updateMessage(msgInfo.channel, msgInfo.ts, completedText);
        this.logger.debug('Updated status message to completed', { callId, duration });
      } catch (error) {
        this.logger.warn('Failed to update status message to completed', error);
      }
      this.statusMessages.delete(callId);
    }
  }

  /**
   * 상태 텍스트 생성
   */
  private buildStatusText(
    displayType: string,
    displayLabel: string,
    elapsed: number,
    predicted: number | null,
    paramsSummary?: string
  ): string {
    let statusText = `⏳ *${displayType} 실행 중: ${displayLabel}*`;
    if (paramsSummary) {
      statusText += ` ${paramsSummary}`;
    }
    statusText += `\n경과 시간: ${McpCallTracker.formatDuration(elapsed)}`;

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
  getStatusMessageInfo(callId: string): StatusMessage | undefined {
    return this.statusMessages.get(callId);
  }

  /**
   * 활성 상태 업데이트 개수 조회
   */
  getActiveCount(): number {
    return this.statusIntervals.size;
  }

  // --- Consolidated Group Methods ---

  /**
   * 그룹에 상태 업데이트 시작 (병렬 배치용)
   */
  async startGroupStatusUpdate(
    groupId: string,
    callId: string,
    config: StatusUpdateConfig,
    channel: string,
    threadTs: string
  ): Promise<void> {
    const predicted = this.mcpCallTracker.getPredictedDuration(
      config.predictKey.serverName,
      config.predictKey.toolName
    );

    this.callIdToGroupId.set(callId, groupId);

    let group = this.groups.get(groupId);
    if (!group) {
      group = {
        groupId,
        channel,
        threadTs,
        messageTs: null,
        entries: new Map(),
        debounceTimer: null,
        updateInterval: null,
      };
      this.groups.set(groupId, group);
    }

    group.entries.set(callId, {
      callId,
      displayType: config.displayType,
      displayLabel: config.displayLabel,
      paramsSummary: config.paramsSummary,
      status: 'running',
      startTime: Date.now(),
      predicted,
    });

    // 그룹 내에서는 initialDelay 무시, 즉시 렌더
    this.scheduleGroupRender(groupId, 300);

    // 첫 엔트리일 때만 주기적 업데이트 시작 (10초)
    if (!group.updateInterval) {
      group.updateInterval = setInterval(() => {
        this.renderGroup(groupId);
      }, 10000);
    }
  }

  /**
   * 그룹 내 개별 작업 완료 처리
   */
  async stopGroupStatusUpdate(callId: string, duration?: number | null): Promise<void> {
    const groupId = this.callIdToGroupId.get(callId);
    if (!groupId) return;

    const group = this.groups.get(groupId);
    if (!group) return;

    const entry = group.entries.get(callId);
    if (entry) {
      entry.status = 'completed';
      entry.duration = duration ?? undefined;
    }

    // 전체 완료 확인
    const allCompleted = Array.from(group.entries.values()).every(e => e.status === 'completed');

    if (allCompleted) {
      // 최종 렌더 후 정리
      await this.renderGroup(groupId);
      this.cleanupGroup(groupId);
    } else {
      // 디바운스 렌더
      this.scheduleGroupRender(groupId, 300);
    }
  }

  /**
   * callId가 그룹에 속하는지 확인
   */
  isInGroup(callId: string): boolean {
    return this.callIdToGroupId.has(callId);
  }

  /**
   * 디바운스된 그룹 렌더 예약
   */
  private scheduleGroupRender(groupId: string, delayMs: number = 300): void {
    const group = this.groups.get(groupId);
    if (!group) return;

    if (group.debounceTimer) {
      clearTimeout(group.debounceTimer);
    }

    group.debounceTimer = setTimeout(() => {
      group.debounceTimer = null;
      this.renderGroup(groupId);
    }, delayMs);
  }

  /**
   * 최신 상태로 그룹 메시지 생성/업데이트
   */
  private async renderGroup(groupId: string): Promise<void> {
    const group = this.groups.get(groupId);
    if (!group) return;

    const statusText = this.buildGroupStatusText(group);

    if (!group.messageTs) {
      try {
        const result = await this.slackApi.postMessage(group.channel, statusText, { threadTs: group.threadTs });
        if (result.ts) {
          group.messageTs = result.ts;
        }
      } catch (error) {
        this.logger.warn('Failed to create group status message', error);
      }
    } else {
      try {
        await this.slackApi.updateMessage(group.channel, group.messageTs, statusText);
      } catch (error) {
        this.logger.warn('Failed to update group status message', error);
      }
    }
  }

  /**
   * 통합 메시지 텍스트 빌드
   */
  private buildGroupStatusText(group: ConsolidatedGroup): string {
    const entries = Array.from(group.entries.values());
    const total = entries.length;
    const completed = entries.filter(e => e.status === 'completed').length;
    const allDone = completed === total;

    let header: string;
    if (allDone) {
      header = `🟢 ${total}개 작업 완료`;
    } else {
      header = `📊 ${total}개 작업 실행 중 (${completed}/${total} 완료)`;
    }

    const lines = entries.map(entry => {
      const params = entry.paramsSummary ? ` ${entry.paramsSummary}` : '';
      if (entry.status === 'completed') {
        let line = `🟢 ${entry.displayLabel}${params}`;
        if (entry.duration !== undefined) {
          line += ` (${McpCallTracker.formatDuration(entry.duration)})`;
        }
        return line;
      } else {
        const elapsed = this.mcpCallTracker.getElapsedTime(entry.callId);
        const elapsedMs = elapsed ?? (Date.now() - entry.startTime);
        let line = `⏳ ${entry.displayLabel}${params} — ${McpCallTracker.formatDuration(elapsedMs)}`;

        if (entry.predicted) {
          const progress = Math.min(100, (elapsedMs / entry.predicted) * 100);
          const barLen = 20;
          const filled = Math.round((progress / 100) * barLen);
          const empty = barLen - filled;
          line += ` \`${'█'.repeat(filled)}${'░'.repeat(empty)}\``;
        }
        return line;
      }
    });

    return `${header}\n\n${lines.join('\n')}`;
  }

  /**
   * 그룹 리소스 정리
   */
  private cleanupGroup(groupId: string): void {
    const group = this.groups.get(groupId);
    if (!group) return;

    if (group.debounceTimer) {
      clearTimeout(group.debounceTimer);
    }
    if (group.updateInterval) {
      clearInterval(group.updateInterval);
    }

    for (const callId of group.entries.keys()) {
      this.callIdToGroupId.delete(callId);
    }

    this.groups.delete(groupId);
    this.logger.debug('Cleaned up group', { groupId });
  }
}
