import { buildGoalContinuationPrompt, validateSessionGoalObjective } from '../../prompt/session-goal-block';
import type { ConversationSession, SessionGoal } from '../../types';
import { CommandParser } from '../command-parser';
import { bumpGoalEpoch } from '../goal-continuation';
import { advanceGoalQueue, enqueueOrActivateGoal, formatGoalObjectiveForSlack } from '../session-goal';
import type { CommandContext, CommandDependencies, CommandHandler, CommandResult } from './types';

export class GoalHandler implements CommandHandler {
  /** Max queue/history rows rendered by `goal` status before truncating. */
  private static readonly STATUS_LIST_LIMIT = 10;

  constructor(private deps: CommandDependencies) {}

  canHandle(text: string): boolean {
    return CommandParser.isGoalCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { channel, threadTs, text, user } = ctx;
    const session = this.deps.claudeHandler.getSession(channel, threadTs);
    if (!session) {
      // No session: `goal <objective>` (action 'set') is a free-form first-message
      // instruction, not a session-scoped command — decline so the router falls
      // through to session init with the full text (#1068, see
      // CommandParser.GREEDY_FREEFORM_ROOTS). Bare/lifecycle/invalid forms keep
      // the explicit hint.
      const noSessionAction = CommandParser.parseGoalCommand(text);
      if (noSessionAction.action === 'set') {
        // Issue #1082 T1: validation runs BEFORE the fall-through decision —
        // an over-limit objective is invalid whether or not a session exists,
        // and silently starting a goal-less conversation with it would hide
        // the error.
        const objective = noSessionAction.objective.trim();
        const validationError = validateSessionGoalObjective(objective);
        if (validationError) {
          await this.deps.slackApi.postSystemMessage(channel, `⚠️ ${validationError}.`, { threadTs });
          return { handled: true };
        }
        // Carry the parsed objective out-of-band so the new session is born
        // with the goal already active (applied by slack-handler right after
        // session init, before the first dispatch).
        return { handled: false, setGoalObjective: objective };
      }
      await this.deps.slackApi.postSystemMessage(channel, '💡 No active session. Start a conversation first.', {
        threadTs,
      });
      return { handled: true };
    }

    const action = CommandParser.parseGoalCommand(text);
    switch (action.action) {
      case 'status':
        await this.showStatus(channel, threadTs, session);
        return { handled: true };
      case 'invalid':
        await this.postUsage(channel, threadTs);
        return { handled: true };
      case 'set':
        return this.setGoal(ctx, session, action.objective);
      case 'pause':
        await this.pauseGoal(channel, threadTs, session);
        return { handled: true };
      case 'resume':
        await this.resumeGoal(channel, threadTs, session);
        return { handled: true };
      case 'complete':
        return this.completeGoal(channel, threadTs, session, user);
      case 'clear':
        await this.clearGoal(channel, threadTs, session);
        return { handled: true };
    }
  }

  private async setGoal(
    ctx: CommandContext,
    session: ConversationSession,
    rawObjective: string,
  ): Promise<CommandResult> {
    const objective = rawObjective.trim();
    const validationError = validateSessionGoalObjective(objective);
    if (validationError) {
      await this.deps.slackApi.postSystemMessage(ctx.channel, `⚠️ ${validationError}.`, { threadTs: ctx.threadTs });
      return { handled: true };
    }

    // Multi-goal (T2): a second `goal <text>` while one is already in flight
    // APPENDS to the queue instead of replacing the running goal. The single
    // chokepoint (`enqueueOrActivateGoal`) decides activate-vs-queue so the
    // SET_GOAL model-command and first-message paths behave identically.
    const result = enqueueOrActivateGoal(session, objective, ctx.user);

    if (!result.activated) {
      // Queued behind the current goal — do NOT start a continuation, and do
      // NOT bump the running goal's epoch (that would discard its in-flight
      // eval). The running goal owns the loop untouched until it completes and
      // advances the queue. Just persist the appended queue entry.
      this.deps.claudeHandler.saveSessions();
      await this.deps.slackApi.postSystemMessage(
        ctx.channel,
        `📋 Goal queued at position ${result.position}: ${this.formatObjectiveForSlack(objective)}\n_It will start automatically when the current goal completes._`,
        { threadTs: ctx.threadTs },
      );
      return { handled: true };
    }

    this.persistGoalChange(session);
    await this.deps.slackApi.postSystemMessage(
      ctx.channel,
      `🎯 Goal set: ${this.formatObjectiveForSlack(objective)}\n_Continuing with goal context._`,
      { threadTs: ctx.threadTs },
    );

    return { handled: true, continueWithPrompt: buildGoalContinuationPrompt(result.goal as SessionGoal) };
  }

