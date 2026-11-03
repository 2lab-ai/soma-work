/**
 * #865 — the goal commands of a Slack-less dashboard task. A Slack thread's
 * `goal …` is a host command (`GoalHandler`); a task sent the same words to the
 * model as plain text, so `goal clear` could not clear anything and a goal set
 * twice queued behind itself. Here the task gets the same parser and the same
 * goal semantics, minus the thread:
 *
 *  - every notice goes to the task's work log (the dashboard shows it) and back
 *    to the sender in the response;
 *  - a goal that starts (`goal <objective>`, `goal done` promoting the next,
 *    `goal resume` of a goal whose first turn never ran) starts its opening
 *    turn through the task controller — the objective as the turn's words,
 *    waiting in the task's queue while a turn runs, as the owner's word does.
 *    When that start is refused the goal state is put back exactly and the
 *    refusal is the answer: no active goal is left that nothing will start;
 *  - the dashboard's goal list (add / delete) goes through {@link hostAction}
 *    with the same rules (`SlackHandler.handleHostGoalAction` needs a thread).
 */

import { validateSessionGoalObjective } from '../prompt/session-goal-block';
import { CommandParser } from '../slack/command-parser';
import { retireGoalCapDecision } from '../slack/goal-cap-decision';
import { bumpGoalEpoch } from '../slack/goal-continuation';
import type { HostGoalAction, HostGoalActionResult } from '../slack/goal-host-actions';
import { HostGoalActionError } from '../slack/goal-host-actions';
import {
  advanceGoalQueue,
  deleteCurrentGoal,
  deleteGoalById,
  enqueueOrActivateGoal,
  findPendingGoalPosition,
  formatGoalObjectiveForSlack,
  formatResumedGoalLine,
  restoreGoalState,
  snapshotGoalState,
} from '../slack/session-goal';
import { recordSessionNotice } from '../slack/session-notice';
import type { ConversationSession, SessionGoal } from '../types';
import { DEFAULT_GOAL_MAX_CONTINUATIONS } from '../types';
import { validateGoalMaxContinuations } from '../user-settings-store';
import type { TaskCommandRequest, TaskCommandResponse } from './task-turn-controller';

export interface TaskGoalCommandDeps {
  getSession: (sessionKey: string) => ConversationSession | undefined;
  saveSessions: () => void;
  /** Push the board now (goal state is on the card). */
  broadcast: () => void;
  /** Kick the goal loop (production: `goalLoopController.onTurnSettled(key, { cause: 'kick' })`). */
  kickLoop: (sessionKey: string) => void;
  /**
   * Start a goal's opening turn: `prompt` as the turn's words, as `actorUserId`,
   * queued behind a running turn (production: the task controller's `start` with
   * `goalOpeningId` — the words are never read as a goal command again, and a
   * queued opening runs only while its goal is still the active goal).
   */
  startOpening: (
    sessionKey: string,
    prompt: string,
    actorUserId: string,
    carry: Pick<TaskCommandRequest, 'approvedOnce' | 'newTask'> & { goalId: string },
  ) => Promise<TaskCommandResponse>;
  settings: {
    getUserGoalMaxContinuations: (userId: string) => number | undefined;
    setUserGoalMaxContinuations: (userId: string, value: number) => void;
    toggleUserAutoGoalEnabled: (userId: string) => boolean;
    setUserAutoGoalEnabled: (userId: string, enabled: boolean) => void;
  };
}

