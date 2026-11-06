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
 * A stopped goal loop: the evaluator found the same failure as last time. The
 * host asked the owner which of `actions` to do next (Slack + dashboard).
 * Single definition — `src/types.ts` re-exports it.
 */
export interface SessionGoalStall {
  /** Round id carried by the question; an answer for another round is stale. */
  stallId: string;
  stalledAt: number;
  /** The repeated failure reason (the evaluator's words). */
  reason: string;
  /** The three next instructions the evaluator expects the owner to give. */
  actions: string[];
  /** The evaluator's confidence that the failure is the same. */
  confidence: number;
  /** The host question's turn id once posted — its form is retracted when the round ends without an answer. */
  questionTurnId?: string;
  /**
   * #745: where the goal first failed for this reason (a context anchor), offered
   * as a rollback because no turn since did new work. Absent = not offered.
   */
  rollbackAnchor?: string;
  /** How many evaluated turns since the first failure would leave the context. */
  rollbackTurns?: number;
  /** The time of the last entry the rollback keeps (the first failure's), fixed when the offer is made (#744 marks). */
  rollbackKeptUntil?: number;
}

/**
 * #745: where the goal first failed for its current failure reason — the
 * context anchor at the end of that turn — and whether any evaluated turn since
 * did new work. A new reason (or completion) starts it over.
 */
export interface SessionGoalFirstFailure {
  anchor?: string;
  at: number;
  /** Evaluated turns since the first failure (same reason). */
  turns: number;
  /** Some turn since did concrete new work (the evaluator's `progressed`). */
  progressed: boolean;
}

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
   * Open while the loop is stopped on a repeated failure (goal stall, `src/slack/goal-stall.ts`).
   * Ended through the cap-decision retirer, like the cap decision.
   */
  stall?: SessionGoalStall;
  /** The `remaining` list of the verdict behind `lastEvalReason` (goal stall comparison). */
  lastEvalRemaining?: string[];
  /** #968 — the task ids the task gate held the goal open on (see `src/slack/goal-task-gate.ts`). */
  lastEvalGateOpen?: string[];
  /** #745: where the goal first failed for its current reason. */
  firstFailure?: SessionGoalFirstFailure;
  /**
   * The ids of the tasks the session's task list (TodoWrite ledger) had open
   * when this goal was paused — its own unfinished work. While it waits (paused,
   * or resumed into the queue) they hold no other goal's completion
   * (`src/slack/goal-task-gate.ts`); when it takes the current slot again
   * ({@link rebaseGoalAsActive}) it is cleared, so they count for it again.
   * They apply only while the task list they came from is still the latest
   * ({@link heldListAt}): once the running goal writes its own list, every task
   * on it is that goal's — the ledger matches a new task onto an old id by its
   * text, so an id alone does not say whose task it is.
   */
  heldTaskIds?: string[];
  /** The task list (`TaskLedger.updatedAt`) {@link heldTaskIds} were taken from. */
  heldListAt?: number;
  /**
   * The goal's opening turn was admitted but has not reached the model yet
   * (set by the host when it admits the opening, cleared right before the
   * opening's model call). While set, cancelling the opening cancels the
   * goal, and `goal resume` re-admits the opening instead of resuming a goal
   * that never had its first turn.
   */
  openingPending?: boolean;
  evalAttemptCount?: number;
  /** A scheduled completion-eval retry (see `SessionGoal` in `src/types.ts`) — dropped when the goal leaves the slot. */
  evalDispatchRetryCount?: number;
  evalBackoffUntil?: number;
  evalRetryReason?: string;
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
  /**
   * Goals the owner paused, oldest first. A paused goal has left the current
   * slot: it never drives the loop, never blocks the queue, and starts again
   * only when the owner resumes it ({@link resumePausedGoal}).
   */
  goalPaused?: SessionGoalState[];
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

const sameObjective = (a: string, b: string): boolean =>
  a.trim().replace(/\s+/g, ' ') === b.trim().replace(/\s+/g, ' ');

