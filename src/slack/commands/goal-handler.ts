import { buildGoalContinuationPrompt, validateSessionGoalObjective } from '../../prompt/session-goal-block';
import type { ConversationSession, SessionGoal } from '../../types';
import { DEFAULT_GOAL_MAX_CONTINUATIONS } from '../../types';
import { validateGoalMaxContinuations } from '../../user-settings-store';
import { CommandParser } from '../command-parser';
import { buildGoalStatusBlocks } from '../goal-blocks';
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
      // `goal auto` / `goal max <N>` are per-user settings — they apply to
      // FUTURE sessions, so they must work even with no active session.
      if (noSessionAction.action === 'auto') {
        await this.toggleAutoGoal(ctx, noSessionAction.mode);
        return { handled: true };
      }
      if (noSessionAction.action === 'max') {
        await this.setMaxContinuations(ctx, undefined, noSessionAction.max);
        return { handled: true };
      }
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
      case 'auto':
        await this.toggleAutoGoal(ctx, action.mode);
        return { handled: true };
      case 'max':
        await this.setMaxContinuations(ctx, session, action.max);
        return { handled: true };
    }
  }

  /**
   * Toggle (or explicitly set) the per-user autogoal mode (S2). Per-user, so
   * it works with or without a live session.
   */
  private async toggleAutoGoal(ctx: CommandContext, mode?: 'on' | 'off'): Promise<void> {
    const store = this.deps.userSettingsStore;
    let next: boolean;
    if (mode === undefined) {
      next = store.toggleUserAutoGoalEnabled(ctx.user);
    } else {
      next = mode === 'on';
      store.setUserAutoGoalEnabled(ctx.user, next);
    }
    await this.deps.slackApi.postSystemMessage(
      ctx.channel,
      next
        ? '🤖 *Autogoal mode ON.* When a session has no active goal, your next instruction becomes the goal automatically.'
        : '🤖 Autogoal mode OFF.',
      { threadTs: ctx.threadTs },
    );
  }

  /**
   * Override the auto-continuation cap (S4). Updates the current active goal
   * when one exists AND persists a per-user default for future goals.
   */
  private async setMaxContinuations(
    ctx: CommandContext,
    session: ConversationSession | undefined,
    rawMax: number,
  ): Promise<void> {
    let value: number;
    try {
      value = validateGoalMaxContinuations(rawMax);
    } catch (err) {
      await this.deps.slackApi.postSystemMessage(ctx.channel, `⚠️ ${(err as Error).message} (1–1000).`, {
        threadTs: ctx.threadTs,
      });
      return;
    }
    this.deps.userSettingsStore.setUserGoalMaxContinuations(ctx.user, value);

    const active = session?.goal;
    if (active && (active.status === 'active' || active.status === 'paused')) {
      active.maxContinuations = value;
      active.updatedAt = Date.now();
      this.persistGoalChange(session as ConversationSession);
      await this.deps.slackApi.postSystemMessage(
        ctx.channel,
        `🔢 Goal will now auto-continue up to *${value}* turns (was the ${DEFAULT_GOAL_MAX_CONTINUATIONS} default). Applied to the current goal and saved as your default.`,
        { threadTs: ctx.threadTs },
      );
      return;
    }
    await this.deps.slackApi.postSystemMessage(
      ctx.channel,
      `🔢 New goals will auto-continue up to *${value}* turns (default is ${DEFAULT_GOAL_MAX_CONTINUATIONS}).`,
      { threadTs: ctx.threadTs },
    );
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
    const result = enqueueOrActivateGoal(
      session,
      objective,
      ctx.user,
      this.deps.userSettingsStore.getUserGoalMaxContinuations(ctx.user),
    );

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
    // A lifecycle change resolves any pending cap-decision DM (S3 dedup guard).
    session.goal.capDmPendingAt = undefined;
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
    // A completed goal resolves any pending cap-decision DM (S3 dedup guard).
    session.goal.capDmPendingAt = undefined;
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

    // S1: render the goal list as Block Kit so each live goal carries a
    // Delete + Update button. `sessionKey` is encoded into each button so the
    // action handler can resolve the goal without re-deriving it from the
    // channel/thread pair.
    const sessionKey = this.deps.claudeHandler.getSessionKey(
      session.channelId ?? channel,
      session.threadTs ?? threadTs,
    );
    const blocks = buildGoalStatusBlocks({
      sessionKey,
      channel,
      threadTs,
      goal: session.goal,
      queue,
      history,
      listLimit: GoalHandler.STATUS_LIST_LIMIT,
      formatObjective: (o) => this.formatObjectiveForSlack(o),
      formatMetrics: (g) => this.formatGoalMetrics(g),
    });

    // Text fallback (notifications + non-Block-Kit surfaces) keeps the old
    // plain-text summary shape.
    const fallback: string[] = [];
    if (session.goal)
      fallback.push(
        `🎯 Current goal (${session.goal.status}): ${this.formatObjectiveForSlack(session.goal.objective)}`,
      );
    if (queue.length) fallback.push(`📋 ${queue.length} queued`);
    if (history.length) fallback.push(`✅ ${history.length} completed`);

    await this.deps.slackApi.postSystemMessage(channel, fallback.join(' · ') || '🎯 Goal status', {
      threadTs,
      blocks,
    });
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