  private async pauseGoal(channel: string, threadTs: string, session: ConversationSession): Promise<void> {
    if (!session.goal) {
      await this.postNoGoal(channel, threadTs);
      return;
    }
    if (session.goal.status === 'complete') {
      await this.deps.slackApi.postSystemMessage(channel, '✅ Current goal is already complete.', { threadTs });
      return;
    }
    session.goal.status = 'paused';
    session.goal.updatedAt = Date.now();
    this.persistGoalChange(session);
    await this.deps.slackApi.postSystemMessage(channel, '⏸️ Goal paused. It will not be injected into future prompts.', {
      threadTs,
    });
  }

  private async resumeGoal(channel: string, threadTs: string, session: ConversationSession): Promise<void> {
    if (!session.goal) {
      await this.postNoGoal(channel, threadTs);
      return;
    }
    if (session.goal.status === 'complete') {
      await this.deps.slackApi.postSystemMessage(channel, '✅ Current goal is complete. Set a new goal to continue.', {
        threadTs,
      });
      return;
    }
    session.goal.status = 'active';
    session.goal.updatedAt = Date.now();
    this.persistGoalChange(session);
    await this.deps.slackApi.postSystemMessage(channel, '▶️ Goal resumed. It will be injected into future prompts.', {
      threadTs,
    });
  }

  private async completeGoal(
    channel: string,
    threadTs: string,
    session: ConversationSession,
    user: string,
  ): Promise<CommandResult> {
    if (!session.goal) {
      await this.postNoGoal(channel, threadTs);
      return { handled: true };
    }
    // User-driven completion bypasses the host-side eval model — see
    // docs/goal-command/spec.md §Completion via Host-Side Eval Model
    // ("user trust") and SSOT requirement H.4. Always reset pendingEval
    // and lastEvalReason so a half-finished eval cycle doesn't bleed
    // state into the audit trail of a `goal done` close-out.
    const now = Date.now();
    session.goal.status = 'complete';
    session.goal.completedAt = now;
    session.goal.completedBy = user;
    session.goal.completedVia = 'user';
    session.goal.completionReason = 'user';
    session.goal.pendingEval = undefined;
    session.goal.lastEvalReason = undefined;
    session.goal.updatedAt = now;

    // Multi-goal (T2): archive the finished goal and promote the next queued
    // goal (if any). The shared `advanceGoalQueue` keeps user-`done` and
    // eval-`complete` advance semantics identical.
    const next = advanceGoalQueue(session);
    this.persistGoalChange(session);

    if (next) {
      await this.deps.slackApi.postSystemMessage(
        channel,
        `✅ Goal marked complete.\n▶️ Starting next queued goal: ${this.formatObjectiveForSlack(next.objective)}`,
        { threadTs },
      );
      // Re-enter the loop for the promoted goal, same as a fresh `goal set`.
      return { handled: true, continueWithPrompt: buildGoalContinuationPrompt(next as SessionGoal) };
    }

    await this.deps.slackApi.postSystemMessage(channel, '✅ Goal marked complete.', { threadTs });
    return { handled: true };
  }

  private async clearGoal(channel: string, threadTs: string, session: ConversationSession): Promise<void> {
    if (!session.goal && !(session.goalQueue?.length || session.goalHistory?.length)) {
      await this.postNoGoal(channel, threadTs);
      return;
    }
    // `clear` is the full escape hatch: drop the current goal, the entire
    // pending queue, and the completed history. (To advance to the next goal
    // without nuking the queue, use `goal done` instead.)
    const clearedQueue = session.goalQueue?.length ?? 0;
    session.goal = undefined;
    session.goalQueue = [];
    session.goalHistory = [];
    session.goalLastTurnText = undefined;
    this.persistGoalChange(session);
    const suffix =
      clearedQueue > 0 ? ` (also cleared ${clearedQueue} queued goal${clearedQueue === 1 ? '' : 's'})` : '';
    await this.deps.slackApi.postSystemMessage(channel, `🧹 Goal cleared${suffix}.`, { threadTs });
  }

