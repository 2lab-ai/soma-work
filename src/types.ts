// Session types live in somalib (shared with mcp-servers).
// Re-export for backward compatibility — all src/ files import from './types'.
export type {
  Continuation,
  HandoffContext,
  HandoffKind,
  HandoffParseFailure,
  HandoffTier,
  ParseResult,
  RenewState,
  SaveContextResultFile,
  SaveContextResultPayload,
  SessionInstruction,
  SessionInstructionAddOperation,
  SessionInstructionClearOperation,
  SessionInstructionCompleteOperation,
  SessionInstructionOperation,
  SessionInstructionRemoveOperation,
  SessionInstructionSetStatusOperation,
  SessionInstructionStatus,
  SessionLink,
  SessionLinkHistory,
  SessionLinks,
  SessionResourceAddOperation,
  SessionResourceOperation,
  SessionResourceRemoveOperation,
  SessionResourceSetActiveOperation,
  SessionResourceSnapshot,
  SessionResourceType,
  SessionResourceUpdateRequest,
  SessionResourceUpdateResult,
  UserChoice,
  UserChoiceOption,
  UserChoiceQuestion,
  UserChoices,
  WorkflowType,
} from 'somalib/model-commands/session-types';

import type { SdkUsageBaseline, TaskUsage } from '@soma/slack/session-usage-math';
import type {
  HandoffContext,
  RenewState,
  SaveContextResultPayload,
  SessionInstruction,
  SessionLinkHistory,
  SessionLinks,
  SessionResourceUpdateRequest,
  UserChoice,
  UserChoiceQuestion,
  UserChoices,
  WorkflowType,
} from 'somalib/model-commands/session-types';
import type { AgentRegistry } from './session/agent-registry';
import type { TaskLedger } from './session/task-ledger';
import type { EffortLevel } from './user-settings-store';

/**
 * Session state machine states
 */
export type SessionState = 'INITIALIZING' | 'MAIN' | 'SLEEPING';

/**
 * Bot activity state for a session
 * - working: AI is generating a response (stream active)
 * - waiting: Waiting for user input (choice/permission prompt shown)
 * - idle: Response completed, no active processing
 */
// Shared vocabulary since soma-lib v0.5.0 (convergence roadmap Step 4a) —
// soma's session state machine declares the identical union; re-exported here
// so every existing `from './types'` import path keeps working.
export type { ActivityState } from 'soma-lib';

import type { ActivityState } from 'soma-lib';

/**
 * Token usage tracking for a session.
 *
 * `contextWindow` is now **dynamically updated** from the SDK's
 * `ModelUsage.contextWindow` field when available, instead of being
 * hardcoded to 200k. This correctly reflects Opus 4.6 (1M), Sonnet 4.6
 * (1M), Sonnet 4.5 (200k default / 1M with beta header), etc.
 */
export interface SessionUsage {
  // Current context window state (from most recent request)
  currentInputTokens: number; // Input tokens in most recent request (includes history)
  currentOutputTokens: number; // Output tokens in most recent response
  currentCacheReadTokens: number; // Cache read tokens in current request
  currentCacheCreateTokens: number; // Cache create tokens in current request
  contextWindow: number; // Max context window — dynamically set from SDK (e.g. 1_000_000)

  // Cumulative session totals
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreateTokens: number;
  totalCostUsd: number;

  /**
   * Per-model cumulative totals (input/output/cache write/cache read/cost),
   * keyed by the model id the SDK reported. Survives session model switches —
   * each model keeps its own bucket priced at its own rates. Rendered by the
   * `/context` command. Optional: absent on legacy persisted sessions.
   */
  modelTotals?: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreateTokens: number;
      costUsd: number;
    }
  >;

  /**
   * Spend a result-less turn folded into the totals above, until the next
   * resumed result settles it (`settleFoldedLiveUsage`). Runtime-only.
   */
  foldedLiveUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
    costUsd: number;
    sdkSessionId?: string;
  };

  lastUpdated: number; // Timestamp of last update
}

export interface ActionPanelPRStatus {
  state: string; // 'open' | 'closed' | 'merged'
  mergeable: boolean;
  draft: boolean;
  merged: boolean;
  approved?: boolean; // true if PR has been approved
  head?: string; // source branch
  base?: string; // target branch
  /** Fetch provenance — see `PRStatusInfo.fetchedForUrl` in @soma/slack/action-panel-builder. */
  fetchedForUrl?: string;
  linkStatusAtFetch?: string;
}

