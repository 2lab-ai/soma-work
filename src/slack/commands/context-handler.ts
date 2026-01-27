import { CommandHandler, CommandContext, CommandResult, CommandDependencies } from './types';
import { CommandParser } from '../command-parser';

/**
 * Handles /context command - displays current session context window usage
 */
export class ContextHandler implements CommandHandler {
  constructor(private deps: CommandDependencies) {}

  canHandle(text: string): boolean {
    return CommandParser.isContextCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { channel, threadTs, say } = ctx;

    const session = this.deps.claudeHandler.getSession(channel, threadTs);

    if (!session) {
      await say({
        text: '💡 No active session in this thread. Start a conversation first!',
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    if (!session.usage) {
      await say({
        text: '📊 *Session Context*\n\nNo usage data available yet. Send a message to start tracking.',
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    const usage = session.usage;

    // Format token counts with K notation
    const formatTokens = (n: number): string => {
      if (n >= 1000) {
        return `${(n / 1000).toFixed(1)}k`;
      }
      return n.toString();
    };

    // Calculate context window usage
    // Context = input (previous history + current message) + output (current response)
    // This is the approximate context size for the next request
    const currentContext = usage.currentInputTokens + usage.currentOutputTokens;
    const contextWindow = usage.contextWindow;
    const availablePercent = Math.max(0, ((contextWindow - currentContext) / contextWindow) * 100);

    const lines: string[] = [
      '📊 *Session Context*',
      '',
    ];

    // Model info
    if (session.model) {
      lines.push(`*Model:* \`${session.model}\``);
    }

    // Current context window usage (what user wants to see!)
    lines.push(`*Context Window:* ${formatTokens(currentContext)} / ${formatTokens(contextWindow)} (${availablePercent.toFixed(0)}% available)`);

    // Cache info
    if (usage.currentCacheReadTokens > 0 || usage.currentCacheCreateTokens > 0) {
      lines.push(`  • Cache read: ${formatTokens(usage.currentCacheReadTokens)}`);
      lines.push(`  • Cache created: ${formatTokens(usage.currentCacheCreateTokens)}`);
    }

    // Session totals (cumulative)
    lines.push('');
    lines.push('*Session Totals:*');
    lines.push(`  • Input: ${formatTokens(usage.totalInputTokens)}`);
    lines.push(`  • Output: ${formatTokens(usage.totalOutputTokens)}`);

    // Cost
    if (usage.totalCostUsd > 0) {
      lines.push(`  • Cost: $${usage.totalCostUsd.toFixed(4)}`);
    }

    // Warning if context is getting full
    if (availablePercent < 20) {
      lines.push('');
      lines.push('⚠️ Context running low! Consider using `/renew` to save and reset.');
    }

    await say({
      text: lines.join('\n'),
      thread_ts: threadTs,
    });

    return { handled: true };
  }
}
