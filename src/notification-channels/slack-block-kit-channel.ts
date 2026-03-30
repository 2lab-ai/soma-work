/**
 * Slack Block Kit notification channel — posts colored status message to thread.
 * Trace: docs/turn-notification/trace.md, Scenario 1 (Section 3c)
 * Trace: docs/rich-turn-notification/trace.md, Scenario 3
 * Always enabled — this is the default in-thread visual feedback.
 */

import { NotificationChannel, TurnCompletionEvent, getCategoryColor, getCategoryEmoji, getCategoryLabel } from '../turn-notifier.js';
import { CompletionMessageTracker } from '../slack/completion-message-tracker.js';
import { Logger } from '../logger.js';
import { SessionTheme, userSettingsStore } from '../user-settings-store.js';

const logger = new Logger('SlackBlockKitChannel');

export class SlackBlockKitChannel implements NotificationChannel {
  name = 'slack-block-kit';

  constructor(
    private slackApi: { postMessage: (channel: string, text: string, options?: any) => Promise<any> },
    private completionMessageTracker?: CompletionMessageTracker,
  ) {}

  async isEnabled(_userId: string): Promise<boolean> {
    return true; // Always enabled — core UX
  }

  async send(event: TurnCompletionEvent): Promise<void> {
    const color = getCategoryColor(event.category);
    const emoji = getCategoryEmoji(event.category);
    const label = getCategoryLabel(event.category);
    const text = `${emoji} *${label}*`;

    const theme = userSettingsStore.getUserSessionTheme(event.userId);
    const blocks = this.buildBlocksForTheme(theme, event, emoji, label);

    try {
      const result = await this.slackApi.postMessage(event.channel, text, {
        threadTs: event.threadTs,
        attachments: [{ color, blocks }],
      });

      // Track the actual posted notification message ts for auto-deletion.
      // Previously tracked in stream-executor using threadTs (thread root),
      // which for bot-initiated threads IS the surface/header message —
      // causing header deletion on next user input.
      // Trace: docs/turn-summary-lifecycle/trace.md, S6
      if (this.completionMessageTracker && result?.ts && event.category !== 'Exception') {
        const sessionKey = `${event.channel}-${event.threadTs}`;
        this.completionMessageTracker.track(sessionKey, result.ts, event.category);
      }
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

  // --- Theme dispatcher ---

  private buildBlocksForTheme(theme: SessionTheme, event: TurnCompletionEvent, emoji: string, label: string): any[] {
    switch (theme) {
      case 'default': return this.buildDefaultBlocks(event, emoji, label);
      case 'compact': return this.buildCompactBlocks(event, emoji, label);
      case 'minimal': return this.buildMinimalBlocks(event, emoji, label);
      default: return this.buildDefaultBlocks(event, emoji, label);
    }
  }

  // --- Theme: Default (Dashboard — richest) ---

  private buildDefaultBlocks(event: TurnCompletionEvent, emoji: string, label: string): any[] {
    const blocks: any[] = [
      { type: 'section', text: { type: 'mrkdwn', text: `${emoji} *${label}*${event.sessionTitle ? ` — ${event.sessionTitle}` : ''}` } },
    ];

    // context1: persona | model | startedAt
    const identParts: string[] = [];
    if (event.persona) identParts.push(`\`${event.persona}\``);
    if (event.model) identParts.push(`\`${event.model}\``);
    if (event.startedAt) identParts.push(this.formatClock(event.startedAt));
    if (identParts.length > 0) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: identParts.join(' | ') }] });
    }

    // context2: Ctx usage% + delta + Dur + 5h/7d usage
    const usageParts: string[] = [];
    if (typeof event.contextUsagePercent === 'number') {
      const tokensStr = typeof event.contextUsageTokens === 'number' && typeof event.contextWindowSize === 'number'
        ? `${this.formatTokens(event.contextUsageTokens)}/${this.formatTokens(event.contextWindowSize)} `
        : '';
      const deltaStr = this.formatSignedDelta(event.contextUsageDelta, 1);
      const deltaSuffix = deltaStr ? ` ${deltaStr}` : '';
      usageParts.push(`Ctx ${this.renderBar(event.contextUsagePercent, 5)} ${tokensStr}(${event.contextUsagePercent.toFixed(1)}%)${deltaSuffix}`);
    }
    if (event.durationMs) {
      usageParts.push(`Dur ${this.formatElapsed(event.durationMs)}`);
    }
    const has5h = typeof event.fiveHourUsage === 'number';
    const has7d = typeof event.sevenDayUsage === 'number';
    if (has5h) {
      const delta5h = this.formatSignedDelta(event.fiveHourDelta, 0);
      usageParts.push(`5h ${this.renderBar(event.fiveHourUsage!, 6)} ${Math.round(event.fiveHourUsage!)}%${delta5h ? ` ${delta5h}` : ''}`);
    }
    if (has7d) {
      const delta7d = this.formatSignedDelta(event.sevenDayDelta, 0);
      usageParts.push(`7d ${this.renderBar(event.sevenDayUsage!, 8)} ${Math.round(event.sevenDayUsage!)}%${delta7d ? ` ${delta7d}` : ''}`);
    }
    if (usageParts.length > 0) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: usageParts.join(' | ') }] });
    }

    // context3: tool stats
    if (event.toolStats && Object.keys(event.toolStats).length > 0) {
      const toolLine = this.formatToolStatsRich(event.toolStats);
      if (toolLine) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: toolLine }] });
    }

    return blocks;
  }

  // --- Theme: Compact ---

  private buildCompactBlocks(event: TurnCompletionEvent, emoji: string, label: string): any[] {
    const blocks: any[] = [
      { type: 'section', text: { type: 'mrkdwn', text: `${emoji} *${label}*${event.sessionTitle ? ` — ${event.sessionTitle}` : ''}` } },
    ];

    const parts: string[] = [];
    if (event.model) parts.push(`\`${event.model}\``);
    if (typeof event.contextUsagePercent === 'number') {
      parts.push(`Ctx ${event.contextUsagePercent.toFixed(1)}%`);
    }
    if (event.durationMs) parts.push(this.formatElapsed(event.durationMs));
    if (event.toolStats && Object.keys(event.toolStats).length > 0) {
      parts.push(this.formatToolStatsSummary(event.toolStats));
    }

    if (parts.length > 0) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: parts.join(' · ') }] });
    }

    return blocks;
  }

  // --- Theme: Minimal ---

  private buildMinimalBlocks(event: TurnCompletionEvent, emoji: string, label: string): any[] {
    const parts: string[] = [`${emoji} ${label}`];
    if (event.model) parts.push(event.model);
    if (typeof event.contextUsagePercent === 'number') parts.push(`${event.contextUsagePercent.toFixed(1)}%`);
    if (event.durationMs) parts.push(this.formatElapsed(event.durationMs));

    return [
      { type: 'context', elements: [{ type: 'mrkdwn', text: parts.join(' · ') }] },
    ];
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

  /**
   * Compact tool stats summary (tool count + total invocations) for lighter themes.
   */
  private formatToolStatsSummary(stats: Record<string, { count: number; totalDurationMs: number }>): string {
    const entries = Object.entries(stats);
    const totalCount = entries.reduce((sum, [, s]) => sum + s.count, 0);
    return `🔧 ${entries.length} tools×${totalCount}`;
  }
}