export interface ActionPanelState {
  channelId?: string;
  userId?: string;
  threadTs?: string;
  threadLink?: string;
  title?: string;
  styleVariant?: number;
  agentPhase?: string;
  activeTool?: string;
  statusUpdatedAt?: number;
  messageTs?: string;
  choiceMessageTs?: string;
  choiceMessageLink?: string;
  latestResponseTs?: string;
  latestResponseLink?: string;
  turnSummary?: string;
  disabled?: boolean;
  waitingForChoice?: boolean;
  choiceBlocks?: any[];
  /**
   * P3 (PHASE>=3) — pending B3 choice lifecycle record. Authoritative session
   * state for an outstanding user-choice question. Survives turn end and
   * restart (persisted via session-registry). See docs/archive/features/slack-ui/phase3.md.
   */
  pendingChoice?: {
    turnId: string;
    kind: 'single' | 'multi';
    /** Single: message ts. Multi: primary (first form) ts. */
    choiceTs?: string;
    /** Multi only: form ids for all chunks. Empty for single. */
    formIds: string[];
    question: UserChoice | UserChoices;
    createdAt: number;
  };
  /** Raw question data for dashboard rendering (set when ASK_USER_QUESTION fires, cleared on answer) */
  pendingQuestion?: UserChoice | UserChoices;
  renderKey?: string;
  lastRenderedAt?: number;
  prStatus?: ActionPanelPRStatus;
  summaryBlocks?: any[];
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

/**
 * The verified Eagle incident request that owns a session.
 *
 * Structural mirror of `IncidentRequest` in
 * `packages/slack/src/incident-contract.ts` (the SSOT — that module is the
 * only place a request is ever parsed or validated). It is re-declared here
 * because root `src/` resolves `@soma/slack/*` through the workspace symlink
 * to the package's compiled `dist/`, which is not guaranteed to exist when
 * this file is typechecked.
 */
/** The cron job a session was created by (SSOT 2026-10-23). `id` is absent only when the fire carried none. */
export interface SessionCronJob {
  id?: string;
  name: string;
}

export interface SessionIncidentRequest {
  readonly version: 1;
  readonly incident_id: string;
  readonly lifecycle_id: string;
  readonly attempt_id: string;
  readonly channel_id: string;
  readonly parent_ts: string;
  readonly env: string;
  readonly summary: string;
}

/**
 * E2 ① — where a Slack-less task's instruction came from: the channel, the
 * thread's root (`thread_ts ?? ts`), the instruction message itself (a
 * redelivered event is recognised by it) and, when not the main bot, the
 * agent instance that received it.
 */
export interface OriginThread {
  channel: string;
  threadTs: string;
  messageTs: string;
  agent?: string;
}

/** E2 ③ — what a notice to the instruction thread is about. */
export type TaskNoticeKind = 'link' | 'result' | 'question' | 'failure' | 'interrupted';

/**
 * E2 ③ — one notice owed to a task's instruction thread. Its id is
 * deterministic (`<taskId>:<chain or turn>:<kind>[:<askId>]`), so producing
 * it twice is one notice.
 */
export interface TaskNoticeIntent {
  id: string;
  kind: TaskNoticeKind;
  chainId?: string;
  turnId?: string;
  askId?: string;
  outcome?: TaskTurnOutcomeRecord['outcome'];
  reason?: string;
  at: number;
}

/** E2 ③ — how a turn's outcome commit relates to its chain. */
export interface TaskChainSettle {
  chainId: string;
  /** False only for a completed `/compact` hop the chain re-runs after. */
  ends: boolean;
  /**
   * The notice this end owes, when not the outcome's own — a completed
   * `/compact` hop with nothing to re-run is a failure, never a result.
   */
  notice?: { kind: TaskNoticeKind; reason: string };
}

/** E2 ② — a Slack-instructed task's channel context (see `ConversationSession.inputContext`). */
export interface TaskInputContext {
  channelName?: string;
  channelDescription?: string;
  repos?: string[];
  confluenceUrl?: string;
}

/**
 * E4 ⑦ (D10 b) — a child's "closed by its parent" mark. `chain` is the chain the
 * close cancelled (the controller's id, also when the close lands before that
 * chain's first hop is saved): another chain starting ends the mark. A mark with
 * no chain (an older record) ends with any new chain.
 */
export interface ClosedByParent {
  by: 'parent';
  at: number;
  chain?: string;
}

export interface ConversationSession {
  ownerId: string; // User who started the session
  ownerName?: string; // Display name of owner
  currentInitiatorId?: string; // User who triggered the current response
  currentInitiatorName?: string; // Display name of current initiator
  // '' (and no threadTs) for a Slack-less task — see `slackless`.
  channelId: string;
  threadTs?: string;
  /**
   * A task with no Slack channel/thread (#596, `SessionRegistry.createTask`).
   * Its registry key is `task:<taskId>`, not `work:<channel>:<thread>`, and it
   * is saved and on the board from creation, before any SDK session.
   */
  slackless?: boolean;
  /**
   * E2 ① — the Slack thread a Slack-less task was instructed from. Only a
   * Slack-less task carries it; it is NOT a Slack binding (`channelId` /
   * `threadTs` stay empty) and not `sourceThread` (a migrated session's
   * back-pointer). One live task per instruction thread.
   */
  originThread?: OriginThread;
  /**
   * E2 ② — the channel a Slack-instructed task was created in, snapshotted at
   * creation: what a Slack session there gets in its system prompt (channel
   * description, repos, wiki). Prompt text only — never a Slack context.
   */
  inputContext?: TaskInputContext;
  /**
   * E4 ① (.prd/19 D1) — `'epic'` on an epic task; absent on every other
   * session. Set by the host at creation only and never changed. A child is
   * never an epic (depth 1).
   */
  kind?: 'epic';
  /** E4 ① — a child task's epic (its task id). Slack-less tasks only. */
  parentTaskId?: string;
  /** E4 ① — the plan node a child task was made for (a short slug). Set with `parentTaskId`. */
  planNodeId?: string;
  /**
   * E4 ⑦ (D10 b) — a child cancelled because its epic was closed while it ran:
   * saved before its chain was cancelled. The outcome stays `cancelled`; the
   * card reads this to say its parent closed it.
   */
  closedBy?: ClosedByParent;
  /**
   * E4 ⑦ — in memory only, never saved: the dashboard close of this task is
   * under way. An epic being closed takes no wake, no event, no tool call and
   * no new start; a child being closed owes no wake (fable #703 R1).
   */
  closing?: boolean;
  /**
   * E4 ① — an epic's children, by task id, in creation order. Append-only:
   * written in the same strict save that creates the child, never shortened,
   * so a closed or archived child still counts toward the cap.
   */
  childTaskIds?: string[];
  /** E4 ② (.prd/19 D2) — an epic's plan tree; written only through `applyPlanWrite`. */
  plan?: EpicPlan;
  /** E4 ② (.prd/19 D6) — what the epic's children owe it, at most 100; no child text. */
  epicEvents?: EpicEvent[];
  /**
   * E2 ③ — the chain a Slack-less task is running (its id), saved by the
   * chain's first turn start and kept across `/compact` hops; cleared by the
   * chain's last outcome commit or by restart reconciliation. A task still
   * holding one after a restart lost its chain: it is reconciled `interrupted`.
   */
  openChain?: string;
  /**
   * E2 ③ — notices owed to the task's instruction thread, written in the same
   * strict save as the state they describe (only a task with `originThread`).
   * Delivery state lives in the notification ledger, not here.
   */
  notices?: TaskNoticeIntent[];
  sessionId?: string;
  isActive: boolean;
  lastActivity: Date;
  workingDirectory?: string;
  // Session title (auto-generated from first Q&A)
  title?: string;
  // Model used for this session
  model?: string;
  // Session expiry warning tracking
  warningMessageTs?: string;
  lastWarningSentAt?: number; // Which warning interval was last sent (in ms)
  // Legacy field for backward compatibility
  userId: string;
  // Session state machine
  state?: SessionState; // Current state (INITIALIZING -> MAIN)
  workflow?: WorkflowType; // Determined workflow type
  // Token usage tracking
  usage?: SessionUsage;
  /**
   * Last per-model running total the SDK reported for `sessionId` (persisted).
   * A result's `modelUsage` is cumulative for the SDK session, so each turn
   * counts only the growth past this — see `toTurnUsage`.
   */
  sdkUsageBaseline?: SdkUsageBaseline;
  /**
   * SSOT 2026-10-26 T3 — what the whole task spent (main agent + every
   * subagent), across SDK sessions, restarts and resets. Fed the same per-turn
   * spend as `usage.total*`; persisted, never reset. The dashboard card's total.
   */
  taskUsage?: TaskUsage;
  // Renew command state
  renewState?: RenewState;
  // User message to execute after renew (e.g., "/renew PR 리뷰해줘" → "PR 리뷰해줘")
  renewUserMessage?: string;
  // Links attached to this session (issue, PR, doc)
  links?: SessionLinks;
  // History of linked resources
  linkHistory?: SessionLinkHistory;
  // Monotonic sequence for optimistic concurrency on session link updates
  linkSequence?: number;
  /**
   * Monotonic generation token for link-derived title refresh (#762).
   *
   * Incremented on `resetSessionContext` (and any other link-context reset)
   * so fire-and-forget title-refresh jobs that started before the reset
   * abort their write when they wake up — preventing a stale title from a
   * previous session attaching to the new context.
   *
   * Also serves as a URL-set version: callers capture the URL set + generation
   * before the async fetch and re-check both before writing.
   *
   * Persisted to disk so generation stays monotonic across restarts.
   * `undefined` on legacy data is treated as 0 by callers.
   */
  linkRefreshGeneration?: number;
  /**
   * Typed handoff metadata parsed from the `<z-handoff>` sentinel that
   * started this session (issue #695, epic #694). Present only for sessions
   * entered via `forceWorkflow='z-plan-to-work' | 'z-epic-update'`. Consumed
   * by downstream guards (#696/#697/#698) without re-parsing the prompt.
   */
  handoffContext?: HandoffContext;
  /**
   * Host-enforced auto-handoff budget (issue #697, epic #694).
   *
   * Initialized to `DEFAULT_AUTO_HANDOFF_BUDGET` (=1) at session creation.
   * Decremented by 1 each time the session emits a `CONTINUE_SESSION`
   * (auto-handoff) via model-command. When 0, the next emission is rejected
   * by `slack-handler.onResetSession` — it throws `HandoffBudgetExhaustedError`,
   * which the outer try/catch turns into a Slack message; the session stays
   * alive (soft ceiling) so the user can re-enter manually via `$z <url>`.
   *
   * Re-assigned to 1 in `resetSessionContext` so the same sessionKey becomes
   * a fresh logical session with independent budget (spec §Scope "체인 계승이
   * 아닌 독립 예산").
   *
   * `undefined` on deserialization from pre-#697 disk state is treated as 1
   * defensively by `checkAndConsumeBudget` (`?? DEFAULT_AUTO_HANDOFF_BUDGET`).
   *
   * NOTE: `HandoffContext.hopBudget` (#695, seeded to 1 by `parseHandoff`) is
   * informational / diagnostic only. This field is the authoritative store
   * for host enforcement — see `src/slack/handoff-budget.ts`.
   */
  autoHandoffBudget?: number;
  // Tool-driven save result used by renew command (preferred over text parsing)
  renewSaveResult?: SaveContextResultPayload;
  // Ghost Session Fix #99: defense-in-depth flag for in-flight code to self-terminate
  terminated?: boolean;
  // Dashboard: session hidden from dashboard view but kept in conversation list
  trashed?: boolean;
  /**
   * Dashboard star (SSOT 2026-10-30): pinned on top of the board and kept
   * alive — the lifecycle sweep never puts it to sleep or archives it.
   */
  starred?: boolean;
  /**
   * When the star was last removed (epoch ms). The idle clock counts from the
   * later of this and `lastActivity`, so an unstarred session gets a full
   * sleep period instead of sleeping on the next sweep.
   */
  starClearedAt?: number;
  /**
   * #598 ④b — the latest turn's outcome of a Slack-less task (D10), written once
   * per terminal turn by the task runner's strict commit. Current activity wins
   * over it on the dashboard: `working` shows running, `waiting` shows waiting,
   * `idle` reads this.
   */
  lastTurnOutcome?: TaskTurnOutcomeRecord;
  /**
   * #598 ④c — the turn a Slack-less task is running, saved when it starts
   * (`SessionRegistry.beginTaskTurn`) and cleared by its outcome's commit. A
   * task loaded `working` names the turn the process lost (restart
   * reconciliation records it `interrupted`).
   */
  activeTaskTurnId?: string;
  // Sleep mode
  sleepStartedAt?: Date;
  // Conversation history recording ID
  conversationId?: string;
  /**
   * Task id (#595): the address of this task that is not its Slack
   * channel/thread. Minted by SessionRegistry and set on every session it
   * holds; never changes for the life of the task. Lifecycle contract and
   * lookup: `SessionRegistry.getSessionByTaskId`.
   */
  // Only SessionRegistry assigns this (create / load / revive / adoptTaskId) — an assignment elsewhere breaks the task-id index.
  taskId?: string;
  // Bot activity state (working/waiting/idle)
  activityState?: ActivityState;
  activityStateChangedAt?: number;
  /**
   * Restart-notification symmetry marker (#XXX).
   *
   * Set to `true` by `SessionUiManager.notifyShutdown()` after a shutdown
   * notification was successfully posted to this session's Slack thread.
   * The marker is persisted (via `saveSessions`) so that on the next
   * `loadSessions()` we know exactly which sessions were told the service
   * was going down — and can therefore tell the SAME set that the service
   * came back up. Cleared by `notifyCrashRecovery` after the matching
   * restart message is sent.
   *
   * This decouples the "who gets the restart message" decision from the
   * possibly-stale persisted `activityState` (which is intentionally only
   * saved on `idle` transitions to minimize disk I/O).
   */
  shutdownNotificationSent?: boolean;
  /** Epoch ms when `notifyShutdown` recorded the marker. Diagnostic only. */
  shutdownNotifiedAt?: number;
  /**
   * Authoritative auto-resume decision captured at shutdown time.
   * `activityState === 'working'` at the moment of `notifyShutdown` —
   * stored separately because the persisted `activityState` may be stale.
   * Consumed by `notifyCrashRecovery` to decide whether to fire the
   * synthetic auto-resume turn.
   */
  wasWorkingAtShutdown?: boolean;
  actionPanel?: ActionPanelState;
  // Log verbosity bitmask (controls which output types are shown in Slack)
  logVerbosity?: number;
  // Effort level for Claude thinking
  effort?: EffortLevel;
  // Whether extended thinking (adaptive reasoning) is enabled for this session
  thinkingEnabled?: boolean;
  // Whether thinking output is shown in Slack for this session
  showThinking?: boolean;
  // Thread model: user-initiated (default) or bot-initiated (bot creates root message)
  threadModel?: 'user-initiated' | 'bot-initiated';
  // For bot-initiated threads: the root message ts (used for chat.update)
  threadRootTs?: string;
  // Onboarding flag: true when session is an onboarding flow for first-time user
  isOnboarding?: boolean;
  // Session-unique base working directory (auto-created on new session, cleaned up on end)
  sessionWorkingDir?: string;
  /**
   * The cron job whose fire CREATED this session (SSOT 2026-10-23 T1/T3).
   * Stamped once by `SessionInitializer`'s dispatch-bypass branch; a fire
   * injected into an existing session never sets it. The dashboard files the
   * session in the CRON lane under this job. Persisted and archived.
   */
  cronJob?: SessionCronJob;
  /**
   * The title is a placeholder (the cron job name) that the first clear title
   * — the turn summary or a linked issue/PR — may replace (T2). Any explicit
   * title write clears it.
   */
  titleProvisional?: boolean;
  /**
   * The work queue (`config.json#workQueues`, e.g. `deploy-dev2`) this
   * session's work belongs to, set by the work queue gate on its first queued
   * turn. Persisted, so a later turn of the same deploy session — an answer to
   * the deploy confirmation, "다시 배포해줘" — still has to hold the queue's
   * slot after a restart. Cleared by `new`.
   */
  workQueueId?: string;
  /**
   * Set once by `SessionInitializer` from a verified incident turn; makes this
   * session incident-owned (restricted runtime, ordinary traffic refused in
   * the thread). Persisted so a restart cannot launder the restriction away,
   * and deliberately NOT cleared by `resetSessionContext` for the same reason.
   */
  incidentRequest?: SessionIncidentRequest;
  /**
   * `attempt_id` of the incident attempt whose run the HOST observed finish
   * (completion path only — never the model, message text, or a command).
   * The ingress requires it to equal the currently owning attempt before it
   * admits a retry on the same incident parent, and clears it during the
   * handover. Persisted so a restart mid-incident keeps the distinction
   * between "still running" and "finished, retryable".
   */
  incidentAttemptFinishedId?: string;
  // Source working directories created during PR review/fix (tracked for cleanup on session end)
  sourceWorkingDirs?: string[];
  // Compaction-Aware Context Preservation (#196):
  // Set to true when SDK emits compact_boundary; cleared after context is injected into next prompt
  compactionOccurred?: boolean;
  // For bot-initiated threads created from mid-thread mentions:
  // references the original thread where the bot was mentioned
  sourceThread?: {
    channel: string;
    threadTs: string;
  };
  // Bot message ts posted to the SOURCE thread during session init
  // (dispatch status, conversation-history link, etc.). These are the ONLY
  // messages cleaned up on mid-thread migration or channel-route move/stay —
  // model conversation replies are never included here, so they survive migration.
  sourceThreadCleanupTs?: string[];
  // Error auto-retry tracking: count of consecutive retries for the current error sequence.
  // Reset to 0 on successful execution. Max 3 retries with 30s delay between each.
  errorRetryCount?: number;
  // Separate retry counter for file-access-blocked errors.
  // Isolated from errorRetryCount so that prior rate-limit or transient errors
  // don't consume file-access retry budget (and vice versa).
  fileAccessRetryCount?: number;
  // Error context for intelligent retry: when a non-fatal error occurs (e.g., file access blocked),
  // the error message is stored here so the retry prompt can include it, allowing the model
  // to adapt its approach instead of repeating the same failed action.
  lastErrorContext?: string;
  // Handle for pending auto-retry setTimeout — stored so session reset can cancel it (Issue #215).
  // The handle is runtime-only; its due time is persisted as `pendingRetryAt` (#351).
  pendingRetryTimer?: ReturnType<typeof setTimeout>;
  // Epoch ms the scheduled error auto-retry is due (#351). Persisted so startup can
  // re-arm a retry whose timer died with the previous process; cleared when the
  // retry fires or the session resets.
  pendingRetryAt?: number;
  // `sessionId` of the run the pending error auto-retry belongs to (#351). A
  // retry whose run was replaced is dropped instead of resuming the new run.
  // Persisted and cleared together with `pendingRetryAt`.
  pendingRetrySessionId?: string;
  /**
   * What the dashboard card says about the pending error auto-retry next to
   * its due time (`pendingRetryAt`): which attempt of how many, and the first
   * line of the error behind it. Recorded where the retry is armed; persisted
   * and cleared together with `pendingRetryAt`, so a retry re-armed after a
   * restart (#351) still reads "HH:MM 자동 재개 · 시도 n/3".
   */
  pendingRetryDetail?: { attempt?: number; maxAttempts?: number; reason?: string };
  /**
   * Pending personal-skill SKILL.md file roundtrip — set when the user clicks
   * "✏️ 편집" on a skill whose body exceeds `MAX_INLINE_EDIT_CHARS`. The
   * action handler uploads SKILL.md to the thread as an attachment and
   * stashes this marker; the next inbound `file_share` event from the same
   * user in the same thread is intercepted by `event-router.handleFileUpload`,
   * which validates and applies the upload via `updateUserSkill`.
   *
   * `baselineHash` is `computeContentHash` over the SKILL.md bytes the bot
   * uploaded — a stale-guard against the real concurrent-write race: the
   * same user editing the same skill from two threads (or via
   * `MANAGE_SKILL update` from a model turn) between upload-out and
   * upload-in. Without the hash, the second roundtrip's upload would
   * silently clobber the first write. With it, the second is rejected
   * with a clear "skill changed since your edit" notice.
   *
   * Runtime-only (NOT persisted to disk) and explicitly cleared on
   * `clearSessionId` / `resetSessionContext` so `/new` / `/renew` cannot
   * resurrect a stale edit click from the previous logical session.
   * Matches the `pendingRetryTimer` convention; a restart loses the
   * marker and the user re-clicks 편집.
   */
  pendingSkillUpload?: {
    skillName: string;
    requesterId: string;
    baselineHash: string;
    /**
     * Epoch ms; an inbound SKILL.md upload after this is rejected with a
     * TTL-expired notice (NOT silently routed into Claude). TTL is set
     * generously (~24h) since the marker is cheap and the silent-expiry
     * UX is worse than the marker living a bit too long.
     */
    expiresAt: number;
  };
  // Merge code change stats — accumulated from merged PRs in this session
  mergeStats?: {
    totalLinesAdded: number;
    totalLinesDeleted: number;
    mergedPRs: Array<{
      prNumber: number;
      linesAdded: number;
      linesDeleted: number;
      mergedAt: number; // Unix ms
    }>;
  };
  // Task list timestamps for display in thread header
  taskListStartedAt?: number;
  /** Frozen timestamp when all tasks completed (prevents drift on re-render) */
  taskListCompletedAt?: number;
  // System prompt snapshot: the fully-built system prompt used for this session's current query.
  // Stored for admin debugging via "show prompt" command. NOT persisted to disk.
  systemPrompt?: string;
  // User instruction SSOT: stores the original user instruction and follow-ups.
  // Used by the bot to self-verify instruction compliance. NOT persisted to disk.
  initialInstruction?: string;
  followUpInstructions?: Array<{ timestamp: number; text: string; speaker: string }>;

