import { Logger } from '../logger';
import { SlackApiHelper } from './slack-api-helper';
import { McpManager } from '../mcp-manager';

export interface McpHealthMonitorOptions {
  errorThreshold?: number;
  errorWindowMs?: number;
  alertCooldownMs?: number;
}

interface ServerHealthState {
  errorCount: number;
  lastErrorAt: number | null;
  lastAlertAt: number | null;
}

const DEFAULT_ERROR_THRESHOLD = 3;
const DEFAULT_ERROR_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_ALERT_COOLDOWN_MS = 10 * 60 * 1000;

export class McpHealthMonitor {
  private logger = new Logger('McpHealthMonitor');
  private states = new Map<string, ServerHealthState>();
  private errorThreshold: number;
  private errorWindowMs: number;
  private alertCooldownMs: number;

  constructor(
    private slackApi: SlackApiHelper,
    private mcpManager: McpManager,
    options?: McpHealthMonitorOptions
  ) {
    this.errorThreshold = options?.errorThreshold ?? DEFAULT_ERROR_THRESHOLD;
    this.errorWindowMs = options?.errorWindowMs ?? DEFAULT_ERROR_WINDOW_MS;
    this.alertCooldownMs = options?.alertCooldownMs ?? DEFAULT_ALERT_COOLDOWN_MS;
  }

  async recordResult(args: {
    toolName?: string;
    isError?: boolean;
    channel: string;
    threadTs: string;
  }): Promise<void> {
    if (!args.toolName || !args.toolName.startsWith('mcp__')) {
      return;
    }

    const serverName = this.extractServerName(args.toolName);
    if (!serverName) {
      return;
    }

    const now = Date.now();
    const state = this.getState(serverName);

    if (args.isError) {
      if (!state.lastErrorAt || now - state.lastErrorAt > this.errorWindowMs) {
        state.errorCount = 0;
      }

      state.errorCount += 1;
      state.lastErrorAt = now;

      if (state.errorCount >= this.errorThreshold && this.shouldAlert(state, now)) {
        state.lastAlertAt = now;
        await this.handleUnhealthyServer(serverName, args.channel, args.threadTs, state.errorCount);
      }
    } else if (state.errorCount > 0) {
      state.errorCount = 0;
      state.lastErrorAt = null;
    }

    this.states.set(serverName, state);
  }

  private getState(serverName: string): ServerHealthState {
    return this.states.get(serverName) || {
      errorCount: 0,
      lastErrorAt: null,
      lastAlertAt: null,
    };
  }

  private shouldAlert(state: ServerHealthState, now: number): boolean {
    if (!state.lastAlertAt) {
      return true;
    }
    return now - state.lastAlertAt > this.alertCooldownMs;
  }

  private extractServerName(toolName: string): string | null {
    const parts = toolName.split('__');
    return parts[1] || null;
  }

  private async handleUnhealthyServer(
    serverName: string,
    channel: string,
    threadTs: string,
    errorCount: number
  ): Promise<void> {
    const reloaded = this.mcpManager.reloadConfiguration();
    const reloadText = reloaded
      ? 'MCP 구성 재로드 완료'
      : 'MCP 구성 재로드 실패 (mcp-servers.json 확인 필요)';

    const message = [
      `⚠️ MCP 서버 오류 증가: ${serverName}`,
      `최근 오류 횟수: ${errorCount}회`,
      `자동 복구: ${reloadText}`,
      '필요하면 `/mcp reload`로 수동 재로드하세요.',
    ].join('\n');

    try {
      await this.slackApi.postSystemMessage(channel, message, { threadTs });
    } catch (error) {
      this.logger.warn('Failed to post MCP health alert', { serverName, error });
    }
  }
}
