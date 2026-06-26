/**
 * Issue #1082 T1: shared session-goal apply helpers.
 *
 * Two host-side paths create an ACTIVE goal on a session outside of
 * `GoalHandler.setGoal` (which requires an existing session):
 *
 *   - `src/slack-handler.ts` — goal-prefixed FIRST message: the objective is
 *     parsed before any session exists, carried out-of-band as
 *     `CommandResult.setGoalObjective`, and applied to the freshly created
 *     session BEFORE the first dispatch so turn 1 already runs with the goal
 *     block.
 *   - `packages/slack/src/pipeline/stream-executor.ts` — the SET_GOAL
 *     model-command host-apply branch (#1082 T2).
 *
 * Lives in `@soma/slack` (not the `src/` composition root) because the
 * package tree must be importable from `stream-executor` without a cycle;
 * the structural types below mirror `SessionGoal` in `src/types.ts`.
 */

export type SessionGoalStatus = 'active' | 'paused' | 'complete' | 'queued';

/**
 * Default cap for `maxContinuations`. Mirrors
 * `DEFAULT_GOAL_MAX_CONTINUATIONS` in `src/types.ts` (the package tree
 * cannot import the composition root). See `docs/goal-command/spec.md`
 * §Auto-Continuation Loop.
 */
export const DEFAULT_GOAL_MAX_CONTINUATIONS = 10;

/** Mirrors `MAX_GOAL_HISTORY` in `src/types.ts`. */
export const MAX_GOAL_HISTORY = 20;

/**
 * Structural mirror of `SessionGoal` (`src/types.ts`) — only the fields the
 * apply/queue helpers create, clear, or carry. The real `SessionGoal` is
 * assignable to this shape and vice versa.
 */
export interface SessionGoalState {
  goalId: string;
  objective: string;
  status: SessionGoalStatus;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  continuationCount: number;
  maxContinuations: number;
  evalAttemptCount?: number;
  epoch?: number;
  pendingEval?: { requestedAt: number; turnId: string };
  lastEvalReason?: string;
  lastEvalSummaryHash?: string;
  lastAssistantTurnSummary?: string;
  completedAt?: number;
  completedBy?: string;
  completedVia?: 'user' | 'eval-model';
  completionReason?: string;
  activeMsUsed?: number;
  tokensInput?: number;
  tokensOutput?: number;
  tokensCacheRead?: number;
  tokensCacheCreate?: number;
  costUsd?: number;
}

/**
 * Structural session shape the queue helpers mutate. Mirrors the
 * goal-bearing fields of `ConversationSession` (`src/types.ts`).
 */
export interface GoalQueueSession {
  goal?: SessionGoalState;
  goalQueue?: SessionGoalState[];
  goalHistory?: SessionGoalState[];
  systemPrompt?: string;
  goalLastTurnText?: string;
}

