/**
 * Slack Block Kit notification channel — posts colored status message to thread.
 * Trace: docs/turn-notification/trace.md, Scenario 1 (Section 3c)
 * Trace: docs/rich-turn-notification/trace.md, Scenario 3
 * Always enabled — this is the default in-thread visual feedback.
 */

import { NotificationChannel, TurnCompletionEvent, getCategoryColor, getCategoryEmoji, getCategoryLabel } from '../turn-notifier.js';
import { Logger } from '../logger.js';

const logger = new Logger('SlackBlockKitChannel');

export class SlackBlockKitChannel implements NotificationChannel {
  name = 'slack-block-kit';

  constructor(
    private slackApi: { postMessage: (channel: string, text: string, options?: any) => Promise<any> },
  ) {}

  async isEnabled(_userId: string): Promise<boolean> {
    return true; // Always enabled — core UX
  }

  async send(event: TurnCompletionEvent): Promise<void> {
    const color = getCategoryColor(event.category);
    const emoji = getCategoryEmoji(event.category);
    const label = getCategoryLabel(event.category);
    const text = `${emoji} *${label}*`;

    const hasRichData = event.persona || event.model || event.startedAt || event.contextUsagePercent != null;
    const blocks: any[] = [
      { type: 'section', text: { type: 'mrkdwn', text } },
    ];

    if (hasRichData) {
      // Rich format — Trace: docs/rich-turn-notification/trace.md, Scenario 3
      const lines = this.buildRichLines(event);
      if (lines.length > 0) {
        blocks.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: lines.join('\n') }],
        });
      }
    } else {
      // Fallback: simple format (backward compatible)
      const contextParts: string[] = [];
      if (event.sessionTitle) contextParts.push(`세션: ${event.sessionTitle}`);
      if (event.durationMs) contextParts.push(`소요: ${Math.round(event.durationMs / 1000)}s`);
      if (contextParts.length > 0) {
        blocks.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: contextParts.join(' | ') }],
        });
      }
    }

    try {
      await this.slackApi.postMessage(event.channel, text, {
        threadTs: event.threadTs,
        attachments: [{ color, blocks }],
      });
    } catch (error: any) {
      logger.warn('Failed to post Block Kit notification', {
        channel: event.channel,
        threadTs: event.threadTs,
        userId: event.userId,
        category: event.category,
        error: error.message,
      });
    }
  }

  // --- Rich format builders ---

  private buildRichLines(event: TurnCompletionEvent): string[] {
    const lines: string[] = [];

    // Line 1: persona | model
    if (event.persona || event.model) {
      const parts: string[] = [];
      if (event.persona) parts.push(` \`${event.persona}\` `);
      if (event.model) parts.push(` \`${event.model}\` `);
      lines.push(parts.join(' | '));
    }

    // Line 2: session title
    if (event.sessionTitle) {
      lines.push(`세션: ${event.sessionTitle}`);
    }

    // Line 3: clock range
    if (event.startedAt && event.durationMs) {
      const endedAt = new Date(event.startedAt.getTime() + event.durationMs);
      lines.push(
        `:alarm_clock: ${this.formatClock(event.startedAt)} → ${this.formatClock(endedAt)} (${this.formatElapsed(event.durationMs)})`
      );
    }

    // Line 4: context usage
    if (typeof event.contextUsagePercent === 'number') {
      const tokensStr = typeof event.contextUsageTokens === 'number' && typeof event.contextWindowSize === 'number'
        ? `${this.formatTokens(event.contextUsageTokens)}/${this.formatTokens(event.contextWindowSize)} `
        : '';
      const deltaStr = this.formatSignedDelta(event.contextUsageDelta, 1);
      const deltaSuffix = deltaStr ? ` ${deltaStr}` : '';
      lines.push(
        `Ctx  ${this.renderBar(event.contextUsagePercent, 5)} ${tokensStr}(${event.contextUsagePercent.toFixed(1)}%)${deltaSuffix}`
      );
    }

    // Line 5: 5h/7d usage (conditional)
    const has5h = typeof event.fiveHourUsage === 'number';
    const has7d = typeof event.sevenDayUsage === 'number';
    if (has5h || has7d) {
      const parts: string[] = [];
      if (has5h) {
        const delta5h = this.formatSignedDelta(event.fiveHourDelta, 0);
        parts.push(`5h ${this.renderBar(event.fiveHourUsage!, 6)} ${Math.round(event.fiveHourUsage!)}%${delta5h ? ` ${delta5h}` : ''}`);
      }
      if (has7d) {
        const delta7d = this.formatSignedDelta(event.sevenDayDelta, 0);
        parts.push(`7d ${this.renderBar(event.sevenDayUsage!, 8)} ${Math.round(event.sevenDayUsage!)}%${delta7d ? ` ${delta7d}` : ''}`);
      }
      lines.push(parts.join(' | '));
    }

    // Line 6: tool stats (conditional)
    if (event.toolStats && Object.keys(event.toolStats).length > 0) {
      const toolLine = this.formatToolStatsRich(event.toolStats);
      if (toolLine) lines.push(toolLine);
    }

    return lines;
  }

  // --- Utility functions ---

  private formatClock(date: Date): string {
    return date.toLocaleTimeString('ko-KR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
  }

  private formatElapsed(durationMs: number): string {
    const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  private renderBar(percent: number, width: number): string {
    const clamped = Math.max(0, Math.min(100, percent));
    const filled = Math.round((clamped / 100) * width);
    return '▓'.repeat(filled) + '░'.repeat(width - filled);
  }

  private formatTokens(tokens: number): string {
    if (tokens >= 1_000_000) {
      const val = tokens / 1_000_000;
      return Number.isInteger(val) ? `${val}M` : `${val.toFixed(1)}M`;
    }
    const val = tokens / 1_000;
    return `${val.toFixed(1)}k`;
  }

  private formatSignedDelta(delta: number | undefined, decimals: number): string | undefined {
    if (typeof delta !== 'number' || !Number.isFinite(delta)) return undefined;
    const sign = delta >= 0 ? '+' : '';
    return decimals > 0 ? `${sign}${delta.toFixed(decimals)}` : `${sign}${Math.round(delta)}`;
  }

  private formatToolStatsRich(stats: Record<string, { count: number; totalDurationMs: number }>): string | undefined {
    const entries = Object.entries(stats)
      .sort((a, b) => b[1].totalDurationMs - a[1].totalDurationMs);
    if (entries.length === 0) return undefined;

    const parts = entries
      .slice(0, 5)
      .map(([name, s]) => {
        const shortName = name.startsWith('mcp__')
          ? name.split('__').slice(1, 3).join(':')
          : name;
        const durationSec = (s.totalDurationMs / 1000).toFixed(1);
        return `${shortName}×${s.count}: ${durationSec}s`;
      });

    if (entries.length > 5) {
      const remaining = entries.slice(5).reduce((sum, [, s]) => sum + s.count, 0);
      parts.push(`+${remaining} more`);
    }

    return `:wrench: ${parts.join(' | ')}`;
  }
}
