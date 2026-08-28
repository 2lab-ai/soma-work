import { CommandParser } from '../command-parser';
import { ContextWindowManager } from '../context-window-manager';
import { ThreadHeaderBuilder } from '../thread-header-builder';
import type { CommandContext, CommandDependencies, CommandHandler, CommandResult } from './types';

/**
 * Handles /context command - displays current session context window usage
 */
export class ContextHandler implements CommandHandler {
  constructor(private deps: CommandDependencies) {}

  canHandle(text: string): boolean {
    return CommandParser.isContextCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { channel, threadTs } = ctx;

    const session = this.deps.claudeHandler.getSession(channel, threadTs);

    if (!session) {
      await this.deps.slackApi.postSystemMessage(
        channel,
        '💡 No active session in this thread. Start a conversation first!',
        { threadTs },
      );
      return { handled: true };
    }

    if (!session.usage) {
      await this.deps.slackApi.postSystemMessage(
        channel,
        '📊 *Session Context*\n\nNo usage data available yet. Send a message to start tracking.',
        { threadTs },
      );
      return { handled: true };
    }

    const usage = session.usage;

    // Calculate context window usage using single source of truth
    const currentContext = ContextWindowManager.computeUsedTokens(usage);
    const contextWindow = usage.contextWindow;
    const availablePercent = ContextWindowManager.computeRemainingPercent(usage);
    // Displayed as USED, matching the `X / Y` pair above it, the bar's fill,
    // and the turn-completion footer. This card used to print the remaining
    // share in the same shape the footer used for the consumed share, so the
    // two disagreed about the same session (issue #196). `availablePercent`
    // stays as the input to the low-context warning below, where "how much is
    // left" is the question actually being asked.
    const usedPercent = 100 - availablePercent;

    // Context bar visualization
    const contextBar = ThreadHeaderBuilder.formatContextBar(usage) || '░░░░░';

    const lines: string[] = ['📊 *Session Context*', ''];

    // Model info
    if (session.model) {
      lines.push(`*Model:* \`${ThreadHeaderBuilder.formatModelName(session.model)}\``);
    }

    // Current context window usage with visual bar
    lines.push(`*Context Window:* ${contextBar}`);
    lines.push(
      `  ${ThreadHeaderBuilder.formatTokenCount(currentContext)} / ${ThreadHeaderBuilder.formatTokenCount(contextWindow)} (${Number.isInteger(usedPercent) ? usedPercent : usedPercent.toFixed(1)}% used)`,
    );

    // Cache info
    if (usage.currentCacheReadTokens > 0 || usage.currentCacheCreateTokens > 0) {
      lines.push(`  • Cache read: ${ThreadHeaderBuilder.formatTokenCount(usage.currentCacheReadTokens)}`);
      lines.push(`  • Cache created: ${ThreadHeaderBuilder.formatTokenCount(usage.currentCacheCreateTokens)}`);
    }

    // Session totals (cumulative)
    lines.push('');
    lines.push('*Session Totals:*');
    lines.push(`  • Input: ${ThreadHeaderBuilder.formatTokenCount(usage.totalInputTokens)}`);
    lines.push(`  • Output: ${ThreadHeaderBuilder.formatTokenCount(usage.totalOutputTokens)}`);
    if (usage.totalCacheCreateTokens > 0) {
      lines.push(`  • Cache write: ${ThreadHeaderBuilder.formatTokenCount(usage.totalCacheCreateTokens)}`);
    }
    if (usage.totalCacheReadTokens > 0) {
      lines.push(`  • Cache read: ${ThreadHeaderBuilder.formatTokenCount(usage.totalCacheReadTokens)}`);
    }

    // Cost
    if (usage.totalCostUsd > 0) {
      lines.push(`  • Cost: $${usage.totalCostUsd.toFixed(4)}`);
    }

    // Per-model breakdown: real tokens and cost PER MODEL actually used in
    // this session (survives model switches — each bucket is priced at that
    // model's own rates).
    const modelTotals = usage.modelTotals;
    if (modelTotals && Object.keys(modelTotals).length > 0) {
      lines.push('');
      lines.push('*Per-Model Usage:*');
      for (const [model, t] of Object.entries(modelTotals)) {
        const fmt = ThreadHeaderBuilder.formatTokenCount;
        lines.push(
          `  • \`${model}\` — in ${fmt(t.inputTokens)} · out ${fmt(t.outputTokens)} · cache w ${fmt(t.cacheCreateTokens)} · cache r ${fmt(t.cacheReadTokens)} · $${t.costUsd.toFixed(4)}`,
        );
      }
    }

    // Warning if context is getting full
    if (availablePercent < 20) {
      lines.push('');
      lines.push('⚠️ Context running low! Consider using `/renew` to save and reset.');
    }

    await this.deps.slackApi.postSystemMessage(channel, lines.join('\n'), { threadTs });

    return { handled: true };
  }
}