  // User SSOT instructions: structured, model-readable, persisted to disk.
  // Exposed to the model via GET_SESSION and managed via UPDATE_SESSION instructionOperations.
  instructions?: SessionInstruction[];

  // Host-managed long-running objective for this Slack session.
  // Active goals are injected into the system prompt; paused/complete goals
  // remain visible through the `goal` command but do not steer the model.
  goal?: SessionGoal;

  /**
   * Pending goals waiting behind the active `goal` (FIFO). Typing
   * `goal <text>` while a goal is already active/paused APPENDS here instead
   * of replacing the current goal; `advanceGoalQueue` promotes the head to
   * `session.goal` (status → `active`) when the current goal completes. Each
   * entry has `status: 'queued'`. Persisted so the queue survives a restart.
   */
  goalQueue?: SessionGoal[];

  /**
   * Completed (and cleared-on-advance) goals, newest last, capped at
   * `MAX_GOAL_HISTORY` (20, enforced in `@soma/slack/session-goal`). Surfaced
   * by the `goal` status command so each
   * finished goal's time / token spend / completion reason stays visible.
   * Persisted.
   */
  goalHistory?: SessionGoal[];

  /**
   * Runtime-only: the assistant text of the most recently completed turn,
   * stashed by the goal turn-end observer so the idle-settle goal driver
   * can feed it to the completion eval when the session settles. NOT
   * persisted (see SessionRegistry serializer) — the persisted, bounded
   * mirror lives on `goal.lastAssistantTurnSummary` (S8).
   */
  goalLastTurnText?: string;