/** Stable id generator — `randomUUID` when available, timestamp+rand fallback. */
function newGoalId(): string {
  try {
    // Avoid a hard import so the package stays bundler-agnostic in tests.
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c?.randomUUID) return c.randomUUID();
  } catch {
    // fall through
  }
  return `goal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Build a fresh ACTIVE goal. The epoch is bumped strictly past the prior
 * goal's epoch (when one exists) so an in-flight completion eval for the
 * replaced goal resolves into a discard, never an apply (M1 — see
 * `src/slack/goal-continuation.ts` `bumpGoalEpoch`). Ralph-loop state starts
 * at zero; `pendingEval` / `lastEvalReason` are intentionally absent — a new
 * objective invalidates any eval cycle staged for the old one.
 */
export function createActiveSessionGoal(
  objective: string,
  userId: string,
  existingGoal?: { epoch?: number },
): SessionGoalState {
  const now = Date.now();
  return {
    goalId: newGoalId(),
    objective,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    createdBy: userId,
    continuationCount: 0,
    maxContinuations: DEFAULT_GOAL_MAX_CONTINUATIONS,
    evalAttemptCount: 0,
    epoch: (existingGoal?.epoch ?? 0) + 1,
  };
}

/**
 * Build a fresh QUEUED goal — identical to an active goal except `status`
 * is `'queued'` (it waits behind the current goal, never injected into the
 * prompt and never drives the loop until promoted). Epoch starts at 0; it is
 * re-based when promoted by {@link advanceGoalQueue}.
 */
export function createQueuedSessionGoal(objective: string, userId: string): SessionGoalState {
  const now = Date.now();
  return {
    goalId: newGoalId(),
    objective,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    createdBy: userId,
    continuationCount: 0,
    maxContinuations: DEFAULT_GOAL_MAX_CONTINUATIONS,
    evalAttemptCount: 0,
    epoch: 0,
  };
}

/**
 * Install `goal` on `session` and invalidate every cached artifact that
 * would otherwise leak pre-goal state into the next turn:
 *
 *   - `systemPrompt` — must be rebuilt so the `<session-goal>` block is
 *     injected (same invalidation `GoalHandler.persistGoalChange` does);
 *   - `goalLastTurnText` — runtime stash of a PRE-goal assistant turn; the
 *     first eval for the new goal must not read it as evidence.
 *
 * Persistence (`claudeHandler.saveSessions()`) is the caller's job.
 */
export function applyGoalToSession(
  session: { goal?: SessionGoalState; systemPrompt?: string; goalLastTurnText?: string },
  goal: SessionGoalState,
): void {
  session.goal = goal;
  session.systemPrompt = undefined;
  session.goalLastTurnText = undefined;
}

/** A goal that is still consuming the loop — active or paused (not closed). */
function isGoalInFlight(goal: SessionGoalState | undefined): boolean {
  return !!goal && (goal.status === 'active' || goal.status === 'paused');
}

/**
 * Resolve a goal by `goalId` across the active goal, the pending queue, and
 * the completed history. Used by per-goal accounting so a turn's spend is
 * credited to the goal that owned the leg even after it has been advanced into
 * `goalHistory`. Returns `undefined` when `goalId` is absent/unknown.
 */
export function findGoalById(session: GoalQueueSession, goalId: string | undefined): SessionGoalState | undefined {
  if (!goalId) return undefined;
  if (session.goal?.goalId === goalId) return session.goal;
  const inQueue = session.goalQueue?.find((g) => g.goalId === goalId);
  if (inQueue) return inQueue;
  return session.goalHistory?.find((g) => g.goalId === goalId);
}

/**
 * THE single entry point for every "user wants a goal" path (typed
 * `goal <text>`, the `SET_GOAL` model-command, and the goal-prefixed first
 * message). Centralizing here is what makes the queue behavior uniform — a
 * second goal request can never silently replace a running goal regardless
 * of which surface it came through.
 *
 *   - If a goal is already in flight (active/paused) → APPEND `objective` to
 *     `goalQueue` as a `queued` goal and return `{ activated: false }`. The
 *     current goal keeps running untouched; the caller posts a "queued"
 *     notice and does NOT start a continuation.
 *   - Otherwise (no goal, or the current one is complete) → activate a fresh
 *     goal via {@link applyGoalToSession} and return `{ activated: true,
 *     goal }`. The caller starts the continuation for it.
 *
 * Persistence is the caller's job.
 */
export function enqueueOrActivateGoal(
  session: GoalQueueSession,
  objective: string,
  userId: string,
): { activated: boolean; goal: SessionGoalState; position?: number } {
  if (isGoalInFlight(session.goal)) {
    const queued = createQueuedSessionGoal(objective, userId);
    session.goalQueue = session.goalQueue ?? [];
    session.goalQueue.push(queued);
    return { activated: false, goal: queued, position: session.goalQueue.length };
  }
  const goal = createActiveSessionGoal(objective, userId, session.goal);
  applyGoalToSession(session, goal);
  return { activated: true, goal };
}

/**
 * Close out the current `session.goal` and promote the next queued goal (if
 * any). Shared by both completion paths — user `goal done` and the eval-model
 * `complete` verdict — so the advance semantics can't drift between them.
 *
 *   1. The current goal (already stamped complete by the caller, or cleared)
 *      is pushed to `goalHistory` (capped at {@link MAX_GOAL_HISTORY}).
 *   2. If `goalQueue` is non-empty, its head is promoted to `session.goal`,
 *      re-based to a fresh active run: `status='active'`, `continuationCount=0`,
 *      `epoch` rebased strictly past the just-finished goal (so a stale eval
 *      for the old goal can never apply), and all per-eval scratch
 *      (`pendingEval`, `lastEvalReason`, `lastEvalSummaryHash`,
 *      `lastAssistantTurnSummary`) cleared. The runtime `goalLastTurnText`
 *      stash is cleared too so the new goal's first eval starts from real
 *      evidence, not the finished goal's last turn.
 *   3. If the queue is empty, `session.goal` is left as the completed goal
 *      (so `goal` status still shows the final result) — set `clear` to
 *      drop it to `undefined` instead.
 *
 * Returns the newly-promoted active goal, or `undefined` when the queue was
 * empty. Persistence is the caller's job.
 */
export function advanceGoalQueue(
  session: GoalQueueSession,
  opts: { clearCurrent?: boolean } = {},
): SessionGoalState | undefined {
  const finished = session.goal;
  if (finished) {
    session.goalHistory = session.goalHistory ?? [];
    // Idempotency: don't double-archive the same goal if `advanceGoalQueue`
    // runs twice for one completion (e.g. re-running `goal done` on an
    // already-complete goal, or a retried eval-complete path).
    const alreadyArchived = session.goalHistory.some((g) => g.goalId === finished.goalId);
    if (!alreadyArchived) {
      session.goalHistory.push(finished);
      if (session.goalHistory.length > MAX_GOAL_HISTORY) {
        session.goalHistory.splice(0, session.goalHistory.length - MAX_GOAL_HISTORY);
      }
    }
  }

  const next = session.goalQueue && session.goalQueue.length > 0 ? session.goalQueue.shift() : undefined;
  if (!next) {
    if (opts.clearCurrent) session.goal = undefined;
    else session.goal = finished; // keep the completed goal visible in status
    session.goalLastTurnText = undefined;
    session.systemPrompt = undefined;
    return undefined;
  }

  const now = Date.now();
  next.status = 'active';
  next.continuationCount = 0;
  next.epoch = (finished?.epoch ?? 0) + 1;
  next.updatedAt = now;
  next.pendingEval = undefined;
  next.lastEvalReason = undefined;
  next.lastEvalSummaryHash = undefined;
  next.lastAssistantTurnSummary = undefined;
  applyGoalToSession(session, next);
  return next;
}

/**
 * Render an objective for a Slack notice: whitespace-normalized, clipped to
 * 900 chars, backticks neutralized, wrapped in inline code. Single source for
 * every goal notice (`GoalHandler`, slack-handler 🎯 notice, SET_GOAL
 * host-apply) so the rendering cannot drift between surfaces.
 */
export function formatGoalObjectiveForSlack(objective: string): string {
  const normalized = objective.replace(/\s+/g, ' ').trim();
  const clipped = normalized.length > 900 ? `${normalized.slice(0, 897)}...` : normalized;
  return `\`${clipped.replace(/`/g, "'")}\``;
}
