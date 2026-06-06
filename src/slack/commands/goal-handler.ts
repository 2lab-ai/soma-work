import { buildGoalContinuationPrompt, validateSessionGoalObjective } from '../../prompt/session-goal-block';
import { type ConversationSession, DEFAULT_GOAL_MAX_CONTINUATIONS, type SessionGoal } from '../../types';
import { CommandParser } from '../command-parser';
import { bumpGoalEpoch } from '../goal-continuation';
import type { CommandContext, CommandDependencies, CommandHandler, CommandResult } from './types';

export class GoalHandler implements CommandHandler {
  constructor(private deps: CommandDependencies) {}

  canHandle(text: string): boolean {
    return CommandParser.isGoalCommand(text);
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
        await this.completeGoal(channel, threadTs, session, user);
        return { handled: true };
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

    const now = Date.now();
    const goal: SessionGoal = {
      objective,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.user,
      // Ralph-loop state: starts at zero. Each user-driven turn resets it
      // back to zero (see slack-handler user-message hook). Cap fires when
      // the model alone keeps the goal active without user intervention.
      continuationCount: 0,
      maxContinuations: DEFAULT_GOAL_MAX_CONTINUATIONS,
      evalAttemptCount: 0,
      // Intent epoch — see M1. A fresh objective also carries a fresh
      // `createdAt`, which already invalidates any eval in flight for the
      // prior goal; the epoch tracks in-place mutations of THIS goal.
      epoch: 0,
    };
    session.goal = goal;
    this.persistGoalChange(session);

    await this.deps.slackApi.postSystemMessage(
      ctx.channel,
      `🎯 Goal set: ${this.formatObjectiveForSlack(objective)}\n_Continuing with goal context._`,
      { threadTs: ctx.threadTs },
    );

    return { handled: true, continueWithPrompt: buildGoalContinuationPrompt(goal) };
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
  ): Promise<void> {
    if (!session.goal) {
      await this.postNoGoal(channel, threadTs);
      return;
    }
    // User-driven completion bypasses the host-side eval model — see
    // docs/goal-command/spec.md §Completion via Host-Side Eval Model
    // ("user trust") and SSOT requirement H.4. Always reset pendingEval
    // and lastEvalReason so a half-finished eval cycle doesn't bleed
    // state into the audit trail of a `goal done` close-out.
    session.goal.status = 'complete';
    session.goal.completedAt = Date.now();
    session.goal.completedBy = user;
    session.goal.completedVia = 'user';
    session.goal.pendingEval = undefined;
    session.goal.lastEvalReason = undefined;
    session.goal.updatedAt = Date.now();
    this.persistGoalChange(session);
    await this.deps.slackApi.postSystemMessage(channel, '✅ Goal marked complete.', { threadTs });
  }

  private async clearGoal(channel: string, threadTs: string, session: ConversationSession): Promise<void> {
    if (!session.goal) {
      await this.postNoGoal(channel, threadTs);
      return;
    }
    session.goal = undefined;
    this.persistGoalChange(session);
    await this.deps.slackApi.postSystemMessage(channel, '🧹 Goal cleared.', { threadTs });
  }

  private async showStatus(channel: string, threadTs: string, session: ConversationSession): Promise<void> {
    if (!session.goal) {
      await this.postNoGoal(channel, threadTs);
      return;
    }

    const goal = session.goal;
    const lines = [
      `🎯 *Goal status:* ${goal.status}`,
      `*Objective:* ${this.formatObjectiveForSlack(goal.objective)}`,
      `*Updated:* ${new Date(goal.updatedAt).toISOString()}`,
    ];
    if (goal.completedAt) {
      lines.push(`*Completed:* ${new Date(goal.completedAt).toISOString()}`);
    }
    await this.deps.slackApi.postSystemMessage(channel, lines.join('\n'), { threadTs });
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
        '• `goal` - show the current goal',
        '• `goal <objective>` or `goal set <objective>` - set/replace the active goal',
        '• `goal pause|resume|done|clear` - manage goal state',
      ].join('\n'),
      { threadTs },
    );
  }

  private formatObjectiveForSlack(objective: string): string {
    const normalized = objective.replace(/\s+/g, ' ').trim();
    const clipped = normalized.length > 900 ? `${normalized.slice(0, 897)}...` : normalized;
    return `\`${clipped.replace(/`/g, "'")}\``;
  }
}
