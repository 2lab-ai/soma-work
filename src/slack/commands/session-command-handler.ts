import {
  DEFAULT_EFFORT,
  DEFAULT_SHOW_THINKING,
  DEFAULT_THINKING_ENABLED,
  EFFORT_LEVELS,
  MODEL_ALIASES,
  type ModelId,
  userSettingsStore,
} from '../../user-settings-store';
import { formatBytes as formatBytesUtil, getDirSizeBytes } from '../../utils/dir-size';
import { CommandParser } from '../command-parser';
import { getVerbosityFlags, getVerbosityName, LOG_DETAIL, VERBOSITY_NAMES } from '../output-flags';
import type { CommandContext, CommandDependencies, CommandHandler, CommandResult } from './types';

/**
 * Handles `%` prefix commands for current-session-only settings.
 * The legacy `$` prefix is still accepted during a deprecation grace period and emits a
 * one-line notice so users migrate off `$`. `$` is now primarily used for forced skill
 * invocation (see `SkillForceHandler`).
 *
 * - `%` → show session info
 * - `%model [value]` → get/set session model (no persistence)
 * - `%verbosity [value]` → get/set session verbosity (no persistence)
 * - `%effort [value]` → get/set session effort
 * - `%thinking [on|off]` → toggle extended thinking
 * - `%thinking_summary [on|off]` → toggle thinking output display
 */
export class SessionCommandHandler implements CommandHandler {
  constructor(private deps: CommandDependencies) {}

  canHandle(text: string): boolean {
    return CommandParser.isSessionCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, channel, threadTs, say } = ctx;
    const session = this.deps.claudeHandler.getSession(channel, threadTs);

    // Emit deprecation notice if the user still uses the legacy `$` prefix.
    // We intentionally continue executing the command so nothing breaks.
    if (CommandParser.isDeprecatedSessionCommand(ctx.text)) {
      const newForm = ctx.text.trim().replace(/^\$/, '%');
      await say({
        text: `⚠️ \`$\` 접두 세션 명령은 더 이상 사용되지 않습니다. 대신 \`${newForm}\` 형태로 \`%\` 접두를 사용하세요. (\`$\`는 강제 스킬 발동 전용)`,
        thread_ts: threadTs,
      });
    }

