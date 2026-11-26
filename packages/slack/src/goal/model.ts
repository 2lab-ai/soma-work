/**
 * .prd/39 S2 · S3 · 40 §1 — the goal's one model. `SessionGoal` and the types it carries are defined here and only
 * here: `src/types.ts` and `@soma/slack/session-goal` re-export them (the structural mirror `SessionGoalState` that
 * the queue helpers used to keep is now this type).
 */

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
 * A file the goal's opening turn carries: a Slack file in the session's thread, in the shape the message pipeline
 * downloads from (`MessageEvent.files`). Mirrors `SlackEventFile` (`src/conversation/new-task-launcher.ts`).
 */
export interface SessionGoalFile {
  id: string;
  name: string;
  mimetype: string;
  filetype: string;
  url_private: string;
  url_private_download: string;
  size: number;
  permalink?: string;
}

/**
 * `queued` is a goal that has been added to `ConversationSession.goalQueue`
 * but is NOT yet the active goal — it waits behind the current goal and is
 * promoted to `active` by `advanceGoalQueue` when the current goal completes.
 * It is never assigned to `session.goal` directly; every `status !== 'active'`
 * guard (idle-driver gate, `<session-goal>` block injection) already excludes
 * it, so queued goals never drive the loop or leak into the prompt.
 */
export type SessionGoalStatus = 'active' | 'paused' | 'complete' | 'queued';

/**
 * Default cap for `maxContinuations`. Each user-driven turn resets
 * `continuationCount` to 0, so the loop only stops if the model itself
 * keeps the goal active across N synthetic continuation turns in a row
 * without the user intervening. See `docs/goal-command/spec.md`
 * §Auto-Continuation Loop.
 */
export const DEFAULT_GOAL_MAX_CONTINUATIONS = 10;

export type GoalCompletedVia = 'user' | 'eval-model';

export interface SessionGoalPendingEval {
  /** ms epoch when the work model emitted the completion sentinel. */
  requestedAt: number;
  /**
   * Turn-identifying timestamp (typically the synthetic event ts or
   * Slack ts that produced the sentinel). Used for log correlation and
   * to dedupe simultaneous eval triggers from the same turn.
   */
  turnId: string;
}

export interface SessionGoal {
  /**
   * Stable identity for this goal, independent of `createdAt` (which can
   * collide in same-ms test/advance paths). The completion-eval snapshot
   * guard (M1) keys on `goalId` so a verdict can never apply against a
   * different goal that happens to share a `createdAt`. Assigned once at
   * creation and preserved across queue promotion. See
   * `GoalLoopController` and `createActiveSessionGoal`.
   */
  goalId: string;
  objective: string;
  status: SessionGoalStatus;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  completedAt?: number;
  /** Slack userId for user-driven completion, the literal `eval-model` for eval-driven. */
  completedBy?: string;
  /** Audit trail — which path closed this goal. */
  completedVia?: GoalCompletedVia;
  /**
   * Human-readable close-out reason shown in `goal` status history. For
   * eval-driven completion this is the eval verdict `reason`; for
   * user-driven completion (`goal done`) it is the literal `user`.
   */
  completionReason?: string;

  // ── Per-goal accounting (live-accumulated; survives compaction) ────────
  // Credited while THIS goal is the active goal: ms from the turn timer
  // (begin/end/orphan-sweep) and the same aggregate token deltas added to
  // `session.usage.total*`. `session.usage` is reset with the context (`/new`,
  // CONTINUE_SESSION), so we accumulate per-goal at the source rather than diffing.
  /** Wall-clock active turn time attributed to this goal (ms). */
  activeMsUsed?: number;
  tokensInput?: number;
  tokensOutput?: number;
  tokensCacheRead?: number;
  tokensCacheCreate?: number;
  costUsd?: number;

  // ── Ralph loop (auto-continuation) control ─────────────────────────────
  /** How many synthetic continuation turns have fired since the last user message. */
  continuationCount: number;
  /** Cap on `continuationCount` before the host stops auto-firing. */
  maxContinuations: number;
  /** ms epoch of the last continuation injection. */
  lastContinuationAt?: number;
  /**
   * Set to the ms epoch when the cap-reached "continue?" decision opened
   * (S3). The decision is answered from the owner's DM or the dashboard's
   * approval card (`slack/goal-cap-decision.ts`); cleared when the owner
   * answers, or when any real user message / pause / done / completion ends
   * it. Undefined ⇒ no decision pending.
   */
  capDmPendingAt?: number;
  /** The pending decision's round id — carried by the DM buttons and the dashboard card, checked on every answer. */
  capDecisionId?: string;
  /** Where the round's DM landed; stored only after the post succeeded (absent ⇒ the DM is retried). */
  capDmRef?: { channel: string; ts: string };