  private async showStatus(channel: string, threadTs: string, session: ConversationSession): Promise<void> {
    const queue = session.goalQueue ?? [];
    const history = session.goalHistory ?? [];
    if (!session.goal && queue.length === 0 && history.length === 0) {
      await this.postNoGoal(channel, threadTs);
      return;
    }

    const lines: string[] = [];

    // ── Current goal ───────────────────────────────────────────────────
    const goal = session.goal;
    if (goal) {
      lines.push(`🎯 *Current goal* — _${goal.status}_`);
      lines.push(`*Objective:* ${this.formatObjectiveForSlack(goal.objective)}`);
      lines.push(`*Spent:* ${this.formatGoalMetrics(goal)}`);
      if (goal.status === 'active') {
        lines.push(`*Auto-continuations:* ${goal.continuationCount}/${goal.maxContinuations}`);
      }
      if (goal.completedAt) {
        lines.push(
          `*Completed:* ${new Date(goal.completedAt).toISOString()} (${goal.completionReason ?? goal.completedVia ?? 'done'})`,
        );
      }
    }

    // ── Pending queue (T2) ─────────────────────────────────────────────
    if (queue.length > 0) {
      lines.push('');
      lines.push(`📋 *Queued goals (${queue.length})* — start automatically in order:`);
      // Cap the rendered list so a long queue can't overflow the Slack message.
      const shownQueue = queue.slice(0, GoalHandler.STATUS_LIST_LIMIT);
      for (const [i, q] of shownQueue.entries()) {
        lines.push(`  ${i + 1}. ${this.formatObjectiveForSlack(q.objective)}`);
      }
      if (queue.length > shownQueue.length) {
        lines.push(`  …and ${queue.length - shownQueue.length} more`);
      }
    }

    // ── Completed history (T3) ─────────────────────────────────────────
    if (history.length > 0) {
      // Newest first, capped for Slack readability.
      const recent = [...history].reverse().slice(0, GoalHandler.STATUS_LIST_LIMIT);
      lines.push('');
      lines.push(`✅ *Completed goals (${history.length})* — most recent first:`);
      for (const h of recent) {
        const reason = h.completionReason ?? h.completedVia ?? 'done';
        lines.push(`  • ${this.formatObjectiveForSlack(h.objective)} — _${reason}_ · ${this.formatGoalMetrics(h)}`);
      }
      if (history.length > recent.length) {
        lines.push(`  …and ${history.length - recent.length} older`);
      }
    }

    await this.deps.slackApi.postSystemMessage(channel, lines.join('\n'), { threadTs });
  }

  /** Compact "time + tokens" summary for one goal's accounting fields. */
  private formatGoalMetrics(goal: SessionGoal): string {
    const parts: string[] = [GoalHandler.formatDuration(goal.activeMsUsed ?? 0)];
    const inTok = goal.tokensInput ?? 0;
    const outTok = goal.tokensOutput ?? 0;
    const cacheTok = (goal.tokensCacheRead ?? 0) + (goal.tokensCacheCreate ?? 0);
    if (inTok || outTok || cacheTok) {
      parts.push(
        `${GoalHandler.formatTokens(inTok)} in / ${GoalHandler.formatTokens(outTok)} out` +
          (cacheTok ? ` / ${GoalHandler.formatTokens(cacheTok)} cache` : ''),
      );
    }
    if (goal.costUsd && goal.costUsd > 0) {
      parts.push(`$${goal.costUsd.toFixed(2)}`);
    }
    return parts.join(' · ');
  }

  /** ms → `1m 5s` / `2h 3m` / `12s` style. */
  private static formatDuration(ms: number): string {
    if (ms <= 0) return '0s';
    const totalSec = Math.round(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  /** 1234 → `1.2k`, 1_200_000 → `1.2M`. */
  private static formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return `${n}`;
  }

  private persistGoalChange(session: ConversationSession): void {
    // Every user-driven goal mutation advances the intent epoch so an
    // in-flight completion eval resolves into a discard, never an apply,
    // against the state the user just changed (M1). `clear` leaves no goal
    // to bump — the eval's epoch guard catches that via the missing goal.
    if (session.goal) bumpGoalEpoch(session.goal);
    session.systemPrompt = undefined;
    this.deps.claudeHandler.saveSessions();
  }

  private async postNoGoal(channel: string, threadTs: string): Promise<void> {
    await this.deps.slackApi.postSystemMessage(
      channel,
      '💡 No goal is set for this session. Use `goal <objective>` to start one.',
      { threadTs },
    );
  }

  private async postUsage(channel: string, threadTs: string): Promise<void> {
    await this.deps.slackApi.postSystemMessage(
      channel,
      [
        '*Goal command usage*',
        '• `goal` - show the goal list (current + queued + completed) with time/token spend',
        '• `goal <objective>` or `goal set <objective>` - start a goal, or queue it behind the running one',
        '• `goal done` - complete the current goal and start the next queued one',
        '• `goal pause|resume|clear` - manage goal state (`clear` drops current + queue + history)',
      ].join('\n'),
      { threadTs },
    );
  }

  private formatObjectiveForSlack(objective: string): string {
    // Issue #1082: single rendering source shared with the slack-handler 🎯
    // notice and the SET_GOAL host-apply notice — see session-goal.ts.
    return formatGoalObjectiveForSlack(objective);
  }
}
