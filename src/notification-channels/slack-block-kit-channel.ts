/**
 * Slack Block Kit notification channel — posts colored status message to thread.
 * Trace: docs/turn-notification/trace.md, Scenario 1 (Section 3c)
 * Trace: docs/rich-turn-notification/trace.md, Scenario 3
 * Always enabled — this is the default in-thread visual feedback.
 */

import { NotificationChannel, TurnCompletionEvent, getCategoryColor, getCategoryEmoji, getCategoryLabel } from '../turn-notifier.js';
import { Logger } from '../logger.js';
import { SessionTheme, userSettingsStore } from '../user-settings-store.js';

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

    const theme = userSettingsStore.getUserSessionTheme(event.userId);
    const blocks = this.buildBlocksForTheme(theme, event, emoji, label);

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

  // --- Theme dispatcher ---

  private buildBlocksForTheme(theme: SessionTheme, event: TurnCompletionEvent, emoji: string, label: string): any[] {
    switch (theme) {
      case 'A': return this.buildMinimalBlocks(event, emoji, label);
      case 'B': return this.buildOneLineBlocks(event, emoji, label);
      case 'C': return this.buildCompactBlocks(event, emoji, label);
      case 'D': return this.buildClassicBlocks(event, emoji, label);
      case 'E': return this.buildDashboardBlocks(event, emoji, label);
      case 'F': return this.buildStatusBarBlocks(event, emoji, label);
      case 'G': return this.buildRichCardBlocks(event, emoji, label);
      case 'H': return this.buildTableBlocks(event, emoji, label);
      case 'I': return this.buildKanbanBlocks(event, emoji, label);
      case 'J': return this.buildTimelineBlocks(event, emoji, label);
      case 'K': return this.buildProgressBlocks(event, emoji, label);
      case 'L': return this.buildNotificationBlocks(event, emoji, label);
      default: return this.buildClassicBlocks(event, emoji, label);
    }
  }

  // --- Theme A: Minimal ---

  private buildMinimalBlocks(event: TurnCompletionEvent, emoji: string, label: string): any[] {
    const parts: string[] = [`${emoji} ${label}`];
    if (event.model) parts.push(event.model);
    if (event.durationMs) parts.push(this.formatElapsed(event.durationMs));
    if (typeof event.contextUsagePercent === 'number') parts.push(`${event.contextUsagePercent.toFixed(1)}%`);

    return [
      { type: 'context', elements: [{ type: 'mrkdwn', text: parts.join(' · ') }] },
    ];
  }

  // --- Theme B: One-Liner ---

  private buildOneLineBlocks(event: TurnCompletionEvent, emoji: string, label: string): any[] {
    const parts: string[] = [`${emoji} ${label}`];
    if (event.model) parts.push(event.model);
    if (event.sessionTitle) parts.push(event.sessionTitle);
    if (event.durationMs) parts.push(this.formatElapsed(event.durationMs));
    if (typeof event.contextUsagePercent === 'number') parts.push(`${event.contextUsagePercent.toFixed(1)}%`);

    return [
      { type: 'context', elements: [{ type: 'mrkdwn', text: parts.join(' · ') }] },
    ];
  }

  // --- Theme C: Compact ---

  private buildCompactBlocks(event: TurnCompletionEvent, emoji: string, label: string): any[] {
    const blocks: any[] = [
      { type: 'section', text: { type: 'mrkdwn', text: `${emoji} *${label}*` } },
    ];

    const parts: string[] = [];
    if (event.model) parts.push(`\`${event.model}\``);
    if (event.durationMs) parts.push(this.formatElapsed(event.durationMs));
    if (typeof event.contextUsagePercent === 'number') {
      const tokensStr = typeof event.contextUsageTokens === 'number' && typeof event.contextWindowSize === 'number'
        ? `${this.formatTokens(event.contextUsageTokens)}/${this.formatTokens(event.contextWindowSize)} `
        : '';
      parts.push(`Ctx ${tokensStr}${event.contextUsagePercent.toFixed(1)}%`);
    }
    if (event.toolStats && Object.keys(event.toolStats).length > 0) {
      parts.push(this.formatToolStatsSummary(event.toolStats));
    }

    if (parts.length > 0) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: parts.join(' · ') }] });
    }

    return blocks;
  }

  // --- Theme D: Classic (CURRENT implementation) ---

  private buildClassicBlocks(event: TurnCompletionEvent, emoji: string, label: string): any[] {
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

    return blocks;
  }

  // --- Theme E: Dashboard ---

  private buildDashboardBlocks(event: TurnCompletionEvent, emoji: string, label: string): any[] {
    const blocks: any[] = [
      { type: 'section', text: { type: 'mrkdwn', text: `${emoji} *${label}*` } },
    ];

    // context1: persona | model
    if (event.persona || event.model) {
      const parts: string[] = [];
      if (event.persona) parts.push(`\`${event.persona}\``);
      if (event.model) parts.push(`\`${event.model}\``);
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: parts.join(' | ') }] });
    }

    // context2: session title
    if (event.sessionTitle) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `세션: ${event.sessionTitle}` }] });
    }

    // context3: time range
    if (event.startedAt && event.durationMs) {
      const endedAt = new Date(event.startedAt.getTime() + event.durationMs);
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `⏱ ${this.formatClock(event.startedAt)}→${this.formatClock(endedAt)} (${this.formatElapsed(event.durationMs)})` }],
      });
    }

    // context4: context usage
    if (typeof event.contextUsagePercent === 'number') {
      const tokensStr = typeof event.contextUsageTokens === 'number' && typeof event.contextWindowSize === 'number'
        ? `${this.formatTokens(event.contextUsageTokens)}/${this.formatTokens(event.contextWindowSize)} `
        : '';
      const deltaStr = this.formatSignedDelta(event.contextUsageDelta, 1);
      const deltaSuffix = deltaStr ? ` ${deltaStr}` : '';
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `Ctx ${this.renderBar(event.contextUsagePercent, 5)} ${tokensStr}(${event.contextUsagePercent.toFixed(1)}%)${deltaSuffix}` }],
      });
    }

    // context5: 5h/7d usage
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
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: parts.join(' | ') }] });
    }

    // context6: tool stats
    if (event.toolStats && Object.keys(event.toolStats).length > 0) {
      const toolLine = this.formatToolStatsRich(event.toolStats);
      if (toolLine) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: toolLine }] });
    }

    return blocks;
  }

  // --- Theme F: Status Bar ---

  private buildStatusBarBlocks(event: TurnCompletionEvent, _emoji: string, label: string): any[] {
    const sectionText = `🟢 *${label}*${event.sessionTitle ? ` — ${event.sessionTitle}` : ''}`;
    const blocks: any[] = [
      { type: 'section', text: { type: 'mrkdwn', text: sectionText } },
    ];

    const parts: string[] = [];
    if (event.model) parts.push(event.model);
    if (event.durationMs) parts.push(`⏱ ${this.formatElapsed(event.durationMs)}`);
    if (typeof event.contextUsagePercent === 'number') parts.push(`Ctx ${event.contextUsagePercent.toFixed(1)}%`);
    if (event.toolStats && Object.keys(event.toolStats).length > 0) {
      parts.push(this.formatToolStatsSummary(event.toolStats));
    }

    if (parts.length > 0) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: parts.join(' · ') }] });
    }

    return blocks;
  }

  // --- Theme G: Rich Card ---

  private buildRichCardBlocks(event: TurnCompletionEvent, emoji: string, label: string): any[] {
    const blocks: any[] = [
      { type: 'section', text: { type: 'mrkdwn', text: `${emoji} *${label}*` } },
    ];

    // context1: persona | model · session title
    const line1Parts: string[] = [];
    if (event.persona) line1Parts.push(`\`${event.persona}\``);
    if (event.model) line1Parts.push(`\`${event.model}\``);
    const line1Base = line1Parts.join(' | ');
    const line1 = event.sessionTitle ? `${line1Base} · 세션: ${event.sessionTitle}` : line1Base;
    if (line1) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: line1 }] });
    }

    // context2: time range · ctx bar · rate limits
    const line2Parts: string[] = [];
    if (event.startedAt && event.durationMs) {
      const endedAt = new Date(event.startedAt.getTime() + event.durationMs);
      line2Parts.push(`⏱ ${this.formatClock(event.startedAt)}→${this.formatClock(endedAt)}`);
    }
    if (typeof event.contextUsagePercent === 'number') {
      line2Parts.push(`Ctx ${this.renderBar(event.contextUsagePercent, 5)} ${event.contextUsagePercent.toFixed(1)}%`);
    }
    const has5h = typeof event.fiveHourUsage === 'number';
    const has7d = typeof event.sevenDayUsage === 'number';
    if (has5h || has7d) {
      const rateParts: string[] = [];
      if (has5h) rateParts.push(`5h ${Math.round(event.fiveHourUsage!)}%`);
      if (has7d) rateParts.push(`7d ${Math.round(event.sevenDayUsage!)}%`);
      line2Parts.push(rateParts.join(' | '));
    }
    if (line2Parts.length > 0) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: line2Parts.join(' · ') }] });
    }

    // context3: tools
    if (event.toolStats && Object.keys(event.toolStats).length > 0) {
      const toolLine = this.formatToolStatsRich(event.toolStats);
      if (toolLine) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: toolLine }] });
    }

    return blocks;
  }

  // --- Theme H: Table ---

  private buildTableBlocks(event: TurnCompletionEvent, emoji: string, label: string): any[] {
    const blocks: any[] = [
      { type: 'section', text: { type: 'mrkdwn', text: `${emoji} *${label}*` } },
    ];

    const fields: any[] = [];
    if (event.model) {
      fields.push({ type: 'mrkdwn', text: `*모델*\n${event.model}` });
    }
    if (event.durationMs) {
      fields.push({ type: 'mrkdwn', text: `*소요*\n${this.formatElapsed(event.durationMs)}` });
    }
    if (typeof event.contextUsagePercent === 'number') {
      fields.push({ type: 'mrkdwn', text: `*컨텍스트*\n${this.renderBar(event.contextUsagePercent, 5)} ${event.contextUsagePercent.toFixed(1)}%` });
    }
    if (event.toolStats && Object.keys(event.toolStats).length > 0) {
      fields.push({ type: 'mrkdwn', text: `*도구*\n${this.formatToolStatsSummary(event.toolStats)}` });
    }

    if (fields.length > 0) {
      blocks.push({ type: 'section', fields });
    }

    return blocks;
  }

  // --- Theme I: Kanban ---

  private buildKanbanBlocks(event: TurnCompletionEvent, emoji: string, label: string): any[] {
    const sectionText = event.sessionTitle
      ? `${emoji} *${label}* · ${event.sessionTitle}`
      : `${emoji} *${label}*`;
    const blocks: any[] = [
      { type: 'section', text: { type: 'mrkdwn', text: sectionText } },
    ];

    const parts: string[] = [];
    if (event.model) parts.push(event.model);
    if (event.durationMs) parts.push(this.formatElapsed(event.durationMs));
    if (typeof event.contextUsagePercent === 'number') parts.push(`${event.contextUsagePercent.toFixed(1)}%`);
    if (event.toolStats && Object.keys(event.toolStats).length > 0) {
      parts.push(this.formatToolStatsSummary(event.toolStats));
    }

    if (parts.length > 0) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: parts.join(' · ') }] });
    }

    return blocks;
  }

  // --- Theme J: Timeline ---

  private buildTimelineBlocks(event: TurnCompletionEvent, emoji: string, label: string): any[] {
    const blocks: any[] = [];

    // Time anchor context
    if (event.startedAt && event.durationMs) {
      const endedAt = new Date(event.startedAt.getTime() + event.durationMs);
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `🕐 ${this.formatClock(event.startedAt)} → ${this.formatClock(endedAt)}` }],
      });
    }

    // Section
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `${emoji} *${label}*` } });

    // Detail context
    const parts: string[] = [];
    if (event.model) parts.push(event.model);
    if (typeof event.contextUsagePercent === 'number') {
      parts.push(`Ctx ${this.renderBar(event.contextUsagePercent, 5)} ${event.contextUsagePercent.toFixed(1)}%`);
    }
    if (event.toolStats && Object.keys(event.toolStats).length > 0) {
      parts.push(this.formatToolStatsSummary(event.toolStats));
    }

    if (parts.length > 0) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: parts.join(' · ') }] });
    }

    return blocks;
  }

  // --- Theme K: Progress ---

  private buildProgressBlocks(event: TurnCompletionEvent, emoji: string, label: string): any[] {
    const sectionText = event.model
      ? `${emoji} *${label}* · ${event.model}`
      : `${emoji} *${label}*`;
    const blocks: any[] = [
      { type: 'section', text: { type: 'mrkdwn', text: sectionText } },
    ];

    // Progress bar section
    const progressParts: string[] = [];
    if (typeof event.contextUsagePercent === 'number') {
      progressParts.push(`\`${this.renderBar(event.contextUsagePercent, 10)}\` ${event.contextUsagePercent.toFixed(1)}%`);
    }
    if (event.durationMs) {
      progressParts.push(this.formatElapsed(event.durationMs));
    }
    if (progressParts.length > 0) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: progressParts.join(' · ') } });
    }

    // Context: rate limits + tools
    const ctxParts: string[] = [];
    const has5h = typeof event.fiveHourUsage === 'number';
    const has7d = typeof event.sevenDayUsage === 'number';
    if (has5h) ctxParts.push(`5h ${Math.round(event.fiveHourUsage!)}%`);
    if (has7d) ctxParts.push(`7d ${Math.round(event.sevenDayUsage!)}%`);
    if (event.toolStats && Object.keys(event.toolStats).length > 0) {
      ctxParts.push(this.formatToolStatsSummary(event.toolStats));
    }

    if (ctxParts.length > 0) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: ctxParts.join(' · ') }] });
    }

    return blocks;
  }

  // --- Theme L: Notification ---

  private buildNotificationBlocks(event: TurnCompletionEvent, emoji: string, label: string): any[] {
    const lines: string[] = [`${emoji} *${label}*이(가) 완료되었습니다`];

    if (event.model || event.durationMs) {
      const parts: string[] = [];
      if (event.model) parts.push(`🤖 ${event.model}`);
      if (event.durationMs) parts.push(this.formatElapsed(event.durationMs));
      lines.push(`> ${parts.join(' · ')}`);
    }

    if (typeof event.contextUsagePercent === 'number') {
      lines.push(`> Ctx ${this.renderBar(event.contextUsagePercent, 5)} ${event.contextUsagePercent.toFixed(1)}%`);
    }

    if (event.toolStats && Object.keys(event.toolStats).length > 0) {
      const toolLine = this.formatToolStatsSummary(event.toolStats);
      lines.push(`> 🔧 ${toolLine}`);
    }

    return [
      { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
    ];
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

  /**
   * Compact tool stats summary (tool count + total invocations) for lighter themes.
   */
  private formatToolStatsSummary(stats: Record<string, { count: number; totalDurationMs: number }>): string {
    const entries = Object.entries(stats);
    const totalCount = entries.reduce((sum, [, s]) => sum + s.count, 0);
    return `🔧 ${entries.length} tools×${totalCount}`;
  }
}
