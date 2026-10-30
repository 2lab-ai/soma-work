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
  /** ms epoch of a pending cap-reached owner DM decision (S3 dedup guard). */
  capDmPendingAt?: number;
  /** Parked at its auto-continuation budget — see `SessionGoal.capReachedAt` in `src/types.ts`. */
  capReachedAt?: number;
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
 * The current goal sits where the loop parked it at its auto-continuation
 * budget (10/10) and nothing has driven it since. Such a goal never completes
 * on its own, so it must not hold its slot against other goals.
 */
export function isGoalParkedAtCap(goal: SessionGoalState | undefined): boolean {
  return !!goal && goal.status === 'active' && goal.capReachedAt !== undefined;
}

/**
 * A parked goal (queued, or promoted back out of the queue) whose budget is
 * still used up: it must not get a turn until the owner decides (Continue, or
 * a real message that resets the counter). Callers that would start a
 * promoted goal — inject a continuation or admit an opening turn — tell the
 * owner instead ({@link formatOutOfBudgetGoalLine}).
 */
export function isGoalOutOfBudget(goal: SessionGoalState | undefined): boolean {
  return !!goal && goal.capReachedAt !== undefined && goal.continuationCount >= goal.maxContinuations;
}

/** The line a goal-start notice uses for a next goal that {@link isGoalOutOfBudget}. */
export function formatOutOfBudgetGoalLine(goal: SessionGoalState): string {
  return `⏸️ Next goal is back, but it already used its ${goal.maxContinuations}-turn auto-continuation budget: ${formatGoalObjectiveForSlack(goal.objective)}\n_Send a message in this thread to continue it._`;
}

/**
 * Take the goal that should run next out of the queue: the first goal that was
 * never parked at its budget, else the head. A parked goal waits behind every
 * goal that still has its budget.
 */
function nextQueuedGoalIndex(session: GoalQueueSession): number {
  const queue = session.goalQueue;
  if (!queue || queue.length === 0) return -1;
  const fresh = queue.findIndex((g) => g.capReachedAt === undefined);
  return fresh >= 0 ? fresh : 0;
}

/** The goal a completion or delete-current would promote next — see {@link takeNextQueuedGoal}. */
export function peekNextQueuedGoal(session: GoalQueueSession): SessionGoalState | undefined {
  const index = nextQueuedGoalIndex(session);
  return index < 0 ? undefined : session.goalQueue?.[index];
}

function takeNextQueuedGoal(session: GoalQueueSession): SessionGoalState | undefined {
  const index = nextQueuedGoalIndex(session);
  return index < 0 ? undefined : session.goalQueue?.splice(index, 1)[0];
}

/**
 * Install `next` (already taken out of the queue) as the active goal that
 * follows `finished`: `status='active'`, epoch strictly past `finished` (a
 * stale eval for the old goal can never apply), the eval lease and a stale
 * cap DM cleared.
 *
 * A goal that was never parked starts a fresh run: counter 0 and per-eval
 * scratch cleared. A goal parked at its budget comes back as it left — marker,
 * counter and last verdict kept. Finishing or deleting the goal ahead of it is
 * not the owner approving more turns for it (the counter only resets on a real
 * user message or the owner's Continue), so an exhausted one is not started
 * ({@link isGoalOutOfBudget}); the kept verdict lets the loop park it
 * again without a new eval call.
 *
 * The ONE promotion step shared by {@link advanceGoalQueue},
 * {@link deleteCurrentGoal} and {@link yieldParkedGoal}.
 */
function promoteQueuedGoal(
  session: GoalQueueSession,
  next: SessionGoalState,
  finished: SessionGoalState | undefined,
): SessionGoalState {
  next.status = 'active';
  next.epoch = (finished?.epoch ?? 0) + 1;
  next.updatedAt = Date.now();
  next.pendingEval = undefined;
  next.capDmPendingAt = undefined;
  if (next.capReachedAt === undefined) {
    next.continuationCount = 0;
    next.lastEvalReason = undefined;
    next.lastEvalSummaryHash = undefined;
    next.lastAssistantTurnSummary = undefined;
  }
  applyGoalToSession(session, next);
  return next;
}

/**
 * Move a parked current goal to the back of the queue. The marker stays (the
 * loop must never rotate back to it on its own); its pending cap DM is moot
 * now that it is no longer current, and any eval lease belonged to the slot.
 */
