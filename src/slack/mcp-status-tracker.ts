import { SlackApiHelper } from './slack-api-helper';
import { McpCallTracker } from '../mcp-call-tracker';
import { Logger } from '../logger';

export interface StatusUpdateConfig {
  displayType: string;   // "MCP", "Subagent", etc.
  displayLabel: string;  // "codex → query", "General Purpose", etc.
  initialDelay: number;  // ignored in session-tick model (kept for API compat)
  predictKey: { serverName: string; toolName: string };
  paramsSummary?: string; // compact params e.g. "(prompt: hello world)"
}

interface ActiveCallEntry {
  callId: string;
  sessionKey: string;
  config: StatusUpdateConfig;
  channel: string;
  threadTs: string;
  startTime: number;
  status: 'running' | 'completed' | 'timed_out';
  duration?: number;
  predicted: number | null;
}

interface SessionTick {
  sessionKey: string;
  channel: string;
  threadTs: string;
  messageTs: string | null;
  interval: NodeJS.Timeout | null;
  currentIntervalMs: number;
}

const MCP_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours

function getAdaptiveInterval(elapsedMs: number): number {
  if (elapsedMs < 60_000) return 10_000;
  if (elapsedMs < 600_000) return 30_000;
  if (elapsedMs < 1_800_000) return 60_000;
  return 300_000;
}

/**
 * Session-level MCP status display.
 * Instead of per-call timers, uses a single tick per session
 * that renders all active calls in a consolidated message.
 * Maximum 1 Slack API call per tick.
 */
export class McpStatusDisplay {
  private logger = new Logger('McpStatusDisplay');
  private activeCalls: Map<string, ActiveCallEntry> = new Map();
  private sessionTicks: Map<string, SessionTick> = new Map();

  constructor(
    private slackApi: SlackApiHelper,
    private mcpCallTracker: McpCallTracker
  ) {}

  /**
   * Register a new MCP/subagent call for session-level tracking.
   */
  registerCall(
    sessionKey: string,
    callId: string,
    config: StatusUpdateConfig,
    channel: string,
    threadTs: string
  ): void {
    const predicted = this.mcpCallTracker.getPredictedDuration(
      config.predictKey.serverName,
      config.predictKey.toolName
    );

    this.activeCalls.set(callId, {
      callId,
      sessionKey,
      config,
      channel,
      threadTs,
      startTime: Date.now(),
      status: 'running',
      predicted,
    });

    // Start session tick if needed
    if (!this.sessionTicks.has(sessionKey)) {
      const tick: SessionTick = {
        sessionKey,
        channel,
        threadTs,
        messageTs: null,
        interval: null,
        currentIntervalMs: 10_000,
      };
      this.sessionTicks.set(sessionKey, tick);
      this.startTick(tick);
    }
  }

  /**
   * Mark a call as completed. Rendered on next tick.
   */
  completeCall(callId: string, duration: number | null): void {
    const entry = this.activeCalls.get(callId);
    if (!entry) return;

    this.activeCalls.set(callId, {
      ...entry,
      status: 'completed',
      duration: duration ?? undefined,
    });
  }

  /**
   * Cleanup all calls and tick for a session.
   */
  cleanupSession(sessionKey: string): void {
    // Remove all calls for this session
    for (const [callId, entry] of this.activeCalls) {
      if (entry.sessionKey === sessionKey) {
        this.activeCalls.delete(callId);
      }
    }

    // Stop and remove tick
    const tick = this.sessionTicks.get(sessionKey);
    if (tick) {
      this.stopTick(tick);
      this.sessionTicks.delete(sessionKey);
    }
  }

  /**
   * Number of active (running) calls across all sessions.
   */
  getActiveCount(): number {
    let count = 0;
    for (const entry of this.activeCalls.values()) {
      if (entry.status === 'running') count++;
    }
    return count;
  }

  // --- Private tick management ---

  private startTick(tick: SessionTick): void {
    tick.interval = setInterval(() => {
      this.tick(tick);
    }, tick.currentIntervalMs);
  }