  /**
   * Cached summary of `completed`-status instructions — used by the
   * user-instructions block builder when there are ≥ 2 completed entries so
   * the system prompt stays compact. `upstreamHash` is a deterministic hash
   * over the completed subset; regenerate when it mismatches.
   * Persisted to disk (survives restarts), runtime-regenerated when stale.
   */
  instructionsCompletedSummary?: { summary: string; upstreamHash: string };

  /**
   * Last rejected instruction write — set when the user clicks `n` on the
   * confirmation button. The next turn's stream-executor injects a
   * `<user-instruction-write-rejected/>` notice into the prompt and clears
   * this flag. Runtime-only — NOT persisted to disk (same convention as
   * `pendingRetryTimer` and `initialInstruction`).
   */
  pendingInstructionRejection?: { at: number; request: SessionResourceUpdateRequest };

  /**
   * How many `<session-title-pending>` notices the stream-executor has injected
   * while the session wore a host stand-in title (voice / image-only first
   * message). Capped by SESSION_TITLE_NOTICE_MAX_TURNS. Runtime-only — NOT
   * persisted (same convention as `pendingInstructionRejection`).
   */
  titleNoticeCount?: number;

  // Dashboard improvements (v2.1):
  // Number of /compact invocations or SDK-triggered compact_boundary events observed on this session.
  compactionCount?: number;
  // Compaction Tracking (#617):
  // Monotonically-incrementing epoch; bumped by START signals (PreCompact hook or `status==='compacting'` fallback).
  compactEpoch?: number;
  // Per-epoch dedupe map for Slack posts (one "starting" + one "complete" per cycle).
  compactPostedByEpoch?: Record<number, { pre: boolean; post: boolean }>;
  // Per-epoch dedupe flag: true when compaction-context rebuild has been scheduled for this epoch.
  compactionRehydratedByEpoch?: Record<number, boolean>;
  // Usage % snapshot captured at PreCompact for the "was ~X%" message.
  preCompactUsagePct?: number | null;
  // Latest observed usage % (updated on every result-message); fallback source for X/Y.
  lastKnownUsagePct?: number | null;
  // #617 followup — SDK-authoritative compaction metrics captured from
  // `compact_metadata` on the SDK `compact_boundary` system message.
  // These are preferred over the heuristic `preCompactUsagePct` /
  // `lastKnownUsagePct` pair because they are measured at the exact
  // SDK-internal pre/post boundary rather than the last turn-end sample.
  // Nullable only when the SDK omits the field (defensive — current SDK
  // versions always provide `pre_tokens`; `post_tokens` and `duration_ms`
  // are optional in the type).
  compactPreTokens?: number | null;
  compactPostTokens?: number | null;
  compactTrigger?: 'manual' | 'auto' | null;
  compactDurationMs?: number | null;
  // #617 followup (live "compacting" indicator): runtime-only fields — NOT
  // serialized to disk (same convention as `pendingRetryTimer`). `…MessageTs`
  // is the Slack message ts of the live "Compaction starting" post; we
  // chat.update it with elapsed time while compacting and flip it to the
  // "completed" state atomically when onCompactBoundary/PostCompact fires.
  // `…StartedAtMs` is the wall-clock at START; `…TickInterval` is the
  // setInterval handle for the ticker (cleared on completion).
  compactStartingMessageTs?: string | null;
  compactStartedAtMs?: number | null;
  compactTickInterval?: ReturnType<typeof setInterval>;
  // Threshold-checker → input-processor signal that next /compact-threshold-violating user turn must be compacted.
  autoCompactPending?: boolean;
  // Runtime-only (not serialized): wall-clock ms until which the threshold-
  // triggered auto-compact stays paused after a `/compact` turn failed —
  // breaks the compact → fail → compact loop. Cleared by a successful
  // compaction. See `pauseAutoCompactAfterFailure` in @soma/slack/compact-state.
  autoCompactSuppressedUntilMs?: number | null;
  // Runtime-only (not serialized): when the running turn was stopped because
  // it crossed the auto-compact threshold (stream-executor, abort reason
  // `auto-compact`), and when the session was last stopped by a stop-class
  // abort (user stop / close / shutdown, slack-handler `beforeAbort`). A stop
  // after the auto-compact stop cancels the automatic continuation.
  autoCompactStoppedAtMs?: number;
  lastStopAtMs?: number;
  /**
   * Session-scoped auto-compact threshold in TOKENS, set by `/autocompact
   * <tokens>` and cleared by `/autocompact reset`. Wins over the model's
   * declared default and over the legacy per-user percent (see
   * `session/autocompact-policy.ts`). Persisted. Deliberately kept verbatim
   * across model switches — the resolver clamps it for the CURRENT model
   * instead of rewriting it, so switching back restores the user's number.
   * `null` / `undefined` = no override.
   */
  autoCompactTokens?: number | null;
  /**
   * SSOT 2026-10-22 T7/T8 — the session's task ledger: every TodoWrite task
   * with its own id, elapsed time and tool-call count, kept across list
   * replacements (see `session/task-ledger.ts`). Persisted.
   */
  taskLedger?: TaskLedger;
  /**
   * Spec 12 — the subagents this session started, each with its own task
   * ledger, tool-call count and status (see `session/agent-registry.ts`). The
   * main agent's tasks stay in {@link taskLedger}. Persisted.
   */
  agents?: AgentRegistry;
  /**
   * SSOT 2026-10-22 T1/T2 — usage of the RUNNING turn, one entry per API
   * message id (each assistant message carries its own call's usage). Folded
   * into the dashboard's totals until the turn's result usage lands in
   * `usage.total*`, then cleared. Runtime-only — NOT persisted.
   */
  liveUsage?: Record<
    string,
    { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number }
  >;
  /** The turn `liveUsage` belongs to (same-session turns can overlap). Runtime-only. */
  liveUsageTurnId?: string;
  /** The latest compact boundary's turn and that turn's `liveUsage` keys before it. Runtime-only. */
  liveUsageBoundary?: { turnId?: string; keys: string[] };
  /**
   * SSOT 2026-10-22 T5 — a dashboard model switch that waits for the compact
   * the current model must run first (context above the target model's
   * auto-compact threshold). Only the compact turn of the message the switch
   * dispatched (`compactTs`) arms it (`armed`); that turn applies it at its
   * boundary, or cancels it when it ends without one — any other compact
   * leaves it alone. Runtime-only — NOT persisted, so a restart cancels it
   * instead of applying it to some unrelated later compact.
   */
  pendingModelSwitch?: { model: string; nickname: string; requestedAt: number; compactTs?: string; armed?: boolean };
  // One-shot suppression for `checkAndSchedulePendingCompact`. Set to `true`
  // by `postCompactCompleteIfNeeded` when a compact cycle seals; cleared by
  // the very next threshold check. Prevents the "Compaction completed →
  // Context usage 83% ≥ threshold 80% (auto-compact loop)" sequence the user
  // reported, where the first post-compact turn's `session.usage` still
  // carries inflated cache-read tokens that re-trip the threshold even
  // though the SDK has actually shrunk the conversation.
  skipThresholdCheckOnce?: boolean;
  // Issue #196 — turn-scoped shield for the occupancy adopted from
  // `compact_boundary.post_tokens`. `StreamProcessor` delivers one usage
  // sample per turn, after the stream loop, so on a compacted turn that
  // sample always predates the boundary and would restore the pre-compact
  // number. Holds the `turnId` that established the shield; cleared by that
  // same turn's `finally` (compare-and-clear) so the NEXT turn resumes normal
  // context tracking.
  //
  // A `turnId` rather than a boolean because same-session turns overlap: a
  // supersede aborts the previous turn's controller without awaiting its
  // `finally`, so an aborted turn must neither suppress the successor's usage
  // sample nor strip the shield the successor just installed.
  postCompactOccupancyTurnId?: string;
  // Slack ts of the just-posted "Compaction completed" message — set ONLY
  // when the message rendered with `now ~?%` because no SDK-authoritative
  // post-compact tokens were available at PostCompact time. The next
  // turn-end usage sample (in `checkAndSchedulePendingCompact`) consumes
  // this ts to chat.update the message in-place with the real post-compact
  // %, then nulls it (one-shot). Honest user-facing recovery for the case
  // where `onCompactBoundary` doesn't supply `post_tokens`.
  compactCompletionMessageTs?: string | null;
  // Prompt-too-long emergency compact fallback. When a non-1M model cannot fit
  // the next prompt before normal threshold compaction fires, the error path
  // temporarily switches `model` to a 1M compact model, retries with `/compact`,
  // then restores the original model after the compact boundary.
  fallbackCompactOriginalModel?: string | null;
  fallbackCompactActive?: boolean;
  // User message that triggered the prompt-too-long fallback. Re-dispatched
  // after the fallback `/compact` finishes, mirroring the normal auto-compact
  // pending-user path.
  fallbackCompactPendingUserText?: string | null;
  fallbackCompactPendingEventContext?: {
    channel: string;
    threadTs: string;
    user: string;
    ts: string;
    verbatimPrompt?: boolean;
  } | null;
  // Wall-clock ms of the last transcript empty-text-block repair attempt
  // (proactive at fallback-compact arming, or reactive on a content-shaped
  // `400 text content blocks must be non-empty`). Bounds the repair→retry
  // loop: within TRANSCRIPT_REPAIR_COOLDOWN_MS a second failure is terminal.
  transcriptRepairAttemptedAtMs?: number | null;
  // Wall-clock ms of the last TERMINAL fallback-compact failure (compaction
  // errored and the original model was restored). `applyAutoFallbackCompact`
  // refuses to re-arm within its cooldown so goal-continuation auto-turns
  // cannot spin an arm→fail→arm notice loop.
  fallbackCompactFailedAtMs?: number | null;
  // User message text captured when auto-compact intercepts the turn; re-dispatched after PostCompact.
  pendingUserText?: string | null;
  // Slack event context captured alongside `pendingUserText` for synthetic re-dispatch via event-router.
  pendingEventContext?: { channel: string; threadTs: string; user: string; ts: string; hostTurn?: boolean } | null;
  // Deferred post-compact re-dispatch queue (arrival order, one entry per
  // author burst). `postCompactCompleteIfNeeded` promotes
  // `pendingUserText`/`pendingEventContext` here when a compact cycle seals;
  // the /compact turn's stream-end cleanup (stream-executor `finally`)
  // consumes it and re-enters the pipeline. Deferral is load-bearing: the
  // PostCompact hook fires BEFORE the CLI persists the compacted transcript,
  // so dispatching from inside the hook lets the new turn's concurrency
  // control abort the still-running /compact process and lose the compaction
  // entirely (observed as `now ~85% ← was ~85%` immediate re-compact loops).
  compactPendingDispatches?: Array<{
    ctx: { channel: string; threadTs: string; user: string; ts: string; verbatimPrompt?: boolean; hostTurn?: boolean };
    text: string;
  }> | null;
  // Runtime-only exact-once guard while the queue is handed back to EventRouter.
  compactDispatchInFlight?: boolean;
  // Runtime-only: true while a dedicated `/compact` SDK turn is executing.
  // Set at query start (local slash command bypass), cleared in the
  // stream-executor `finally`. Covers the post-PostCompact/pre-result window
  // where the epoch marker is already sealed but the CLI has not yet flushed
  // the compacted transcript (codex review F1) and the pre-PreCompact query
  // init window.
  compactTurnActive?: boolean;
  // Wall-clock timestamp (ms) when the current active turn leg started. `undefined` when idle.
  activeLegStartedAtMs?: number;
  /**
   * `goalId` of the goal that was active when the current turn leg STARTED.
   * Captured at `beginTurn` so per-goal time/token accounting credits the
   * goal that owned the leg, even if the goal is completed/advanced before the
   * leg closes (`goal done` mid-turn). Persisted so the load-time orphan sweep
   * credits the right goal. `undefined` when no goal was active at leg start.
   */
  activeLegGoalId?: string;
  /**
   * Intent `epoch` of the goal that was active when the current turn leg
   * STARTED (captured at `beginTurn` alongside {@link activeLegGoalId}). Lets
   * the turn-end goal-evidence stash detect an in-turn objective change
   * (Update bumps the epoch on the same `goalId`) and skip crediting the
   * finished turn's output against the changed objective. `undefined` when no
   * goal was active at leg start.
   */
  activeLegGoalEpoch?: number;
  // Accumulated busy time (ms) across closed legs of the current session.
  activeAccumulatedMs?: number;
  // LLM-generated concise task title (falls back to `title` when absent).
  summaryTitle?: string;
  // Turn id that produced `summaryTitle` — used as a stale-write guard.
  summaryTitleTurnId?: string;
  // Last time `summaryTitle` was regenerated (ms) — used for 60s debounce.
  summaryTitleLastUpdatedAtMs?: number;
  // Last recorded assistant-turn id (monotonic, updated by the recorder).
  // Used as the version token for the stale-write guard in summary-title generation.
  lastAssistantTurnId?: string;

