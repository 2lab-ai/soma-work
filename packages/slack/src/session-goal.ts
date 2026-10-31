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

/** Cap on `goalHistory` length. Single source of truth (the former src/types.ts mirror was removed). */
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
  /** ms epoch the cap-reached "keep going?" decision opened (S3); undefined ⇒ none pending. */
  capDmPendingAt?: number;
  /** The pending decision's round id (DM buttons + dashboard card). */
  capDecisionId?: string;
  /** Where the round's DM landed (stored after a successful post). */
  capDmRef?: { channel: string; ts: string };
  /**
   * The goal's opening turn was admitted but has not reached the model yet
   * (set by the host when it admits the opening, cleared right before the
   * opening's model call). While set, cancelling the opening cancels the
   * goal, and `goal resume` re-admits the opening instead of resuming a goal
   * that never had its first turn.
   */
  openingPending?: boolean;
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
  /**
   * Per-user override for the auto-continuation cap (S4). Undefined ⇒
   * {@link DEFAULT_GOAL_MAX_CONTINUATIONS}. Callers in the composition root
   * resolve this from `userSettingsStore.getUserGoalMaxContinuations`.
   */
  maxContinuations?: number,
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
    maxContinuations: maxContinuations ?? DEFAULT_GOAL_MAX_CONTINUATIONS,
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
export function createQueuedSessionGoal(
  objective: string,
  userId: string,
  maxContinuations?: number,
): SessionGoalState {
  const now = Date.now();
  return {
    goalId: newGoalId(),
    objective,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    createdBy: userId,
    continuationCount: 0,
    maxContinuations: maxContinuations ?? DEFAULT_GOAL_MAX_CONTINUATIONS,
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
 *     current goal keeps its slot; the caller posts a "queued" notice and does
 *     NOT start a continuation for the queued goal.
 *     If the current goal is active but stopped at its auto-continuation
 *     budget (10/10, not complete), this request is the user weighing in — the
 *     same as a chat message: its counter is reset so it runs again, and it is
 *     returned as `resumedCurrent`. The caller re-drives the loop (a goal
 *     command or dashboard add starts no turn whose end would do it).
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
  /** Per-user auto-continuation cap default (S4) applied to the new goal. */
  maxContinuations?: number,
): { activated: boolean; goal: SessionGoalState; position?: number; resumedCurrent?: SessionGoalState } {
  const current = session.goal;
  if (isGoalInFlight(current)) {
    const queued = createQueuedSessionGoal(objective, userId, maxContinuations);
    session.goalQueue = session.goalQueue ?? [];
    session.goalQueue.push(queued);
    const resumedCurrent = current && resumeGoalStoppedAtBudget(current) ? current : undefined;
    return { activated: false, goal: queued, position: session.goalQueue.length, resumedCurrent };
  }
  const goal = createActiveSessionGoal(objective, userId, current, maxContinuations);
  applyGoalToSession(session, goal);
  return { activated: true, goal };
}

/**
 * An ACTIVE goal stopped at its auto-continuation budget gets the budget back:
 * counter to 0 and the pending "keep going?" DM answered. Narrower than
 * `resetGoalContinuationOnUserMessage` on purpose: no epoch bump and no
 * backoff clear — a goal stopped at the cap has no eval in flight and no
 * backoff window (the eval that stopped it succeeded and cleared both).
 * Returns whether it was stopped there. A paused goal is left alone
 * (pausing was explicit).
 */
function resumeGoalStoppedAtBudget(goal: SessionGoalState): boolean {
  if (goal.status !== 'active' || goal.continuationCount < goal.maxContinuations) return false;
  goal.continuationCount = 0;
  endGoalCapDecision(goal);
  goal.updatedAt = Date.now();
  return true;
}

/**
 * Ends a goal's pending cap decision without an answer. The default only
 * clears the decision fields; the host replaces it ({@link setGoalCapDecisionRetirer})
 * so the owner's DM stops offering its buttons too.
 */
let capDecisionRetirer: (goal: SessionGoalState) => void = (goal) => {
  goal.capDmPendingAt = undefined;
  goal.capDecisionId = undefined;
  goal.capDmRef = undefined;
};

/** Wire the host's cap-decision retirement (production: `retireGoalCapDecision`). */
export function setGoalCapDecisionRetirer(fn: (goal: SessionGoalState) => void): void {
  capDecisionRetirer = fn;
}

/** End the goal's pending cap decision (if any) without an answer. */
export function endGoalCapDecision(goal: SessionGoalState | undefined): void {
  if (goal) capDecisionRetirer(goal);
}

/**
 * The line a "goal queued" notice adds when the request gave the current goal
 * its budget back ({@link enqueueOrActivateGoal} `resumedCurrent`). Single
 * source for every surface.
 */
export function formatResumedGoalLine(goal: SessionGoalState): string {
  return `▶️ The current goal had used its ${goal.maxContinuations}-turn auto-continuation budget without finishing — it runs again now: ${formatGoalObjectiveForSlack(goal.objective)}`;
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
 * Delete a goal by `goalId` from the active slot, the pending queue, or the
 * completed history (S1 — the goal-list Delete button).
 *
 *   - Queued / history goal → removed in place; nothing is promoted.
 *   - Active goal → dropped (NOT archived to history — a deletion is not a
 *     completion) and the next queued goal (if any) is promoted to active,
 *     rebased to a fresh run exactly like {@link advanceGoalQueue} does. This
 *     is the "현재 진행중인 goal을 삭제하면 자동으로 다음 goal로 진행" requirement.
 *
 * Returns whether anything was deleted, whether it was the active goal, and
 * the promoted goal (if the active goal was deleted and the queue was
 * non-empty). Persistence is the caller's job.
 */
export function deleteGoalById(
  session: GoalQueueSession,
  goalId: string,
): { deleted: boolean; wasActive: boolean; promoted?: SessionGoalState } {
  if (session.goalQueue?.some((g) => g.goalId === goalId)) {
    session.goalQueue = session.goalQueue.filter((g) => g.goalId !== goalId);
    return { deleted: true, wasActive: false };
  }
  if (session.goalHistory?.some((g) => g.goalId === goalId)) {
    session.goalHistory = session.goalHistory.filter((g) => g.goalId !== goalId);
    return { deleted: true, wasActive: false };
  }
  if (session.goal?.goalId === goalId) {
    return { ...deleteCurrentGoal(session), wasActive: true };
  }
  return { deleted: false, wasActive: false };
}

/**
 * Delete the CURRENT goal (`session.goal`) whatever its status — the
 * dashboard's "delete current goal". Unlike {@link deleteGoalById} it never
 * resolves the id against the history first: after the last goal completes,
 * the same goal sits in both `session.goal` and `goalHistory`, and deleting by
 * id would only drop the history row. The next queued goal (if any) is
 * promoted to a fresh active run; the deleted goal is not archived (a
 * deletion is not a completion). Persistence is the caller's job.
 */
export function deleteCurrentGoal(session: GoalQueueSession): { deleted: boolean; promoted?: SessionGoalState } {
  const finished = session.goal;
  if (!finished) return { deleted: false };
  // The deleted goal's open "keep going?" decision ends with it.
  endGoalCapDecision(finished);
  const next = session.goalQueue && session.goalQueue.length > 0 ? session.goalQueue.shift() : undefined;
  if (next) {
    const now = Date.now();
    next.status = 'active';
    next.continuationCount = 0;
    next.epoch = (finished.epoch ?? 0) + 1;
    next.updatedAt = now;
    next.pendingEval = undefined;
    next.lastEvalReason = undefined;
    next.lastEvalSummaryHash = undefined;
    next.lastAssistantTurnSummary = undefined;
    endGoalCapDecision(next);
    applyGoalToSession(session, next);
    return { deleted: true, promoted: next };
  }
  session.goal = undefined;
  session.goalLastTurnText = undefined;
  session.systemPrompt = undefined;
  return { deleted: true };
}

/** One goal object as it was: the object itself plus a deep copy of its fields. */
interface GoalSnapshotEntry {
  ref: SessionGoalState;
  fields: SessionGoalState;
}

/** Everything a goal mutation touches, captured by {@link snapshotGoalState}. */
export interface GoalStateSnapshot {
  goal?: GoalSnapshotEntry;
  goalQueue?: GoalSnapshotEntry[];
  goalHistory?: GoalSnapshotEntry[];
  goalLastTurnText?: string;
  systemPrompt?: string;
}

const captureGoal = (goal: SessionGoalState): GoalSnapshotEntry => ({
  ref: goal,
  fields: structuredClone({ ...goal }),
});

/** Put a goal object's fields back IN PLACE and return the same object. */
function restoreGoal(entry: GoalSnapshotEntry): SessionGoalState {
  const target = entry.ref as unknown as Record<string, unknown>;
  for (const key of Object.keys(target)) {
    if (!(key in entry.fields)) delete target[key];
  }
  Object.assign(target, entry.fields);
  return entry.ref;
}

/**
 * The goal-bearing session fields, taken right before a goal mutation whose
 * follow-through (admitting the goal's opening turn) can still fail.
 * {@link restoreGoalState} puts the session back exactly — epochs included —
 * so a refused admission never leaves an ACTIVE goal behind with no opening
 * turn and nothing to drive it.
 *
 * Object IDENTITY is part of "exactly": the completion eval holds the goal
 * object it was dispatched for and applies its verdict to that object, so the
 * restore writes the saved fields back into the same objects and re-installs
 * them, instead of installing copies the in-flight eval would never see.
 */
export function snapshotGoalState(session: GoalQueueSession): GoalStateSnapshot {
  return {
    goal: session.goal ? captureGoal(session.goal) : undefined,
    goalQueue: session.goalQueue?.map(captureGoal),
    goalHistory: session.goalHistory?.map(captureGoal),
    goalLastTurnText: session.goalLastTurnText,
    systemPrompt: session.systemPrompt,
  };
}

/** Undo a goal mutation — see {@link snapshotGoalState}. Persistence is the caller's job. */
export function restoreGoalState(session: GoalQueueSession, snapshot: GoalStateSnapshot): void {
  session.goal = snapshot.goal ? restoreGoal(snapshot.goal) : undefined;
  session.goalQueue = snapshot.goalQueue?.map(restoreGoal);
  session.goalHistory = snapshot.goalHistory?.map(restoreGoal);
  session.goalLastTurnText = snapshot.goalLastTurnText;
  // The cached prompt was built against the restored goal; keeping it is safe
  // because the snapshot is the same state the cache was built for.
  session.systemPrompt = snapshot.systemPrompt;
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