  private stopTick(tick: SessionTick): void {
    if (tick.interval) {
      clearInterval(tick.interval);
      tick.interval = null;
    }
  }

  private async tick(tick: SessionTick): Promise<void> {
    const calls = this.getSessionCalls(tick.sessionKey);
    if (calls.length === 0) {
      this.stopTick(tick);
      this.sessionTicks.delete(tick.sessionKey);
      return;
    }

    // Check timeouts
    for (const call of calls) {
      if (call.status !== 'running') continue;
      const elapsed = this.mcpCallTracker.getElapsedTime(call.callId);
      const elapsedMs = elapsed ?? (Date.now() - call.startTime);
      if (elapsedMs >= MCP_TIMEOUT_MS) {
        this.activeCalls.set(call.callId, { ...call, status: 'timed_out' });
        this.logger.warn('MCP call timed out', { callId: call.callId, elapsed: elapsedMs });
      }
    }

    // Re-fetch after timeout mutations
    const updatedCalls = this.getSessionCalls(tick.sessionKey);
    const allDone = updatedCalls.every(c => c.status !== 'running');

    // Compute adaptive interval from running calls
    if (!allDone) {
      const minInterval = this.computeMinInterval(updatedCalls);
      if (minInterval !== tick.currentIntervalMs) {
        this.stopTick(tick);
        tick.currentIntervalMs = minInterval;
        tick.interval = setInterval(() => {
          this.tick(tick);
        }, tick.currentIntervalMs);
      }
    }

    // Render consolidated message
    const statusText = this.buildConsolidatedText(updatedCalls);

    if (!tick.messageTs) {
      try {
        const result = await this.slackApi.postMessage(tick.channel, statusText, { threadTs: tick.threadTs });
        if (result.ts) {
          tick.messageTs = result.ts;
        }
      } catch (error) {
        this.logger.warn('Failed to create session status message', error);
      }
    } else {
      try {
        await this.slackApi.updateMessage(tick.channel, tick.messageTs, statusText);
      } catch (error) {
        this.logger.warn('Failed to update session status message', error);
      }
    }

    // All done → final render complete, stop tick and remove entries
    if (allDone) {
      this.stopTick(tick);
      this.sessionTicks.delete(tick.sessionKey);
      for (const call of updatedCalls) {
        this.activeCalls.delete(call.callId);
      }
    }
  }

  private getSessionCalls(sessionKey: string): ActiveCallEntry[] {
    const calls: ActiveCallEntry[] = [];
    for (const entry of this.activeCalls.values()) {
      if (entry.sessionKey === sessionKey) {
        calls.push(entry);
      }
    }
    return calls;
  }

  private computeMinInterval(calls: ActiveCallEntry[]): number {
    let minInterval = 300_000;
    for (const call of calls) {
      if (call.status !== 'running') continue;
      const elapsed = this.mcpCallTracker.getElapsedTime(call.callId);
      const elapsedMs = elapsed ?? (Date.now() - call.startTime);
      const interval = getAdaptiveInterval(elapsedMs);
      if (interval < minInterval) {
        minInterval = interval;
      }
    }
    return minInterval;
  }

  // --- Rendering ---

  private buildConsolidatedText(calls: ActiveCallEntry[]): string {
    const total = calls.length;
    const completed = calls.filter(c => c.status === 'completed').length;
    const timedOut = calls.filter(c => c.status === 'timed_out').length;
    const allDone = completed + timedOut === total;

    let header: string;
    if (allDone && timedOut === 0) {
      header = total === 1
        ? `🟢 작업 완료`
        : `🟢 ${total}개 작업 완료`;
    } else if (allDone) {
      header = `📊 ${total}개 작업 종료 (${completed} 완료, ${timedOut} 타임아웃)`;
    } else {
      header = `📊 ${total}개 작업 실행 중 (${completed}/${total} 완료)`;
    }

    // For single call, skip header redundancy
    if (total === 1) {
      const call = calls[0];
      return this.renderSingleCallText(call);
    }

    const lines = calls.map(call => this.renderCallLine(call));

    return `${header}\n\n${lines.join('\n')}`;
  }