  /**
   * The goal's opening turn was admitted but has not reached the model yet
   * (set by the host when it admits the opening, cleared right before the
   * opening's model call). While set, cancelling the opening cancels the
   * goal, and `goal resume` re-admits the opening instead of resuming a goal
   * that never had its first turn.
   */
  openingPending?: boolean;
  /**
   * The files the goal was added with from the dashboard's goal composer — already in the session's Slack thread.
   * Every opening turn of this goal carries them (`admitGoalOpeningTurn`), so a queued goal keeps them until it starts.
   */
  openingFiles?: SessionGoalFile[];
  /**
   * The skill part of an objective written with a `$skill` in the dashboard's goal composer (`goal … $skill`, split by
   * `CommandRouter.splitGoalSkill`): the goal's first turn runs it as a command, so the skill is resolved then — when
   * it starts at once, when it is promoted from the queue later, or when a paused goal is resumed.
   */
  openingPrompt?: string;
  /**
   * {@link openingFiles} / {@link openingPrompt} rode a turn of this goal already (its opening, or the first
   * continuation when the loop itself started the goal — an eval verdict promoting it from the queue, a restart
   * repairing a stranded queue). The loop's continuations carry them only while this is unset; an explicit opening
   * (start, promote, resume) always does.
   */
  openingSent?: boolean;
  /**
   * The open task ids the session's task list had when this goal was paused —
   * its own work. While it stays in `goalPaused` they hold no other goal's
   * completion (`src/slack/goal-task-gate.ts`) while the task list they came
   * from (`heldListAt`) is still the latest; taking the slot again clears it.
   */
  heldTaskIds?: string[];
  /** `TaskLedger.updatedAt` of the list `heldTaskIds` were taken from. */
  heldListAt?: number;

  // ── Host-side completion evaluation ────────────────────────────────────
  /**
   * Set when the work model emits `<goal-complete-request reason="..."/>`
   * (or a safety-net natural-language equivalent). While `pendingEval`
   * is set, the ralph loop is paused — the next state change comes from
   * the eval model, not from a continuation turn.
   */
  pendingEval?: SessionGoalPendingEval;
  /**
   * Most recent eval `completed=false` reason. Injected into the next
   * continuation prompt so the work model knows what gap to close.
   * Cleared when the model next emits a completion sentinel (and a new
   * eval cycle starts) or when the user resets the goal.
   */
  lastEvalReason?: string;
  /**
   * The `remaining` list of the same verdict as `lastEvalReason`. Sent back to
   * the evaluator with the reason so it can tell whether the next failure is
   * the same one (goal stall).
   */
  lastEvalRemaining?: string[];
  /**
   * #968 — set when the latest gap is the task gate's (`src/slack/goal-task-gate.ts`): the
   * ids of the tasks that held the goal open. The loop re-judges a reused gate gap once
   * no task is open, and the same ids held twice in a row stop the loop as a stall.
   * Cleared by any other verdict and wherever `lastEvalReason` is cleared.
   */
  lastEvalGateOpen?: string[];
  /**
   * Open while the loop is stopped because the evaluator judged the goal
   * failed again for the same reason (≥ `GOAL_STALL_MIN_CONFIDENCE`). The
   * driver runs no eval and injects no continuation until a real user message
   * (the answer to the stall question, or anything typed) clears it.
   */
  stall?: SessionGoalStall;
  /** #745: where the goal first failed for its current reason, and whether any turn since did new work. */
  firstFailure?: SessionGoalFirstFailure;
  /** Counts how many eval cycles have run for this goal. */
  evalAttemptCount?: number;
  /**
   * Consecutive completion-eval DISPATCH failures (API error / rate limit /
   * timeout — never completed eval cycles). While below
   * `GOAL_EVAL_DISPATCH_MAX_RETRIES` the loop self-heals by scheduling a
   * re-eval after the failure's advertised/backoff delay instead of stopping
   * with a manual `goal done` notice. Cleared by a successful eval dispatch
   * and by any real user message (`resetGoalContinuationOnUserMessage`).
   */
  evalDispatchRetryCount?: number;
  /**
   * ms epoch before which NO eval may dispatch (transient-failure backoff,
   * typically the gateway-advertised 429 window). Ordinary turn-settled
   * triggers that land during the window are skipped — otherwise a queued
   * duplicate settle would re-dispatch immediately and burn the retry budget
   * against the same rate limit. The scheduled retry clears it when it fires;
   * it also self-expires by timestamp so a lost timer (restart) can never
   * wedge the loop. Cleared by a successful dispatch and by any real user
   * message.
   */
  evalBackoffUntil?: number;
  /**
   * The dispatch error behind the current `evalBackoffUntil` window (first
   * line, bounded) — what the dashboard card says the scheduled re-eval is
   * waiting out. Set and cleared together with `evalBackoffUntil`.
   */
  evalRetryReason?: string;

  /**
   * Monotonic intent epoch. Bumped by every goal mutation (set / pause /
   * resume / done / clear) AND by every real (non-synthetic) user message.
   * The completion eval captures this at dispatch and discards its verdict
   * if the epoch moved while the eval was in flight, so a stale verdict can
   * never apply against state the user already moved past. See
   * `GoalLoopController` (M1) and `docs/goal-command/spec.md`.
   */
  epoch?: number;

  /**
   * Persisted, bounded (≤16k chars) copy of the most recent assistant turn
   * summary. Unlike the runtime-only `session.goalLastTurnText` this survives
   * a restart, so the eval on the next post-restart turn-settled trigger has
   * real evidence instead of an empty stash (S8). It is NOT a crash-replay
   * mechanism — it only ensures the next driver run evaluates against real
   * text. `session.goalLastTurnText` takes precedence when present.
   */
  lastAssistantTurnSummary?: string;

  /**
   * Hash of the work summary that produced the most recent `completed=false`
   * verdict. If the next turn's summary is byte-identical, the host skips the
   * (expensive) eval dispatch and reuses the cached "not complete" verdict
   * (S9). Cleared on a `complete` verdict so it never sticks.
   */
  lastEvalSummaryHash?: string;
}