export interface TaskGoalCommands {
  /** True when the words are a goal command (`goal …`, `/goal …`, `set goal auto|max|<N>`). */
  matches: (text: string) => boolean;
  /** True when the goal command opens a goal (`goal <objective>`). */
  opensGoal: (text: string) => boolean;
  /**
   * Run a goal command on a task. The caller has admitted the sender (signed
   * in, may instruct this task). Never throws: a failure is the response.
   */
  run: (request: TaskCommandRequest, session: ConversationSession) => Promise<TaskCommandResponse>;
  /** The dashboard goal list's add / delete on a task. Throws {@link HostGoalActionError}. */
  hostAction: (sessionKey: string, action: HostGoalAction, actorUserId: string) => Promise<HostGoalActionResult>;
  /**
   * A goal's queued opening will not run (cancelled from the queue, or stale at
   * the drain). If its goal is still the current, unfinished goal it is paused
   * with its first turn owed — `goal resume` starts it from that turn — so it is
   * never left active with no first turn, judged on whatever turn ends next.
   */
  openingDropped: (
    sessionKey: string,
    session: ConversationSession,
    goalId: string,
    why: 'cancelled' | 'stale',
  ) => void;
}

const STATUS_LIST_LIMIT = 10;

const USAGE = [
  'Goal command usage',
  '• `goal` — show the goal list (current + queued + completed)',
  '• `goal <objective>` or `goal set <objective>` — start a goal, or queue it behind the running one',
  '• `goal done` — complete the current goal and start the next queued one',
  '• `goal pause|resume|clear` — manage goal state (`clear` drops current + queue + history)',
  '• `goal max <N>` / `goal auto [on|off]` — your auto-continuation cap / autogoal mode',
].join('\n');

const NO_GOAL = '💡 No goal is set for this task. Use `goal <objective>` to start one.';

