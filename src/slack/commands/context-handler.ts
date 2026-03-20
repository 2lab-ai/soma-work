import { CommandHandler, CommandContext, CommandResult, CommandDependencies } from './types';
import { CommandParser } from '../command-parser';
import { ContextWindowManager } from '../context-window-manager';
import { ThreadHeaderBuilder } from '../thread-header-builder';

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
      await this.deps.slackApi.postSystemMessage(channel,
        '💡 No active session in this thread. Start a conversation first!',
        { threadTs }
      );
      return { handled: true };
    }

    if (!session.usage) {
      await this.deps.slackApi.postSystemMessage(channel,
        '📊 *Session Context*\n\nNo usage data available yet. Send a message to start tracking.',
        { threadTs }
      );
      return { handled: true };
    }

    const usage = session.usage;

    // Calculate context window usage using single source of truth
    const currentContext = usage.currentInputTokens + usage.currentOutputTokens;
    const contextWindow = usage.contextWindow;
    const availablePercent = ContextWindowManager.computeRemainingPercent(usage);

    // Context bar visualization
    const contextBar = ThreadHeaderBuilder.formatContextBar(usage) || '░░░░░';

    const lines: string[] = [
      '📊 *Session Context*',
      '',
    ];

    // Model info
    if (session.model) {
      lines.push(`*Model:* \`${ThreadHeaderBuilder.formatModelName(session.model)}\``);
    }

    // Current context window usage with visual bar
    lines.push(`*Context Window:* ${contextBar}`);
    lines.push(`  ${ThreadHeaderBuilder.formatTokenCount(currentContext)} / ${ThreadHeaderBuilder.formatTokenCount(contextWindow)} (${availablePercent.toFixed(0)}% available)`);

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

    // Cost
    if (usage.totalCostUsd > 0) {
      lines.push(`  • Cost: $${usage.totalCostUsd.toFixed(4)}`);
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