  private renderSingleCallText(call: ActiveCallEntry): string {
    const params = call.config.paramsSummary ? ` ${call.config.paramsSummary}` : '';

    if (call.status === 'completed') {
      let text = `🟢 *${call.config.displayType} 완료: ${call.config.displayLabel}*${params}`;
      if (call.duration !== undefined) {
        text += ` (${McpCallTracker.formatDuration(call.duration)})`;
      }
      return text;
    }

    if (call.status === 'timed_out') {
      return `⏱️ *${call.config.displayType} 타임아웃: ${call.config.displayLabel}*${params} (2시간+)`;
    }

    // Running
    const elapsed = this.mcpCallTracker.getElapsedTime(call.callId);
    const elapsedMs = elapsed ?? (Date.now() - call.startTime);
    return this.buildRunningText(call, elapsedMs);
  }

  private renderCallLine(call: ActiveCallEntry): string {
    const params = call.config.paramsSummary ? ` ${call.config.paramsSummary}` : '';

    if (call.status === 'completed') {
      let line = `🟢 ${call.config.displayLabel}${params}`;
      if (call.duration !== undefined) {
        line += ` (${McpCallTracker.formatDuration(call.duration)})`;
      }
      return line;
    }

    if (call.status === 'timed_out') {
      return `⏱️ ${call.config.displayLabel}${params} (타임아웃)`;
    }

    // Running
    const elapsed = this.mcpCallTracker.getElapsedTime(call.callId);
    const elapsedMs = elapsed ?? (Date.now() - call.startTime);
    let line = `⏳ ${call.config.displayLabel}${params} — ${McpCallTracker.formatDuration(elapsedMs)}`;

    if (call.predicted !== null && call.predicted > 0) {
      const adaptive = McpCallTracker.computeAdaptivePrediction(elapsedMs, call.predicted);
      const progress = Math.min(100, (elapsedMs / adaptive.predicted) * 100);
      if (adaptive.wasAdjusted) {
        line += McpStatusDisplay.formatAdaptiveIndicator(adaptive.originalPredicted, adaptive.predicted);
      }
      const barLen = 20;
      const filled = Math.round((progress / 100) * barLen);
      const empty = barLen - filled;
      line += ` \`${'█'.repeat(filled)}${'░'.repeat(empty)}\``;
    }

    return line;
  }

  private buildRunningText(call: ActiveCallEntry, elapsedMs: number): string {
    const params = call.config.paramsSummary ? ` ${call.config.paramsSummary}` : '';
    let statusText = `⏳ *${call.config.displayType} 실행 중: ${call.config.displayLabel}*${params}`;
    statusText += `\n경과 시간: ${McpCallTracker.formatDuration(elapsedMs)}`;

    if (call.predicted !== null && call.predicted > 0) {
      const adaptive = McpCallTracker.computeAdaptivePrediction(elapsedMs, call.predicted);
      const remaining = Math.max(0, adaptive.predicted - elapsedMs);
      const progress = Math.min(100, (elapsedMs / adaptive.predicted) * 100);

      statusText += `\n예상 시간: ${McpCallTracker.formatDuration(adaptive.predicted)}`;
      if (adaptive.wasAdjusted) {
        statusText += McpStatusDisplay.formatAdaptiveIndicator(adaptive.originalPredicted, adaptive.predicted);
      }
      if (remaining > 0) {
        statusText += ` | 남은 시간: ~${McpCallTracker.formatDuration(remaining)}`;
      }
      statusText += `\n진행률: ${progress.toFixed(0)}%`;

      const progressBarLength = 20;
      const filledLength = Math.round((progress / 100) * progressBarLength);
      const emptyLength = progressBarLength - filledLength;
      const progressBar = '█'.repeat(filledLength) + '░'.repeat(emptyLength);
      statusText += ` \`${progressBar}\``;
    }

    return statusText;
  }

  private static formatAdaptiveIndicator(original: number, adjusted: number): string {
    return ` _🐢 ${McpCallTracker.formatDuration(original)} → ${McpCallTracker.formatDuration(adjusted)}_`;
  }
}