export function createTaskGoalCommands(deps: TaskGoalCommandDeps): TaskGoalCommands {
  const fmt = formatGoalObjectiveForSlack;

  /** The notice in the task's work log. */
  function note(sessionKey: string, session: ConversationSession, text: string): void {
    recordSessionNotice(session, text, { sessionKey });
  }

  /** A user-driven goal change: the epoch moves (an in-flight eval is discarded), saved, the board pushed. */
  function persist(session: ConversationSession): void {
    if (session.goal) bumpGoalEpoch(session.goal);
    session.systemPrompt = undefined;
    deps.saveSessions();
    deps.broadcast();
  }

  /** Applied, nothing to run: 200 with the notice (also in the work log). */
  function applied(sessionKey: string, session: ConversationSession, message: string): TaskCommandResponse {
    note(sessionKey, session, message);
    return { status: 200, body: { ok: true, goalCommand: true, message } };
  }

  /** Nothing applied (the words are wrong): 400, nothing recorded. */
  const invalid = (message: string): TaskCommandResponse => ({ status: 400, body: { error: message } });

  /** Answered, nothing about this task changed (status, a per-user setting, a repeat): not recorded in its work log. */
  const answered = (message: string): TaskCommandResponse => ({
    status: 200,
    body: { ok: true, goalCommand: true, message },
  });

  /** Where the same goal already waits, as words — or undefined when it does not. */
  function alreadyThere(session: ConversationSession, objective: string): string | undefined {
    const at = findPendingGoalPosition(session, objective);
    if (at === undefined) return undefined;
    if (at > 0) return `📋 Goal already queued at position ${at} — not added again: ${fmt(objective)}`;
    return session.goal?.status === 'paused'
      ? `🎯 Goal already set (paused — \`goal resume\` runs it) — not added again: ${fmt(objective)}`
      : `🎯 Goal already set — not added again: ${fmt(objective)}`;
  }

  /**
   * The goal state changed and a goal starts: its opening turn runs the
   * objective. A refused start puts the state back (`snapshot`) and answers
   * with the refusal; the work log says the change did not happen.
   */
  async function open(
    request: TaskCommandRequest,
    session: ConversationSession,
    goal: { goalId: string; objective: string; createdBy?: string },
    snapshot: ReturnType<typeof snapshotGoalState>,
    done: string,
    undone: string,
  ): Promise<TaskCommandResponse> {
    const { sessionKey } = request;
    // Its first turn is owed from here until its opening's chain starts (the controller clears it):
    // the goal loop leaves it alone meanwhile, and only an owed opening runs (#876 R2).
    const live = session.goal?.goalId === goal.goalId ? session.goal : undefined;
    if (live) {
      live.openingPending = true;
      deps.saveSessions();
    }
    let res: TaskCommandResponse;
    try {
      res = await deps.startOpening(sessionKey, goal.objective, goal.createdBy || request.actorUserId, {
        approvedOnce: request.approvedOnce,
        newTask: request.newTask,
        goalId: goal.goalId,
      });
    } catch (error) {
      res = { status: 500, body: { error: (error as Error)?.message ?? String(error) } };
    }
    if (res.status >= 400) {
      restoreGoalState(session, snapshot);
      deps.saveSessions();
      deps.broadcast();
      const why = String((res.body as { error?: unknown })?.error ?? `HTTP ${res.status}`);
      note(sessionKey, session, `⚠️ ${undone} — its first turn could not start (${why}).`);
      return { status: res.status, body: { error: `${undone} — its first turn could not start: ${why}` } };
    }
    const queued = (res.body as { queued?: unknown }).queued === true;
    const message = `${done}\n${queued ? 'Its first turn starts as soon as the current turn ends.' : 'Its first turn is running.'}`;
    note(sessionKey, session, message);
    return { ...res, body: { ...res.body, ok: true, goalCommand: true, message } };
  }

  async function setGoal(
    request: TaskCommandRequest,
    session: ConversationSession,
    rawObjective: string,
  ): Promise<TaskCommandResponse> {
    const { sessionKey, actorUserId } = request;
    const objective = rawObjective.trim();
    const problem = validateSessionGoalObjective(objective);
    if (problem) return invalid(`⚠️ ${problem}.`);
    // The same goal running or waiting is not set again (#876 R2, fable P3 — the de-aislop repeat).
    const repeat = alreadyThere(session, objective);
    if (repeat) return answered(repeat);
    const snapshot = snapshotGoalState(session);
    const result = enqueueOrActivateGoal(
      session,
      objective,
      actorUserId,
      deps.settings.getUserGoalMaxContinuations(actorUserId),
    );
    if (!result.activated) {
      // Behind the goal in flight: no opening turn, no epoch bump (its in-flight eval stays valid).
      deps.saveSessions();
      deps.broadcast();
      if (result.resumedCurrent) deps.kickLoop(sessionKey);
      return applied(
        sessionKey,
        session,
        `📋 Goal queued at position ${result.position}: ${fmt(objective)}\nIt starts automatically when the current goal completes.` +
          (result.resumedCurrent ? `\n${formatResumedGoalLine(result.resumedCurrent)}` : ''),
      );
    }
    persist(session);
    return open(request, session, result.goal, snapshot, `🎯 Goal set: ${fmt(objective)}`, 'Goal was not set');
  }

  function pause(sessionKey: string, session: ConversationSession): TaskCommandResponse {
    const goal = session.goal;
    if (!goal) return applied(sessionKey, session, NO_GOAL);
    if (goal.status === 'complete') return applied(sessionKey, session, '✅ The current goal is already complete.');
    goal.status = 'paused';
    retireGoalCapDecision(goal);
    goal.updatedAt = Date.now();
    persist(session);
    return applied(sessionKey, session, '⏸️ Goal paused. It will not be injected into future prompts.');
  }

  async function resume(request: TaskCommandRequest, session: ConversationSession): Promise<TaskCommandResponse> {
    const { sessionKey } = request;
    const goal = session.goal;
    if (!goal) return applied(sessionKey, session, NO_GOAL);
    if (goal.status === 'complete') {
      return applied(sessionKey, session, '✅ The current goal is complete. Set a new goal to continue.');
    }
    // A goal whose first turn never started (cancelled, or waiting since a restart): resuming it starts it.
    const needsOpening = goal.openingPending === true;
    const snapshot = snapshotGoalState(session);
    // Stopped on a repeated failure: the owner chose to go on — the stall ends, the budget comes back.
    const wasStalled = !!goal.stall;
    if (wasStalled) {
      retireGoalCapDecision(goal);
      goal.continuationCount = 0;
    }
    goal.status = 'active';
    goal.updatedAt = Date.now();
    persist(session);
    if (needsOpening) {
      return open(
        request,
        session,
        goal,
        snapshot,
        `▶️ Goal resumed from its first turn: ${fmt(goal.objective)}`,
        'Goal was not resumed',
      );
    }
    if (wasStalled) {
      deps.kickLoop(sessionKey);
      return applied(sessionKey, session, '▶️ Goal resumed — the auto-continuation loop runs again.');
    }
    return applied(sessionKey, session, '▶️ Goal resumed. It will be injected into future prompts.');
  }

  async function complete(request: TaskCommandRequest, session: ConversationSession): Promise<TaskCommandResponse> {
    const { sessionKey, actorUserId } = request;
    const goal = session.goal;
    if (!goal) return applied(sessionKey, session, NO_GOAL);
    const snapshot = snapshotGoalState(session);
    // User-driven completion bypasses the eval model (docs/goal-command/spec.md, "user trust").
    const now = Date.now();
    goal.status = 'complete';
    goal.completedAt = now;
    goal.completedBy = actorUserId;
    goal.completedVia = 'user';
    goal.completionReason = 'user';
    goal.pendingEval = undefined;
    goal.lastEvalReason = undefined;
    retireGoalCapDecision(goal);
    goal.updatedAt = now;
    const next = advanceGoalQueue(session);
    persist(session);
    if (next) {
      return open(
        request,
        session,
        next,
        snapshot,
        `✅ Goal marked complete.\n▶️ Starting next queued goal: ${fmt(next.objective)}`,
        'Goal was not marked complete',
      );
    }
    return applied(sessionKey, session, '✅ Goal marked complete.');
  }

  function clear(sessionKey: string, session: ConversationSession): TaskCommandResponse {
    if (!session.goal && !(session.goalQueue?.length || session.goalHistory?.length)) {
      return applied(sessionKey, session, NO_GOAL);
    }
    const clearedQueue = session.goalQueue?.length ?? 0;
    retireGoalCapDecision(session.goal);
    session.goal = undefined;
    session.goalQueue = [];
    session.goalHistory = [];
    session.goalLastTurnText = undefined;
    persist(session);
    const suffix =
      clearedQueue > 0 ? ` (also cleared ${clearedQueue} queued goal${clearedQueue === 1 ? '' : 's'})` : '';
    return applied(sessionKey, session, `🧹 Goal cleared${suffix}.`);
  }

  function status(sessionKey: string, session: ConversationSession): TaskCommandResponse {
    const queue = session.goalQueue ?? [];
    const history = session.goalHistory ?? [];
    if (!session.goal && queue.length === 0 && history.length === 0) return applied(sessionKey, session, NO_GOAL);
    const lines: string[] = [];
    const goal = session.goal;
    if (goal) {
      const turns = `${goal.continuationCount}/${goal.maxContinuations} auto-continuations`;
      const stalled = goal.stall ? ' · stopped on a repeated failure (`goal resume` runs it again)' : '';
      lines.push(`🎯 Current goal (${goal.status}): ${fmt(goal.objective)} · ${turns}${stalled}`);
    }
    if (queue.length) {
      lines.push(`📋 ${queue.length} queued:`);
      for (const [i, g] of queue.slice(0, STATUS_LIST_LIMIT).entries()) lines.push(`${i + 1}. ${fmt(g.objective)}`);
      if (queue.length > STATUS_LIST_LIMIT) lines.push(`… and ${queue.length - STATUS_LIST_LIMIT} more`);
    }
    if (history.length) lines.push(`✅ ${history.length} completed`);
    // Status changes nothing: answered, not recorded.
    return { status: 200, body: { ok: true, goalCommand: true, message: lines.join('\n') } };
  }

  function setMax(
    sessionKey: string,
    session: ConversationSession,
    actorUserId: string,
    raw: number,
  ): TaskCommandResponse {
    let value: number;
    try {
      value = validateGoalMaxContinuations(raw);
    } catch (error) {
      return invalid(`⚠️ ${(error as Error).message} (1–1000).`);
    }
    deps.settings.setUserGoalMaxContinuations(actorUserId, value);
    const goal = session.goal;
    if (goal && (goal.status === 'active' || goal.status === 'paused')) {
      goal.maxContinuations = value;
      goal.updatedAt = Date.now();
      persist(session);
      return applied(
        sessionKey,
        session,
        `🔢 Goal will now auto-continue up to ${value} turns (was the ${DEFAULT_GOAL_MAX_CONTINUATIONS} default). Applied to the current goal and saved as your default.`,
      );
    }
    // Only the sender's setting changed: answered, not this task's record (#876 R2, grok P2).
    return answered(
      `🔢 New goals will auto-continue up to ${value} turns (default is ${DEFAULT_GOAL_MAX_CONTINUATIONS}).`,
    );
  }

  function toggleAuto(
    sessionKey: string,
    session: ConversationSession,
    actorUserId: string,
    mode?: 'on' | 'off',
  ): TaskCommandResponse {
    let next: boolean;
    if (mode === undefined) next = deps.settings.toggleUserAutoGoalEnabled(actorUserId);
    else {
      next = mode === 'on';
      deps.settings.setUserAutoGoalEnabled(actorUserId, next);
    }
    // A per-user setting: answered, not this task's record (#876 R2, grok P2).
    return answered(
      next
        ? '🤖 Autogoal mode ON. When a session has no active goal, your next instruction becomes the goal automatically.'
        : '🤖 Autogoal mode OFF.',
    );
  }

  async function run(request: TaskCommandRequest, session: ConversationSession): Promise<TaskCommandResponse> {
    const { sessionKey, actorUserId } = request;
    try {
      const action = CommandParser.parseGoalCommand(request.text);
      switch (action.action) {
        case 'status':
          return status(sessionKey, session);
        case 'invalid':
          // Nothing applied — the words are wrong (#876 R2, fable P3): refused with the usage.
          return invalid(USAGE);
        case 'set':
          return await setGoal(request, session, action.objective);
        case 'pause':
          return pause(sessionKey, session);
        case 'resume':
          return await resume(request, session);
        case 'complete':
          return await complete(request, session);
        case 'clear':
          return clear(sessionKey, session);
        case 'auto':
          return toggleAuto(sessionKey, session, actorUserId, action.mode);
        case 'max':
          return setMax(sessionKey, session, actorUserId, action.max);
      }
    } catch (error) {
      return { status: 500, body: { error: `the goal command failed: ${(error as Error)?.message ?? String(error)}` } };
    }
  }

  /** Where the caller saw the goal is where it still is, or the action is stale (409). */
  function assertWhereExpected(session: ConversationSession, goalId: string, expect: 'current' | 'queued'): void {
    const found =
      expect === 'current'
        ? session.goal?.goalId === goalId
        : (session.goalQueue ?? []).some((g) => g.goalId === goalId);
    if (!found) {
      throw new HostGoalActionError(
        409,
        expect === 'current'
          ? 'The current goal has changed — refresh and try again'
          : 'That goal is no longer queued — refresh and try again',
      );
    }
  }

  /** A refused opening start as the goal list's refusal (the status it answers with). */
  function openingRefusal(res: TaskCommandResponse): HostGoalActionError {
    const message = String((res.body as { error?: unknown })?.error ?? `HTTP ${res.status}`);
    const status = ([400, 403, 404, 409] as const).find((s) => s === res.status) ?? 503;
    return new HostGoalActionError(status, message);
  }

  async function hostAction(
    sessionKey: string,
    action: HostGoalAction,
    actorUserId: string,
  ): Promise<HostGoalActionResult> {
    const session = deps.getSession(sessionKey);
    if (!session) throw new HostGoalActionError(404, 'Session not found');
    if (session.terminated || session.closing) throw new HostGoalActionError(409, 'Session is closed');
    const request: TaskCommandRequest = { sessionKey, text: '', actorUserId };

    if (action.action === 'add') {
      const objective = action.objective.trim();
      const problem = validateSessionGoalObjective(objective);
      if (problem) throw new HostGoalActionError(400, problem);
      const repeat = alreadyThere(session, objective);
      if (repeat) throw new HostGoalActionError(409, repeat);
      const snapshot = snapshotGoalState(session);
      const result = enqueueOrActivateGoal(
        session,
        objective,
        actorUserId,
        deps.settings.getUserGoalMaxContinuations(actorUserId),
      );
      if (!result.activated) {
        deps.saveSessions();
        deps.broadcast();
        const position = result.position ?? session.goalQueue?.length ?? 1;
        note(
          sessionKey,
          session,
          `📋 Goal added via dashboard — queued at position ${position}: ${fmt(objective)}` +
            (result.resumedCurrent ? `\n${formatResumedGoalLine(result.resumedCurrent)}` : ''),
        );
        if (result.resumedCurrent) deps.kickLoop(sessionKey);
        return { outcome: 'queued', goalId: result.goal.goalId, position };
      }
      persist(session);
      const res = await open(
        request,
        session,
        result.goal,
        snapshot,
        `🎯 Goal added via dashboard: ${fmt(objective)}`,
        'Goal was not set',
      );
      if (res.status >= 400) throw openingRefusal(res);
      return {
        outcome: 'started',
        goalId: result.goal.goalId,
        opening: (res.body as { queued?: unknown }).queued === true ? 'queued' : 'started',
      };
    }

    const { goalId, expect } = action;
    assertWhereExpected(session, goalId, expect);
    if (expect === 'queued') {
      const removed = session.goalQueue?.find((g) => g.goalId === goalId);
      deleteGoalById(session, goalId);
      deps.saveSessions();
      deps.broadcast();
      note(sessionKey, session, `🗑️ Queued goal removed via dashboard: ${fmt(removed?.objective ?? '')}`);
      return { outcome: 'deleted', goalId };
    }
    const current = session.goal as SessionGoal;
    const snapshot = snapshotGoalState(session);
    // By position, not by id: a completed current goal is also in the history under the same id.
    const deleted = deleteCurrentGoal(session);
    persist(session);
    const gone = `🗑️ Current goal deleted: ${fmt(current.objective)}`;
    if (!deleted.promoted) {
      note(sessionKey, session, gone);
      return { outcome: 'deleted', goalId };
    }
    const promoted = deleted.promoted;
    const res = await open(
      request,
      session,
      promoted,
      snapshot,
      `${gone}\n▶️ Next goal: ${fmt(promoted.objective)}`,
      'Goal was not deleted',
    );
    if (res.status >= 400) throw openingRefusal(res);
    return { outcome: 'deleted', goalId, promoted: { goalId: promoted.goalId, objective: promoted.objective } };
  }

  function openingDropped(
    sessionKey: string,
    session: ConversationSession,
    goalId: string,
    why: 'cancelled' | 'stale',
  ): void {
    const goal = session.goal;
    // A stale opening owes nothing: its goal moved on (cleared, done, deleted, replaced), is paused
    // with its first turn still owed (`goal resume` starts it), or another opening already ran.
    if (why === 'stale') return;
    // Cancelled: only the owed first turn of the current goal pauses it.
    if (!goal || goal.goalId !== goalId || goal.status === 'complete' || goal.openingPending !== true) return;
    goal.status = 'paused';
    retireGoalCapDecision(goal);
    goal.updatedAt = Date.now();
    persist(session);
    note(
      sessionKey,
      session,
      `⏸️ Goal paused — its first turn was cancelled: ${fmt(goal.objective)}\n\`goal resume\` starts it from its first turn; \`goal clear\` drops it.`,
    );
  }

  return {
    matches: (text) => CommandParser.isGoalCommand(text),
    opensGoal: (text) => CommandParser.isGoalCommand(text) && CommandParser.parseGoalCommand(text).action === 'set',
    run,
    hostAction,
    openingDropped,
  };
}
