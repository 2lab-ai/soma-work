/**
 * .prd/39 S2 · S3 · 40 §2 — the goal's transitions: create, queue, promote, delete, pause, resume, undo. Each one
 * changes the session's goal fields; the epoch moves only through {@link bumpEpoch}. Saving, broadcasting and driving
 * the loop are the host's (`goal-commit`, PR5). Moved here from `../session-goal` (which re-exports it).
 */
import { formatGoalObjectiveForSlack } from './format';
import {
  DEFAULT_GOAL_MAX_CONTINUATIONS,
  type GoalPhaseFingerprint,
  type GoalQueueSession,
  type GoalStopWhy,
  MAX_GOAL_HISTORY,
  type SessionGoal,
  type StoredGoalPhase,
} from './model';
import { phaseOf } from './read';

type SessionGoalState = SessionGoal;

/**
 * .prd/39 I4 · X9 — move the goal's intent epoch: an in-flight judge discards its verdict, a judge retry armed for the
 * old epoch no-ops, and the retry window ends with it (left in place it held the gate for a wait nobody ends, and the
 * card advertised a re-check that never runs). Every intent change — a goal edit, a cap answer, a pause, a restored
 * archive, a real user message — goes through this one function.
 */
export function bumpEpoch(goal: SessionGoal): void {
  goal.epoch = (goal.epoch ?? 0) + 1;
  goal.evalBackoffUntil = undefined;
  goal.evalRetryReason = undefined;
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
    // .prd/39 D5 · I1 — a completed goal leaves the slot: the history holds it (and the surfaces read it there).
    void opts;
    session.goal = undefined;
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
  goal.holdWhy = undefined; // D6 — no longer held
  // S3 — it starts running again: a stop it carried (loaded, or set before it was held) is not its phase any more.
  goal.phase = undefined;
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
 * Move the QUEUED goal `goalId` to index `to` of `session.goalQueue` (0-based, clamped) — the dashboard's drag.
 * Nothing else changes: the running goal, its epoch and the paused goals are untouched (the queue is not in the
 * prompt). Returns where it was and where it is now; `moved: false` when the goal is not queued. Persistence is the
 * caller's job.
 */
export function moveQueuedGoal(
  session: GoalQueueSession,
  goalId: string,
  to: number,
): { moved: boolean; from: number; to: number } {
  const queue = session.goalQueue ?? [];
  const from = queue.findIndex((g) => g.goalId === goalId);
  if (from < 0) return { moved: false, from: -1, to: -1 };
  const target = Math.min(Math.max(Math.trunc(Number.isFinite(to) ? to : 0), 0), queue.length - 1);
  if (target === from) return { moved: true, from, to: target };
  const next = queue.slice();
  const [goal] = next.splice(from, 1);
  next.splice(target, 0, goal);
  session.goalQueue = next;
  goal.updatedAt = Date.now();
  return { moved: true, from, to: target };
}

/**
 * Replace the objective of the QUEUED goal `goalId` — the dashboard's Edit on a goal that has not started. The caller
 * validates the text. Returns the old objective; `edited: false` when the goal is not queued. Persistence is the
 * caller's job.
 */
export function editQueuedGoal(
  session: GoalQueueSession,
  goalId: string,
  objective: string,
): { edited: boolean; previous?: string } {
  const goal = session.goalQueue?.find((g) => g.goalId === goalId);
  if (!goal) return { edited: false };
  const previous = goal.objective;
  goal.objective = objective;
  goal.updatedAt = Date.now();
  return { edited: true, previous };
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
  bumpEpoch(current);
  current.updatedAt = Date.now();
  holdOpenTasks(session, current, opts);
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
 * Pause the running CURRENT goal so that nothing starts in its place — what a
 * person's stop needs (the dashboard's 중지 with "pause the goal" confirmed):
 * a stopped turn whose goal still runs would only make the goal start its next
 * turn, and a pause that promotes the next queued goal would start that one.
 *
 *   - Nothing queued → the same pause as {@link pauseCurrentGoal}: the goal
 *     moves to the paused goals and the goal work ends.
 *   - Goals queued behind it → it is paused IN PLACE: it keeps the current
 *     slot as `paused` (as the cap question's Cancel leaves it), so the queue
 *     waits behind it instead of its head starting. ▶️ resumes it.
 *
 * Only an `active` current goal is paused; returns `{}` otherwise (nothing is
 * driving the loop). Persistence is the caller's job.
 */
export function pauseCurrentGoalHoldingQueue(
  session: GoalQueueSession,
  /** As for {@link pauseCurrentGoal}: the open tasks the goal leaves on the session's list. */
  opts: { heldTaskIds?: readonly string[]; heldListAt?: number } = {},
): { paused?: SessionGoalState; inPlace?: boolean } {
  const current = session.goal;
  if (current?.status !== 'active') return {};
  if (!session.goalQueue?.length) return { paused: pauseCurrentGoal(session, opts).paused, inPlace: false };
  endGoalCapDecision(current);
  current.status = 'paused';
  current.holdWhy = 'dashboard-stop'; // D6 — held in place: the queue waits behind it
  dropScheduledEval(current);
  bumpEpoch(current);
  current.updatedAt = Date.now();
  // Its open tasks stay its own while it waits, as for a goal set aside: another goal resumed into the slot later
  // must not count them.
  holdOpenTasks(session, current, opts);
  session.systemPrompt = undefined;
  return { paused: current, inPlace: true };
}

/**
 * Record the open tasks a goal leaves as it is paused ({@link SessionGoalState.heldTaskIds}). A task another
 * waiting goal already holds stays that goal's: holding it twice would let it escape its owner's gate once the
 * owner runs again. Only a hold on this same list counts — one on an older list no longer applies.
 */
function holdOpenTasks(
  session: GoalQueueSession,
  goal: SessionGoalState,
  opts: { heldTaskIds?: readonly string[]; heldListAt?: number },
): void {
  const heldElsewhere = new Set(
    [...(session.goalPaused ?? []), ...(session.goalQueue ?? [])]
      .filter((g) => g !== goal && g.heldListAt === opts.heldListAt)
      .flatMap((g) => g.heldTaskIds ?? []),
  );
  const own = (opts.heldTaskIds ?? []).filter((id) => !heldElsewhere.has(id));
  goal.heldTaskIds = own.length ? own : undefined;
  goal.heldListAt = own.length ? opts.heldListAt : undefined;
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

const fingerprintOf = (goal: SessionGoal): GoalPhaseFingerprint => ({
  epoch: goal.epoch ?? 0,
  updatedAt: goal.updatedAt,
  continuationCount: goal.continuationCount,
});

/** The phase as stored: what `phaseOf` reads, with the question named by kind (its fields stay where they are). */
function storedPhaseOf(goal: SessionGoal): StoredGoalPhase | undefined {
  const phase = phaseOf(goal);
  return phase?.kind === 'asking' ? { kind: 'asking', ask: phase.ask.kind } : phase;
}

/**
 * .prd/39 D4 · D17 — the goal as stored. Without the judge's lease (`pendingEval`: a judge lives only in the process
 * that runs it, D4). With its phase and the fingerprint an older version would move (`phaseFp`), written beside the
 * legacy fields. The legacy fields stay on disk while a build that cannot read `phase` may still load the record: such
 * a build that starts a goal's first turn clears only `openingPending`, and a phase-only record would keep `opening`
 * — the loop would never drive that goal (.prd/goal-state/loop.md R2.1).
 */
export function storedGoal<T extends SessionGoal | undefined>(goal: T): T {
  if (!goal) return goal;
  const { pendingEval: _lease, ...rest } = goal as SessionGoal;
  const phase = storedPhaseOf(goal as SessionGoal);
  return { ...rest, phase, phaseFp: fingerprintOf(goal as SessionGoal) } as T;
}

/**
 * .prd/39 D17 — the phase a loaded goal starts with. A phase with a legacy form is recomputed from the legacy fields
 * (an older version changes only those — a first turn starting clears `openingPending`, a retry arms its fields, a cap
 * question opens its fields — without moving the epoch, `updatedAt` or the count), so the stored one is dropped.
 * `stopped` and a hold's `why` have no legacy form: they are kept while the fingerprint matches and the legacy fields
 * say nothing else; an older version that changed the goal moved the fingerprint, and they lapse.
 */
export function settleLoadedPhase(goal: SessionGoal): SessionGoal {
  const fp = goal.phaseFp;
  const unchanged =
    !!fp &&
    fp.epoch === (goal.epoch ?? 0) &&
    fp.updatedAt === goal.updatedAt &&
    fp.continuationCount === goal.continuationCount;
  const legacyRunning = phaseOf({ ...goal, phase: undefined })?.kind === 'running';
  const keepStopped = goal.phase?.kind === 'stopped' && unchanged && legacyRunning;
  const keepHold = goal.holdWhy !== undefined && unchanged && goal.status === 'paused';
  if (goal.phase === undefined && goal.holdWhy === undefined) return goal;
  return {
    ...goal,
    phase: keepStopped ? goal.phase : undefined,
    holdWhy: keepHold ? goal.holdWhy : undefined,
  };
}

/**
 * .prd/39 D5 · I1 — a completed goal does not stay in the slot. A record written before D5 (or by an older version)
 * moves to the history on load and revive; when the history already holds the same goal, it stays one record.
 */
export function settleCompletedSlot(session: GoalQueueSession): void {
  const goal = session.goal;
  if (!goal || goal.status !== 'complete') return;
  const history = (session.goalHistory ??= []);
  if (!history.some((g) => g.goalId === goal.goalId)) {
    history.push(goal);
    if (history.length > MAX_GOAL_HISTORY) history.splice(0, history.length - MAX_GOAL_HISTORY);
  }
  session.goal = undefined;
}

/**
 * .prd/39 S3 · D8 — the loop can no longer drive the goal: it is `stopped{why}` until a person opens it again (their
 * message, `goal resume`). The judge's retry machinery ends with it. Persisting is the caller's.
 */
export function stopGoal(goal: SessionGoal, why: GoalStopWhy, at: number = Date.now()): void {
  goal.phase = { kind: 'stopped', why, at };
  goal.pendingEval = undefined;
  goal.evalBackoffUntil = undefined;
  goal.evalRetryReason = undefined;
  goal.evalDispatchRetryCount = undefined;
  goal.updatedAt = at;
}

/** A person opened a stopped goal again (S3): it runs. Returns whether it was stopped. */
export function reopenStoppedGoal(goal: SessionGoal | undefined, at: number = Date.now()): boolean {
  if (goal?.phase?.kind !== 'stopped') return false;
  goal.phase = undefined;
  goal.updatedAt = at;
  return true;
}