function moveParkedGoalToQueueTail(session: GoalQueueSession, goal: SessionGoalState): void {
  goal.status = 'queued';
  goal.capDmPendingAt = undefined;
  goal.pendingEval = undefined;
  goal.updatedAt = Date.now();
  session.goalQueue = session.goalQueue ?? [];
  session.goalQueue.push(goal);
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
 *   - If the current goal is PARKED at its auto-continuation budget
 *     ({@link isGoalParkedAtCap}) → it would never complete and the new goal
 *     would wait forever behind it. Activate the new goal now and move the
 *     parked one to the back of the queue (marker kept). Returns
 *     `{ activated: true, goal, displaced }` so the caller can say where the
 *     parked goal went.
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
): { activated: boolean; goal: SessionGoalState; position?: number; displaced?: SessionGoalState } {
  const current = session.goal;
  const parked = isGoalParkedAtCap(current);
  if (isGoalInFlight(current) && !parked) {
    const queued = createQueuedSessionGoal(objective, userId, maxContinuations);
    session.goalQueue = session.goalQueue ?? [];
    session.goalQueue.push(queued);
    return { activated: false, goal: queued, position: session.goalQueue.length };
  }
  const goal = createActiveSessionGoal(objective, userId, current, maxContinuations);
  if (parked && current) {
    moveParkedGoalToQueueTail(session, current);
    applyGoalToSession(session, goal);
    return { activated: true, goal, displaced: current };
  }
  applyGoalToSession(session, goal);
  return { activated: true, goal };
}

/**
 * The current goal just reached its budget (`cap-paused`, parked). If a goal
 * that was never parked is waiting, the parked goal yields to it: that goal is
 * promoted to a fresh run and the parked goal moves to the back of the queue,
 * marker kept — so the loop never yields BACK to it on its own (A caps → B
 * runs → B caps with only parked A waiting → B parks and asks).
 *
 * Not while the owner has an unanswered "keep going?" DM for this goal: the
 * stop was put to the owner, and a re-evaluation (a restart, a duplicate
 * settle) is not their answer. This only holds back goals parked before this
 * rule existed — a goal the loop drives again always has the DM cleared — and
 * an explicit new goal request still displaces it.
 *
 * Returns `undefined` (nothing changed) when the current goal is not parked,
 * a decision is pending, or no never-parked goal is waiting; the caller then
 * parks as before. Persistence is the caller's job — one write after this.
 */
export function yieldParkedGoal(
  session: GoalQueueSession,
): { promoted: SessionGoalState; yielded: SessionGoalState } | undefined {
  const current = session.goal;
  if (!current || !isGoalParkedAtCap(current)) return undefined;
  if (current.capDmPendingAt !== undefined) return undefined;
  if (!session.goalQueue?.some((g) => g.capReachedAt === undefined)) return undefined;
  const next = takeNextQueuedGoal(session) as SessionGoalState;
  moveParkedGoalToQueueTail(session, current);
  return { promoted: promoteQueuedGoal(session, next, current), yielded: current };
}

/**
 * Close out the current `session.goal` and promote the next queued goal (if
 * any). Shared by both completion paths — user `goal done` and the eval-model
 * `complete` verdict — so the advance semantics can't drift between them.
 *
 *   1. The current goal (already stamped complete by the caller, or cleared)
 *      is pushed to `goalHistory` (capped at {@link MAX_GOAL_HISTORY}).
 *   2. If `goalQueue` is non-empty, the next goal (the first one never parked
 *      at its budget, else the head — {@link takeNextQueuedGoal}) is promoted
 *      to `session.goal` via {@link promoteQueuedGoal}: `status='active'`,
 *      `continuationCount=0` (a parked goal keeps its counter and verdict),
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

  const next = takeNextQueuedGoal(session);
  if (!next) {
    if (opts.clearCurrent) session.goal = undefined;
    else session.goal = finished; // keep the completed goal visible in status
    session.goalLastTurnText = undefined;
    session.systemPrompt = undefined;
    return undefined;
  }

  return promoteQueuedGoal(session, next, finished);
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
 * promoted ({@link promoteQueuedGoal}); the deleted goal is not archived (a
 * deletion is not a completion). Persistence is the caller's job.
 */
export function deleteCurrentGoal(session: GoalQueueSession): { deleted: boolean; promoted?: SessionGoalState } {
  const finished = session.goal;
  if (!finished) return { deleted: false };
  const next = takeNextQueuedGoal(session);
  if (next) {
    return { deleted: true, promoted: promoteQueuedGoal(session, next, finished) };
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
 * The line every goal-start notice adds when the new goal took the slot of a
 * goal parked at its budget ({@link enqueueOrActivateGoal} `displaced`) — so
 * the user sees the old goal was moved, not dropped. Single source for every
 * surface (`goal <text>`, dashboard add, SET_GOAL).
 */
export function formatDisplacedGoalLine(displaced: SessionGoalState): string {
  return `⏭️ The previous goal had used its ${displaced.maxContinuations}-turn auto-continuation budget — moved it to the back of the queue: ${formatGoalObjectiveForSlack(displaced.objective)}`;
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