    if (!session) {
      await say({
        text: '💡 No active session in this thread. Start a conversation first!',
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    const parsed = CommandParser.parseSessionCommand(ctx.text);

    switch (parsed.type) {
      case 'info':
        return this.showSessionInfo(ctx, session);
      case 'model':
        return parsed.action === 'set'
          ? this.setSessionModel(ctx, session, parsed.model!)
          : this.showSessionModel(ctx, session);
      case 'verbosity':
        return parsed.action === 'set'
          ? this.setSessionVerbosity(ctx, session, parsed.level!)
          : this.showSessionVerbosity(ctx, session);
      case 'effort':
        return parsed.action === 'set'
          ? this.setSessionEffort(ctx, session, parsed.level!)
          : this.showSessionEffort(ctx, session);
      case 'thinking':
        return parsed.action === 'set'
          ? this.setSessionThinking(ctx, session, parsed.value!)
          : this.showSessionThinking(ctx, session);
      case 'thinking_summary':
        return parsed.action === 'set'
          ? this.setSessionThinkingSummary(ctx, session, parsed.value!)
          : this.showSessionThinkingSummary(ctx, session);
    }
  }

  private async showSessionInfo(ctx: CommandContext, session: any): Promise<CommandResult> {
    const { say, threadTs, user } = ctx;

    const modelId = session.model || userSettingsStore.getUserDefaultModel(user);
    const modelDisplay = userSettingsStore.getModelDisplayName(modelId as ModelId);
    const userDefault = userSettingsStore.getUserDefaultModel(user);
    const isModelOverridden = session.model && session.model !== userDefault;

    const userDefaultEffort = userSettingsStore.getUserDefaultEffort(user);
    const effortLevel = session.effort || userDefaultEffort;
    const isEffortOverridden = session.effort != null && session.effort !== userDefaultEffort;

    const verbosityMask = session.logVerbosity ?? LOG_DETAIL;
    const verbosityName = getVerbosityName(verbosityMask);
    const userVerbosity = userSettingsStore.getUserDefaultLogVerbosity(user);
    const isVerbosityOverridden = verbosityName !== userVerbosity;

    const userThinkingDefault = userSettingsStore.getUserThinkingEnabled(user);
    const thinkingEnabled = session.thinkingEnabled ?? userThinkingDefault;
    const isThinkingOverridden = session.thinkingEnabled != null && session.thinkingEnabled !== userThinkingDefault;

    const userShowThinkingDefault = userSettingsStore.getUserShowThinking(user);
    const showThinking = session.showThinking ?? userShowThinkingDefault;
    const isShowThinkingOverridden = session.showThinking != null && session.showThinking !== userShowThinkingDefault;

    const lines: string[] = [
      '📋 *Session Info*',
      '',
      `*Model:* ${modelDisplay} (\`${modelId}\`)${isModelOverridden ? ' ⚡' : ''}`,
      `*Effort:* ${effortLevel}${isEffortOverridden ? ' ⚡' : ''}`,
      `*Verbosity:* ${verbosityName}${isVerbosityOverridden ? ' ⚡' : ''}`,
      `*Thinking:* ${thinkingEnabled ? 'ON' : 'OFF'}${isThinkingOverridden ? ' ⚡' : ''}`,
      `*Thinking Summary:* ${showThinking ? 'ON' : 'OFF'}${isShowThinkingOverridden ? ' ⚡' : ''}`,
    ];

    if (session.ownerName || session.ownerId) {
      lines.push(`*Owner:* ${session.ownerName || session.ownerId}`);
    }

    if (session.workingDirectory) {
      lines.push(`*CWD:* \`${session.workingDirectory}\``);
    }

    if (session.state) {
      lines.push(`*State:* ${session.state}`);
    }

    if (session.workflow) {
      lines.push(`*Workflow:* ${session.workflow}`);
    }

    if (session.conversationId) {
      lines.push(`*Conversation:* \`${session.conversationId}\``);
    }

    // Context usage
    if (session.usage) {
      const u = session.usage;
      const current = u.currentInputTokens + u.currentOutputTokens;
      const pct = u.contextWindow > 0 ? (((u.contextWindow - current) / u.contextWindow) * 100).toFixed(0) : '?';
      lines.push(`*Context:* ${formatTokens(current)} / ${formatTokens(u.contextWindow)} (${pct}% available)`);
      if (u.totalCostUsd > 0) {
        lines.push(`*Cost:* $${u.totalCostUsd.toFixed(4)}`);
      }
    }

    // Links
    if (session.links) {
      const linkParts: string[] = [];
      if (session.links.issue) linkParts.push(`Issue: ${session.links.issue.url}`);
      if (session.links.pr) linkParts.push(`PR: ${session.links.pr.url}`);
      if (session.links.doc) linkParts.push(`Doc: ${session.links.doc.url}`);
      if (linkParts.length > 0) {
        lines.push(`*Links:* ${linkParts.join(' | ')}`);
      }
    }

    // Source working dirs with disk usage
    if (session.sourceWorkingDirs?.length) {
      let totalBytes = 0;
      const dirLines: string[] = [];
      for (const dir of session.sourceWorkingDirs) {
        const size = getDirSizeBytes(dir);
        totalBytes += size;
        dirLines.push(`  • \`${dir}\` — ${formatBytesUtil(size)}`);
      }
      lines.push(`*Source Working Dirs:* (${formatBytesUtil(totalBytes)} total)`);
      lines.push(...dirLines);
    }

    // User SSOT Instructions
    if (session.instructions?.length > 0) {
      lines.push(`*Instructions (SSOT):* ${session.instructions.length}`);
      for (let i = 0; i < Math.min(session.instructions.length, 5); i++) {
        const inst = session.instructions[i];
        const preview = inst.text.length > 80 ? inst.text.slice(0, 80) + '…' : inst.text;
        lines.push(`  ${i + 1}. ${preview}`);
      }
      if (session.instructions.length > 5) {
        lines.push(`  _...and ${session.instructions.length - 5} more_`);
      }
    }

    // Uptime
    if (session.lastActivity) {
      const elapsed = Date.now() - new Date(session.lastActivity).getTime();
      lines.push(`*Last Activity:* ${formatDuration(elapsed)} ago`);
    }

    lines.push('');
    lines.push('_⚡ = overridden for this session (differs from user default)_');
    lines.push('_Use `%model <name>` or `%verbosity <level>` to change session settings._');

    await say({ text: lines.join('\n'), thread_ts: threadTs });
    return { handled: true };
  }

  private async showSessionModel(ctx: CommandContext, session: any): Promise<CommandResult> {
    const { say, threadTs, user } = ctx;
    const modelId = session.model || userSettingsStore.getUserDefaultModel(user);
    const modelDisplay = userSettingsStore.getModelDisplayName(modelId as ModelId);
    const userDefault = userSettingsStore.getUserDefaultModel(user);
    const isOverridden = session.model && session.model !== userDefault;

    await say({
      text: `🤖 *Session Model:* ${modelDisplay} (\`${modelId}\`)${isOverridden ? '\n⚡ _Overridden for this session (default: ' + userSettingsStore.getModelDisplayName(userDefault) + ')_' : ''}`,
      thread_ts: threadTs,
    });
    return { handled: true };
  }

  private async setSessionModel(ctx: CommandContext, session: any, input: string): Promise<CommandResult> {
    const { say, threadTs } = ctx;
    const resolved = userSettingsStore.resolveModelInput(input);

    if (!resolved) {
      const aliases = Object.keys(MODEL_ALIASES)
        .map((a) => `\`${a}\``)
        .join(', ');
      await say({
        text: `❌ Unknown model \`${input}\`.\n*Available:* ${aliases}`,
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    session.model = resolved;
    const displayName = userSettingsStore.getModelDisplayName(resolved);
    await say({
      text: `⚡ *Session Model Changed*\n\nThis session now uses: *${displayName}* (\`${resolved}\`)\n_User default unchanged. Use \`model ${input}\` to change permanently._`,
      thread_ts: threadTs,
    });
    return { handled: true };
  }

  private async showSessionVerbosity(ctx: CommandContext, session: any): Promise<CommandResult> {
    const { say, threadTs, user } = ctx;
    const verbosityMask = session.logVerbosity ?? LOG_DETAIL;
    const verbosityName = getVerbosityName(verbosityMask);
    const userDefault = userSettingsStore.getUserDefaultLogVerbosity(user);
    const isOverridden = verbosityName !== userDefault;

    await say({
      text: `📊 *Session Verbosity:* ${verbosityName}${isOverridden ? '\n⚡ _Overridden for this session (default: ' + userDefault + ')_' : ''}`,
      thread_ts: threadTs,
    });
    return { handled: true };
  }

  private async setSessionVerbosity(ctx: CommandContext, session: any, input: string): Promise<CommandResult> {
    const { say, threadTs } = ctx;
    const resolved = userSettingsStore.resolveVerbosityInput(input);

    if (!resolved) {
      const valid = VERBOSITY_NAMES.map((n) => `\`${n}\``).join(', ');
      await say({
        text: `❌ Unknown verbosity \`${input}\`.\n*Available:* ${valid}`,
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    session.logVerbosity = getVerbosityFlags(resolved);
    await say({
      text: `⚡ *Session Verbosity Changed*\n\nThis session now uses: *${resolved}*\n_User default unchanged. Use \`verbosity ${input}\` to change permanently._`,
      thread_ts: threadTs,
    });
    return { handled: true };
  }
  private async showSessionEffort(ctx: CommandContext, session: any): Promise<CommandResult> {
    const { say, threadTs, user } = ctx;
    const userDefaultEffort = userSettingsStore.getUserDefaultEffort(user);
    const effortLevel = session.effort || userDefaultEffort;
    const isOverridden = session.effort != null && session.effort !== userDefaultEffort;

    await say({
      text: `🧠 *Session Effort:* ${effortLevel}${isOverridden ? '\n⚡ _Overridden for this session_' : ''}`,
      thread_ts: threadTs,
    });
    return { handled: true };
  }

  private async setSessionEffort(ctx: CommandContext, session: any, input: string): Promise<CommandResult> {
    const { say, threadTs } = ctx;
    const valid = EFFORT_LEVELS;
    const normalized = input.toLowerCase();

    if (!valid.includes(normalized as any)) {
      const validStr = valid.map((v) => `\`${v}\``).join(', ');
      await say({
        text: `❌ Unknown effort level \`${input}\`.\n*Available:* ${validStr}\n_⚠️ \`max\` requires API key (not available for Claude.ai subscribers)_`,
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    session.effort = normalized as (typeof valid)[number];
    const warning = normalized === 'max' ? '\n_⚠️ `max` requires API key — will fail on Claude.ai subscription_' : '';
    await say({
      text: `⚡ *Session Effort Changed*\n\nThis session now uses: *${normalized}*${warning}\n_Use \`%effort ${DEFAULT_EFFORT}\` to restore default._`,
      thread_ts: threadTs,
    });
    return { handled: true };
  }

  private async showSessionThinking(ctx: CommandContext, session: any): Promise<CommandResult> {
    const { say, threadTs, user } = ctx;
    const userDefault = userSettingsStore.getUserThinkingEnabled(user);
    const current = session.thinkingEnabled ?? userDefault;
    const isOverridden = session.thinkingEnabled != null && session.thinkingEnabled !== userDefault;

    await say({
      text: `🧠 *Extended Thinking:* ${current ? 'ON' : 'OFF'}${isOverridden ? '\n⚡ _Overridden for this session_' : ''}`,
      thread_ts: threadTs,
    });
    return { handled: true };
  }

  private async setSessionThinking(ctx: CommandContext, session: any, input: string): Promise<CommandResult> {
    const { say, threadTs } = ctx;
    const normalized = input.toLowerCase();

    if (!['on', 'off', 'true', 'false', 'enable', 'disable'].includes(normalized)) {
      await say({
        text: '❌ Usage: `%thinking on` or `%thinking off`',
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    const enabled = ['on', 'true', 'enable'].includes(normalized);
    session.thinkingEnabled = enabled;
    await say({
      text: `⚡ *Extended Thinking:* ${enabled ? 'ON' : 'OFF'}\n_Takes effect on next message._`,
      thread_ts: threadTs,
    });
    return { handled: true };
  }

  private async showSessionThinkingSummary(ctx: CommandContext, session: any): Promise<CommandResult> {
    const { say, threadTs, user } = ctx;
    const userDefault = userSettingsStore.getUserShowThinking(user);
    const current = session.showThinking ?? userDefault;
    const isOverridden = session.showThinking != null && session.showThinking !== userDefault;

    await say({
      text: `💭 *Thinking Summary Display:* ${current ? 'ON' : 'OFF'}${isOverridden ? '\n⚡ _Overridden for this session_' : ''}`,
      thread_ts: threadTs,
    });
    return { handled: true };
  }

  private async setSessionThinkingSummary(ctx: CommandContext, session: any, input: string): Promise<CommandResult> {
    const { say, threadTs } = ctx;
    const normalized = input.toLowerCase();

    if (!['on', 'off', 'true', 'false', 'enable', 'disable'].includes(normalized)) {
      await say({
        text: '❌ Usage: `%thinking_summary on` or `%thinking_summary off`',
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    const show = ['on', 'true', 'enable'].includes(normalized);
    session.showThinking = show;
    await say({
      text: `⚡ *Thinking Summary Display:* ${show ? 'ON' : 'OFF'}\n_Takes effect immediately._`,
      thread_ts: threadTs,
    });
    return { handled: true };
  }
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n.toString();
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}
