import { formatTokens, validateAutoCompactTokensForModel } from '../../session/autocompact-policy';
import { COMPACT_THRESHOLD_MAX, COMPACT_THRESHOLD_MIN, validateCompactThreshold } from '../../user-settings-store';
import { CommandParser } from '../command-parser';
import type { CommandContext, CommandDependencies, CommandHandler, CommandResult } from './types';

/** Deprecated percent adapter: writes the current session token override. */
export class CompactThresholdHandler implements CommandHandler {
  constructor(private deps: CommandDependencies) {}

  canHandle(text: string): boolean {
    return CommandParser.isCompactThresholdCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { channel, threadTs, text, user } = ctx;
    const { rawArg } = CommandParser.parseCompactThresholdCommand(text);

    if (rawArg === undefined) {
      const current = this.deps.userSettingsStore.getUserCompactThreshold(user);
      await this.deps.slackApi.postSystemMessage(
        channel,
        `Current legacy threshold: ${current}% (deprecated — use \`autocompact\`)`,
        { threadTs },
      );
      return { handled: true };
    }

    const session = this.deps.claudeHandler.getSession(channel, threadTs);
    if (!session) {
      await this.deps.slackApi.postSystemMessage(
        channel,
        '💡 No active session. Use `autocompact` after starting a conversation.',
        { threadTs },
      );
      return { handled: true };
    }

    try {
      const pct = validateCompactThreshold(Number(rawArg));
      const contextWindow =
        session.usage?.contextWindow ||
        (await import('../../metrics/model-profile')).resolveModelProfile(session.model).contextWindow;
      const tokens = Math.round((contextWindow * pct) / 100);
      const validation = validateAutoCompactTokensForModel(tokens, session.model);
      if (!validation.ok) {
        await this.deps.slackApi.postSystemMessage(
          channel,
          `❌ ${validation.message} Use \`autocompact <tokens>\` instead.`,
          { threadTs },
        );
        return { handled: true };
      }
      session.autoCompactTokens = validation.tokens;
      this.deps.userSettingsStore.clearUserCompactThreshold(user);
      this.deps.claudeHandler.saveSessions();
      await this.deps.slackApi.postSystemMessage(
        channel,
        `Deprecated percentage converted: ${pct}% → ${formatTokens(validation.tokens)} tokens for this session. Use \`autocompact\` going forward.`,
        { threadTs },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'invalid compactThreshold';
      await this.deps.slackApi.postSystemMessage(
        channel,
        `❌ ${msg} (allowed range: ${COMPACT_THRESHOLD_MIN}–${COMPACT_THRESHOLD_MAX})`,
        { threadTs },
      );
    }
    return { handled: true };
  }
}