  // Session-scoped disabled dangerous-rule ids. Populated via the Slack
  // "Approve & disable rule for this session" button. The rule catalog is
  // soma-lib's `DANGEROUS_RULES`, re-exported by somalib/permission/dangerous-rules.ts.
  //
  // Runtime-only — intentionally NOT serialized to disk so a restart always
  // re-prompts the user (safety default). Mirrors the `pendingRetryTimer`
  // convention for transient fields.
  //
  // When a rule id is present, `bypassBashPermissionDecision` treats that
  // rule as silenced and degrades its decision from 'ask' to 'allow' when
  // the command matches only that rule. Lockdown rules
  // (`sessionOverridable === false`) ignore this set entirely.
  disabledDangerousRules?: Set<string>;
}

/**
 * Configuration for a sub-agent (independent Slack Bot).
 * Trace: docs/current/plans/multi-agent/trace.md, Scenario 1
 */
export interface AgentConfig {
  slackBotToken: string;
  slackAppToken: string;
  /**
   * OPTIONAL. Verifies the `X-Slack-Signature` header on HTTP delivery only.
   * Every agent runs Socket Mode (outbound wss keyed by `slackAppToken`), so
   * no request signature is exchanged and this may be omitted entirely. When
   * declared it must be at least `SIGNING_SECRET_MIN_LENGTH` chars.
   */
  signingSecret?: string;
  promptDir?: string; // default: src/prompt/{agentName}
  persona?: string; // default: 'default'
  description?: string;
  model?: string; // default: inherit from main bot
}

export interface WorkingDirectoryConfig {
  channelId: string;
  threadTs?: string;
  userId?: string;
  directory: string;
  setAt: Date;
}

/**
 * Pending form state for tracking multi-question selections
 */
export interface PendingChoiceForm {
  formId: string;
  sessionKey: string;
  channel: string;
  threadTs: string;
  messageTs: string;
  questions: UserChoiceQuestion[];
  selections: Map<string, { choiceId: string; label: string }>; // questionId -> selection
  createdAt: number;
}

/**
 * User choice group - wraps multiple UserChoice items
 * Matches the format defined in system.prompt
 */
export interface UserChoiceGroup {
  question: string; // Group title/context
  choices: UserChoice[]; // Array of individual choices
  context?: string; // Why these decisions are needed
}

/** #598 ④b — one terminal turn's outcome, as stored on the session. */
/** E4 ② — a node of an epic's plan tree (.prd/19 D2). */
export interface EpicPlanNode {
  /** A short slug, unique within the epic, never reused for another node. */
  id: string;
  title: string;
  kind: 'issue' | 'sub';
  /** A sub's issue (absent on an issue). */
  parent?: string;
  body?: string;
  /** The epic's verdict on the node (D5); `by` leaves room for an owner verdict later. */
  accepted?: { by: 'epic' | 'owner'; at: number };
  /** The child tasks made for this node, by id — the host's record, never the writer's. */
  spawned?: string[];
}

/** E4 ② — an epic's plan (.prd/19 D2, D10 a). */
export interface EpicPlan {
  nodes: EpicPlanNode[];
  done?: { by: 'epic' | 'owner'; at: number };
  /** Node ids a write removed: never used again for another node (D2). Host-kept. */
  retired?: string[];
}

/**
 * E4 ② — what a child owes its epic (.prd/19 D6): a chain end (its outcome),
 * an approval request (`needs-input`, with `approvalId`; closed by
 * `resolvedAt`) or a close. Never any text the child produced.
 */
export interface EpicEvent {
  /** Deterministic: the child's task id + its chain id (or approval id). */
  id: string;
  childTaskId: string;
  planNodeId: string;
  outcome: TaskTurnOutcomeRecord['outcome'] | 'needs-input' | 'closed';
  chainId?: string;
  turnId?: string;
  approvalId?: string;
  at: number;
  state: 'pending' | 'delivered';
  /** The parent chain that consumed it (D7) — reset to pending if that chain is reconciled interrupted. */
  consumedBy?: string;
  /** An approval request that was answered. */
  resolvedAt?: number;
}

export interface TaskTurnOutcomeRecord {
  turnId: string;
  outcome: 'completed' | 'failed' | 'cancelled' | 'waiting' | 'interrupted';
  category: 'UIUserAskQuestion' | 'WorkflowComplete' | 'Exception' | 'Stalled';
  reason?: string;
  retryable?: boolean;
  recordFailure?: string;
  at: number;
}
