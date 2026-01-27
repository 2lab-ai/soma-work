import { CommandHandler, CommandContext, CommandResult, CommandDependencies } from './types';
import { CommandParser } from '../command-parser';

/**
 * Handles /context command - displays current session token usage
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
    const totalTokens = usage.inputTokens + usage.outputTokens;
    const availablePercent = Math.max(0, ((usage.contextWindow - totalTokens) / usage.contextWindow) * 100);

    // Format token counts with K notation
    const formatTokens = (n: number): string => {
      if (n >= 1000) {
        return `${(n / 1000).toFixed(1)}k`;
      }
      return n.toString();
    };

    const lines: string[] = [
      '📊 *Session Context*',
      '',
    ];

    // Model info
    if (session.model) {
      lines.push(`*Model:* \`${session.model}\``);
    }

    // Token usage
    lines.push(
      `*Tokens:* ${formatTokens(totalTokens)} / ${formatTokens(usage.contextWindow)} (${availablePercent.toFixed(0)}% available)`
    );
    lines.push(`  • Input: ${formatTokens(usage.inputTokens)}`);

    if (usage.cacheReadInputTokens > 0) {
      lines.push(`    (cache read: ${formatTokens(usage.cacheReadInputTokens)})`);
    }
    if (usage.cacheCreationInputTokens > 0) {
      lines.push(`    (cache created: ${formatTokens(usage.cacheCreationInputTokens)})`);
    }

    lines.push(`  • Output: ${formatTokens(usage.outputTokens)}`);

    // Cost
    if (usage.totalCostUsd > 0) {
      lines.push(`*Cost:* $${usage.totalCostUsd.toFixed(4)}`);
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