/**
 * Where a goal with this objective already waits: `0` — it is the goal in
 * flight (active or paused); `n` — position `n` of the queue. `undefined` when
 * none does. Whitespace differences do not make a different goal.
 *
 * The SET_GOAL host-apply asks it first: a model that reads the user's
 * request again on a later turn calls SET_GOAL again, and the same goal would
 * queue behind itself (#865, live on dev 2026-11-03).
 */
/**
 * The paused goal (set aside in `goalPaused`) with this objective, if any.
 * The SET_GOAL host-apply asks it after {@link findPendingGoalPosition}: a goal
 * the owner paused is not gone, and a model that reads the request again must
 * not start a second copy of it behind the owner's back.
 */
export function findPausedGoal(session: GoalQueueSession, objective: string): SessionGoalState | undefined {
  return session.goalPaused?.find((g) => sameObjective(g.objective, objective));
}

export function findPendingGoalPosition(session: GoalQueueSession, objective: string): number | undefined {
  if (isGoalInFlight(session.goal) && sameObjective(session.goal?.objective ?? '', objective)) return 0;
  const at = session.goalQueue?.findIndex((g) => sameObjective(g.objective, objective)) ?? -1;
  return at >= 0 ? at + 1 : undefined;
}

/**
 * Resolve a goal by `goalId` across the active goal, the pending queue, the
 * paused goals, and the completed history. Used by per-goal accounting so a turn's spend is
 * credited to the goal that owned the leg even after it has been advanced into
 * `goalHistory`. Returns `undefined` when `goalId` is absent/unknown.
 */
export function findGoalById(session: GoalQueueSession, goalId: string | undefined): SessionGoalState | undefined {
  if (!goalId) return undefined;
  if (session.goal?.goalId === goalId) return session.goal;
  const inQueue = session.goalQueue?.find((g) => g.goalId === goalId);
  if (inQueue) return inQueue;
  // A goal paused mid-turn still owns that turn's spend.
  const paused = session.goalPaused?.find((g) => g.goalId === goalId);
  if (paused) return paused;
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
  // A goal stopped on a repeated failure (stall) is stopped too: a goal
  // request is the owner weighing in, so it runs again — otherwise the new
  // goal would wait behind a goal that can never finish on its own.
  const stalled = goal.status === 'active' && !!goal.stall;
  if (goal.status !== 'active' || (goal.continuationCount < goal.maxContinuations && !stalled)) return false;
  if (stalled) resumedFromStall.add(goal);
  goal.continuationCount = 0;
  // Ends the cap decision AND the stall (the host retirer does both).
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
  goal.stall = undefined;
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
  if (resumedFromStall.delete(goal)) {
    return `▶️ The current goal had stopped on a repeated failure — it runs again now: ${formatGoalObjectiveForSlack(goal.objective)}`;
  }
  return `▶️ The current goal had used its ${goal.maxContinuations}-turn auto-continuation budget without finishing — it runs again now: ${formatGoalObjectiveForSlack(goal.objective)}`;
}

/** Goals {@link resumeGoalStoppedAtBudget} restarted out of a stall (for the notice line). */
const resumedFromStall = new WeakSet<SessionGoalState>();

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

  rebaseGoalAsActive(next, finished?.epoch);
  applyGoalToSession(session, next);
  return next;
}

/**
 * Turn a goal that is taking the current slot into a fresh active run:
 * counter at 0, the epoch strictly past both its own and the goal it replaces
 * (so a stale eval for either can never apply), and every per-eval scratch
 * field cleared. Spend (time, tokens, cost) is kept — it belongs to the goal.
 */
function rebaseGoalAsActive(goal: SessionGoalState, priorEpoch: number | undefined): void {
  goal.status = 'active';
  goal.continuationCount = 0;
  goal.epoch = Math.max(goal.epoch ?? 0, priorEpoch ?? 0) + 1;
  goal.updatedAt = Date.now();
  goal.pendingEval = undefined;
  goal.lastEvalReason = undefined;
  goal.lastEvalRemaining = undefined;
  goal.lastEvalGateOpen = undefined;
  goal.stall = undefined;
  goal.firstFailure = undefined;
  goal.lastEvalSummaryHash = undefined;
  goal.lastAssistantTurnSummary = undefined;
  // In the slot, its own open tasks hold it again.
  goal.heldTaskIds = undefined;
  goal.heldListAt = undefined;
  dropScheduledEval(goal);
}

