import { isRejectedModelInput, resolveModelInputCompatibility } from '../../metrics/model-profile';
import {
  formatTokens,
  isAutoCompactReset,
  parseAutoCompactTokens,
  resolveEffectiveAutoCompact,
  validateAutoCompactTokensForModel,
} from '../../session/autocompact-policy';
import { CommandParser } from '../command-parser';
import type { CommandContext, CommandDependencies, CommandHandler, CommandResult } from './types';

export class AutoCompactHandler implements CommandHandler {
  constructor(private deps: CommandDependencies) {}

  canHandle(text: string): boolean {
    return CommandParser.isAutoCompactCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { channel, threadTs, text, user } = ctx;
    const session = this.deps.claudeHandler.getSession(channel, threadTs);
    if (!session) {
      await this.deps.slackApi.postSystemMessage(channel, '💡 No active session. Start a conversation first.', {
        threadTs,
      });
      return { handled: true };
    }

    const compatibility = resolveModelInputCompatibility(session.model ?? '');
    if (compatibility && isRejectedModelInput(compatibility)) {
      await this.deps.slackApi.postSystemMessage(
        channel,
        `❌ ${compatibility.rejectedReason} Use \`${compatibility.suggestedModel}\`.`,
        { threadTs },
      );
      return { handled: true };
    }

    const { rawArg } = CommandParser.parseAutoCompactCommand(text);
    if (rawArg === undefined) {
      const effective = resolveEffectiveAutoCompact(session, user, this.deps.userSettingsStore);
      await this.deps.slackApi.postSystemMessage(
        channel,
        `Auto-compact: ${formatTokens(effective.tokens)} tokens (${effective.source}, model \`${session.model ?? 'default'}\`)`,
        { threadTs },
      );
      return { handled: true };
    }

    if (isAutoCompactReset(rawArg)) {
      session.autoCompactTokens = null;
      this.deps.claudeHandler.saveSessions();
      const effective = resolveEffectiveAutoCompact(session, user, this.deps.userSettingsStore);
      await this.deps.slackApi.postSystemMessage(
        channel,
        `Auto-compact reset: ${formatTokens(effective.tokens)} tokens (${effective.source}, model \`${session.model ?? 'default'}\`)`,
        { threadTs },
      );
      return { handled: true };
    }

    const tokens = parseAutoCompactTokens(rawArg);
    if (tokens === null) {
      await this.deps.slackApi.postSystemMessage(
        channel,
        '❌ Invalid threshold. Use 100k–1M (for example `autocompact 800k`) or `autocompact reset`.',
        { threadTs },
      );
      return { handled: true };
    }
    const validation = validateAutoCompactTokensForModel(tokens, session.model);
    if (!validation.ok) {
      await this.deps.slackApi.postSystemMessage(channel, `❌ ${validation.message}`, { threadTs });
      return { handled: true };
    }

    session.autoCompactTokens = validation.tokens;
    this.deps.claudeHandler.saveSessions();
    await this.deps.slackApi.postSystemMessage(
      channel,
      `Auto-compact updated to ${formatTokens(validation.tokens)} tokens for this session.`,
      { threadTs },
    );
    return { handled: true };
  }
}