/**
 * A goal leaving (or re-entering) the current slot carries no eval lease and no
 * scheduled eval retry: the retry is armed for one epoch and the epoch moves
 * with the slot change, so a kept window would only hold the loop's gate shut
 * and keep the dashboard advertising a re-check that never runs.
 */
function dropScheduledEval(goal: SessionGoalState): void {
  goal.pendingEval = undefined;
  goal.evalDispatchRetryCount = undefined;
  goal.evalBackoffUntil = undefined;
  goal.evalRetryReason = undefined;
}

/**
 * Delete a goal by `goalId` from the active slot, the pending queue, the
 * paused goals, or the completed history (S1 — the goal-list Delete button).
 *
 *   - Queued / paused / history goal → removed in place; nothing is promoted.
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
  if (session.goalPaused?.some((g) => g.goalId === goalId)) {
    session.goalPaused = session.goalPaused.filter((g) => g.goalId !== goalId);
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
    rebaseGoalAsActive(next, finished.epoch);
    endGoalCapDecision(next);
    applyGoalToSession(session, next);
    return { deleted: true, promoted: next };
  }
  session.goal = undefined;
  session.goalLastTurnText = undefined;
  session.systemPrompt = undefined;
  return { deleted: true };
}

/**
 * Pause the CURRENT goal: it leaves the current slot for the paused goals
 * (`goalPaused`), and the session moves on — the next queued goal is promoted
 * to a fresh active run, or, with nothing queued, the session is left with no
 * current goal (the loop stops; the work is over until something new starts).
 *
 * The paused goal keeps its spend; its open cap decision / stall ends, its
 * eval lease is dropped and its epoch bumped so an in-flight eval for it
 * resolves into a discard. A goal paused before its first turn ran keeps
 * `openingPending`, so resuming it starts it from that first turn.
 *
 * Accepts an `active` or a `paused` current goal (a goal stopped by the cap
 * decision's Cancel, or one persisted before the paused shelf existed, still
 * sits in the slot as `paused`). Returns `{}` when there is no such goal.
 * Persistence is the caller's job.
 */
export function pauseCurrentGoal(
  session: GoalQueueSession,
  /**
   * The open task ids on the session's task list now and that list's
   * `updatedAt` — the paused goal's own work ({@link SessionGoalState.heldTaskIds}).
   */
  opts: { heldTaskIds?: readonly string[]; heldListAt?: number } = {},
): {
  paused?: SessionGoalState;
  promoted?: SessionGoalState;
} {
  const current = session.goal;
  if (!current || (current.status !== 'active' && current.status !== 'paused')) return {};
  endGoalCapDecision(current);
  current.status = 'paused';
  dropScheduledEval(current);
  current.epoch = (current.epoch ?? 0) + 1;
  current.updatedAt = Date.now();
  // A task another waiting goal already holds stays that goal's: holding it
  // twice would let it escape its owner's gate once the owner runs again.
  // Only a hold on this same list counts — one on an older list no longer applies.
  const heldElsewhere = new Set(
    [...(session.goalPaused ?? []), ...(session.goalQueue ?? [])]
      .filter((g) => g !== current && g.heldListAt === opts.heldListAt)
      .flatMap((g) => g.heldTaskIds ?? []),
  );
  const own = (opts.heldTaskIds ?? []).filter((id) => !heldElsewhere.has(id));
  current.heldTaskIds = own.length ? own : undefined;
  current.heldListAt = own.length ? opts.heldListAt : undefined;
  session.goalPaused = (session.goalPaused ?? []).filter((g) => g.goalId !== current.goalId);
  session.goalPaused.push(current);
  const next = session.goalQueue && session.goalQueue.length > 0 ? session.goalQueue.shift() : undefined;
  if (next) {
    rebaseGoalAsActive(next, current.epoch);
    endGoalCapDecision(next);
    applyGoalToSession(session, next);
    return { paused: current, promoted: next };
  }
  session.goal = undefined;
  session.goalLastTurnText = undefined;
  session.systemPrompt = undefined;
  return { paused: current };
}

/**
 * Undo a pause whose follow-through (the promoted goal's first turn) was
 * refused: the goal state goes back to the snapshot, except the decision round
 * the pause ended. Ending it already withdrew its question and rewrote its DM
 * (the host's retirer), which no restore can put back — so the restored goal
 * comes back without that round, never with one no surface shows. Persistence
 * is the caller's job.
 */
export function undoPause(session: GoalQueueSession, snapshot: GoalStateSnapshot, paused: SessionGoalState): void {
  restoreGoalState(session, snapshot);
  paused.stall = undefined;
  paused.capDmPendingAt = undefined;
  paused.capDecisionId = undefined;
  paused.capDmRef = undefined;
}

/** Where {@link resumePausedGoal} put the goal. */
export type GoalResumePlacement =
  /** No goal was running: it is the current goal now, and the caller starts its turn. */
  | 'current'
  /** A goal is running: it waits at the head of the queue and starts right after that goal. */
  | 'next';

/**
 * Resume a paused goal. `goalId` picks it; without one, the most recently
 * paused goal is resumed. A `paused` CURRENT goal (see {@link pauseCurrentGoal})
 * can be resumed too.
 *
 *   - A goal is running (an `active` current goal) → the resumed goal goes to
 *     the HEAD of the queue (`queued`), so it starts right after the running
 *     goal — the running goal is never interrupted.
 *   - No goal is running (none, a completed one, or a paused one in the slot)
 *     → the resumed goal becomes the current goal, rebased to a fresh active
 *     run. A paused goal that was sitting in the slot moves to the paused goals
 *     first, so nothing is lost. The caller starts the goal's turn.
 *
 * Returns `undefined` when there is no such paused goal. Persistence is the
 * caller's job.
 */
export function resumePausedGoal(
  session: GoalQueueSession,
  goalId?: string,
): { goal: SessionGoalState; placement: GoalResumePlacement } | undefined {
  const shelf = session.goalPaused ?? [];
  const current = session.goal;
  const currentPaused = current?.status === 'paused' ? current : undefined;
  let goal: SessionGoalState | undefined;
  if (goalId === undefined) {
    // The most recently paused of the two places: a goal stopped in place (the
    // cap question's Cancel) after the last one was set aside is the newer one.
    const last = shelf[shelf.length - 1];
    goal =
      last && currentPaused
        ? currentPaused.updatedAt > last.updatedAt
          ? currentPaused
          : last
        : (last ?? currentPaused);
  } else
    goal = shelf.find((g) => g.goalId === goalId) ?? (currentPaused?.goalId === goalId ? currentPaused : undefined);
  if (!goal) return undefined;
  const target = goal;
  session.goalPaused = shelf.filter((g) => g.goalId !== target.goalId);

  if (current?.status === 'active') {
    target.status = 'queued';
    dropScheduledEval(target);
    target.updatedAt = Date.now();
    session.goalQueue = session.goalQueue ?? [];
    session.goalQueue.unshift(target);
    return { goal: target, placement: 'next' };
  }

  if (currentPaused && currentPaused !== target) {
    // The goal paused in the slot is not the one resumed: it joins the paused goals.
    session.goalPaused.push(currentPaused);
  }
  endGoalCapDecision(target);
  rebaseGoalAsActive(target, current?.epoch);
  applyGoalToSession(session, target);
  return { goal: target, placement: 'current' };
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
  goalPaused?: GoalSnapshotEntry[];
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
    goalPaused: session.goalPaused?.map(captureGoal),
    goalHistory: session.goalHistory?.map(captureGoal),
    goalLastTurnText: session.goalLastTurnText,
    systemPrompt: session.systemPrompt,
  };
}

/** Undo a goal mutation — see {@link snapshotGoalState}. Persistence is the caller's job. */
export function restoreGoalState(session: GoalQueueSession, snapshot: GoalStateSnapshot): void {
  session.goal = snapshot.goal ? restoreGoal(snapshot.goal) : undefined;
  session.goalQueue = snapshot.goalQueue?.map(restoreGoal);
  session.goalPaused = snapshot.goalPaused?.map(restoreGoal);
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
