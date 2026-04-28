/**
 * Workflow types for session routing
 */
export type WorkflowType =
  | 'onboarding'
  | 'jira-executive-summary'
  | 'jira-brainstorming'
  | 'jira-planning'
  | 'jira-create-pr'
  | 'pr-review'
  | 'pr-fix-and-update'
  | 'pr-docs-confluence'
  | 'deploy'
  | 'default'
  // z controller session handoff entrypoints (issue #695, epic #694).
  // Host-level enforced: CONTINUE_SESSION.forceWorkflow → SessionInitializer.runDispatch
  // validates the <z-handoff> sentinel and parses typed metadata into
  // ConversationSession.handoffContext before deterministic workflow entry.
  | 'z-plan-to-work'
  | 'z-epic-update';

// ===============================================================
// Session handoff (issue #695) — typed metadata persistence
// ===============================================================

/**
 * Subset of `WorkflowType` carrying the z controller handoff entrypoints.
 * All host-side enforcement (validator precondition, `runDispatch` parse +
 * mapping check, `slack-handler` safe-stop) keys off this discriminator.
 *
 * Type guard `isZHandoffWorkflow` is exported from `handoff-parser.ts` (runtime).
 */
export type ZHandoffWorkflow = 'z-plan-to-work' | 'z-epic-update';

/** Sentinel type attribute → discriminator. */
export type HandoffKind = 'plan-to-work' | 'work-complete';

/** using-epic-tasks tier classification (authoritative: producer). */
export type HandoffTier = 'tiny' | 'small' | 'medium' | 'large' | 'xlarge';

/**
 * Typed handoff context parsed from a `<z-handoff>` sentinel.
 * Persisted on `ConversationSession.handoffContext` so downstream guards
 * (issue-link precondition #696, hop budget #697, dispatch safe-stop #698)
 * can consume the structured state without re-parsing the prompt.
 *
 * Producer-authoritative fields (via `##` headings in the sentinel):
 * - `handoffKind` (from `type="..."` attribute)
 * - `sourceIssueUrl` (from `## Issue` or `## Completed Subissue`)
 * - `parentEpicUrl` (from `## Parent Epic`, plan-to-work only)
 * - `tier` (from optional `## Tier` field; null when absent/unknown)
 * - `escapeEligible` (from optional `## Escape Eligible`; conservative default false)
 * - `issueRequiredByUser` (from optional `## Issue Required By User`; conservative default true)
 *
 * Host-managed fields:
 * - `chainId`: UUID minted by the host parser on each successful parse
 * - `hopBudget`: initialized to 1 here; consumption/decrement is #697 scope
 */
export interface HandoffContext {
  handoffKind: HandoffKind;
  sourceIssueUrl: string | null;
  escapeEligible: boolean;
  tier: HandoffTier | null;
  issueRequiredByUser: boolean;
  parentEpicUrl: string | null;
  chainId: string;
  hopBudget: number;
}

/** Enumerated failure reasons from `parseHandoff`. */
export type HandoffParseFailure =
  | 'no-sentinel'
  | 'duplicate-sentinel'
  | 'malformed-opening'
  | 'missing-closing'
  | 'unknown-type'
  | 'missing-required-field'
  | 'sentinel-not-top-level'
  | 'type-workflow-mismatch';

export type ParseResult =
  | { ok: true; context: HandoffContext }
  | { ok: false; reason: HandoffParseFailure; detail: string };

/**
 * Renew command state
 */
export type RenewState = 'pending_save' | 'pending_load' | null;

/**
 * Continuation for chained execution
 * Allows execute() to return "what to do next" instead of recursing
 */
export interface Continuation {
  prompt: string;
  resetSession?: boolean; // Reset session before executing (triggers re-dispatch)
  dispatchText?: string; // Text to use for dispatch classification (if different from prompt)
  forceWorkflow?: WorkflowType;
  /**
   * Provenance of the continuation (issue #697, epic #694).
   * - `'model'`: emitted via `CONTINUE_SESSION` model-command (auto-handoff); budget-consuming.
   * - `'host'`: built programmatically by host code (renew, onboarding); NOT budget-consuming.
   *
   * Host-stamped only. Any `origin` value the model attempts to supply via the
   * `CONTINUE_SESSION` payload is overwritten at the capture site by the
   * stream-executor spread (`{ ...payload, origin: 'model' }`), so the host is
   * authoritative on this field regardless of what the model sends.
   *
   * The budget guard in `slack-handler.onResetSession` uses the predicate
   * `origin !== 'host'` so that legacy emitters (undefined) AND malformed
   * values (e.g. `'MODEL'`, `'foo'`) fail CLOSED into enforcement. Only the
   * canonical `'host'` value skips the guard.
   */
  origin?: 'model' | 'host';
}

/**
 * Link attached to a session (issue, PR, doc)
 */
export interface SessionLink {
  url: string;
  type: 'issue' | 'pr' | 'doc';
  provider: 'github' | 'jira' | 'confluence' | 'linear' | 'unknown';
  label?: string; // e.g., "PTN-123", "PR #456"
  title?: string; // e.g., "Fix login redirect bug"
  status?: string; // e.g., "open", "merged", "in-progress"
  statusCheckedAt?: number;
}

/**
 * Collection of links attached to a session
 */
export interface SessionLinks {
  issue?: SessionLink;
  pr?: SessionLink;
  doc?: SessionLink;
}

/**
 * History of resources linked to a session.
 * Keeps chronological references while SessionLinks stores active pointers.
 */
export interface SessionLinkHistory {
  issues: SessionLink[];
  prs: SessionLink[];
  docs: SessionLink[];
}

export type SessionResourceType = 'issue' | 'pr' | 'doc';

/**
 * Lifecycle status of a single user instruction.
 *
 * Sealed shape (issue #727 / #754):
 * - `active`: live work — guides the model and may be a session's `currentInstructionId`
 * - `completed`: finished — paired with `evidence` (when the model marked it)
 * - `cancelled`: explicitly stopped by the user; first-class state, NOT
 *   collapsed into `completed` so the dashboard archives view can distinguish
 *   "shipped" from "abandoned".
 *
 * Legacy `'todo'` is migrated to `'active'` at load/migration time
 * (see `src/user-instructions-migration.ts`).
 */
export type SessionInstructionStatus = 'active' | 'completed' | 'cancelled';

/**
 * Source enum for a session-instruction row (sealed #727).
 *
 * - `model`                 — model proposed via UPDATE_SESSION + user y/n confirm (#755)
 * - `user-manual-dashboard` — direct dashboard click (#759); click == confirm
 * - `migration`             — produced by `user-instructions-migration.ts`
 *                             when projecting legacy `sessions.json` rows
 */
export type SessionInstructionSource = 'model' | 'user-manual-dashboard' | 'migration';

/**
 * A single user instruction stored as SSOT in the session.
 *
 * Sealed shape (#727 / #754). Both the legacy session-scope mirror
 * (`data/sessions.json::session.instructions[]`) and the user-scope master
 * (`data/users/{userId}/user-session.json::instructions[]`) share this
 * exact shape so there is one type to read by the prompt block / dashboard
 * / compaction-context builder.
 *
 * The legacy `addedAt` (unix ms number) and free-form `source: string`
 * fields were dropped in favor of the sealed `createdAt` (ISO string) and
 * the `SessionInstructionSource` enum. Pre-#754 disk state is migrated
 * in-memory at load time in `session-registry.loadSessions` — disk
 * compatibility is preserved without leaking the legacy types into the
 * type signature.
 *
 * The instruction itself has NO `evidence` field — completion evidence
 * belongs in the `lifecycleEvents` `op:'complete'` payload (#727 P1-5).
 */
export interface SessionInstruction {
  /** Unique ID (e.g., "instr_1712000000000_0"). */
  id: string;
  /** The instruction content. */
  text: string;
  /** ISO timestamp of creation. */
  createdAt: string;
  /** Origin of the entry (sealed enum). */
  source: SessionInstructionSource;
  /** Lifecycle status. */
  status: SessionInstructionStatus;
  /** ISO timestamp set when status transitions to `completed`. */
  completedAt?: string;
  /** ISO timestamp set when status transitions to `cancelled`. */
  cancelledAt?: string;
  /**
   * Sessions that have ever been linked to this instruction. Append-only,
   * deduplicated. Required on the sealed shape (may be empty `[]`).
   */
  linkedSessionIds: string[];
  /**
   * Raw-input back-references populated by #760. Each entry pins a single
   * raw-input row by `{ sessionKey, rawInputId }`. Required on the sealed
   * shape (may be empty `[]`).
   */
  sourceRawInputIds: Array<{ sessionKey: string; rawInputId: string }>;
}

export interface SessionResourceSnapshot {
  issues: SessionLink[];
  prs: SessionLink[];
  docs: SessionLink[];
  active: SessionLinks;
  instructions: SessionInstruction[];
  sequence: number;
}

export interface SessionResourceAddOperation {
  action: 'add';
  resourceType: SessionResourceType;
  link: SessionLink;
}

export interface SessionResourceRemoveOperation {
  action: 'remove';
  resourceType: SessionResourceType;
  url: string;
}

export interface SessionResourceSetActiveOperation {
  action: 'set_active';
  resourceType: SessionResourceType;
  url?: string;
}

export type SessionResourceOperation =
  | SessionResourceAddOperation
  | SessionResourceRemoveOperation
  | SessionResourceSetActiveOperation;

/**
 * Operations for managing user SSOT instructions in a session.
 *
 * Sealed 5-op lifecycle vocabulary (#755 / parent #727):
 *   `add | link | complete | cancel | rename`
 *
 * `remove`, `clear`, and `setStatus` are escape-hatch / legacy ops kept for
 * backwards compatibility with already-emitted prompts; new code should NOT
 * emit them — every mutation that the user is supposed to authorise must go
 * through one of the 5 sealed ops so the lifecycle audit log stays complete.
 */
export interface SessionInstructionAddOperation {
  action: 'add';
  text: string;
  source?: string; // default: "user"
}

export interface SessionInstructionRemoveOperation {
  action: 'remove';
  id: string;
}

export interface SessionInstructionClearOperation {
  action: 'clear';
}

/**
 * Mark an existing instruction as `completed` with evidence. The host will
 * stamp `completedAt = Date.now()` when applying the op.
 */
export interface SessionInstructionCompleteOperation {
  action: 'complete';
  id: string;
  evidence: string;
}

/**
 * @deprecated Use `complete` / `cancel` instead. `setStatus` is kept only as
 * a legacy escape hatch — new prompts must NOT emit it. Removing it from the
 * union would force a compat break with already-emitted model output.
 */
export interface SessionInstructionSetStatusOperation {
  action: 'setStatus';
  id: string;
  status: SessionInstructionStatus;
}

/**
 * Attach an existing instruction to a NEW session — sealed `link` event
 * (Q2: link is its own lifecycle event, distinct from `add`). Appends the
 * supplied `sessionKey` to the instruction's `linkedSessionIds` (deduped).
 * Does NOT change status, text, or `currentInstructionId` — those moves
 * are the SessionRegistry transaction layer's job (#755).
 */
export interface SessionInstructionLinkOperation {
  action: 'link';
  id: string;
  sessionKey: string;
}

/**
 * Mark an existing instruction as `cancelled` (sealed first-class state,
 * Q3: distinct from `completed`). Stamps `cancelledAt`; clears
 * `completedAt` defensively. The dashboard archives view (#759)
 * distinguishes "shipped" from "abandoned" via this state.
 */
export interface SessionInstructionCancelOperation {
  action: 'cancel';
  id: string;
}

/**
 * Rename an existing instruction. Mutates `text` ONLY — id, status,
 * linkedSessionIds, and source are preserved (Q5: rename is text-only).
 */
export interface SessionInstructionRenameOperation {
  action: 'rename';
  id: string;
  text: string;
}

export type SessionInstructionOperation =
  | SessionInstructionAddOperation
  | SessionInstructionRemoveOperation
  | SessionInstructionClearOperation
  | SessionInstructionCompleteOperation
  | SessionInstructionSetStatusOperation
  | SessionInstructionLinkOperation
  | SessionInstructionCancelOperation
  | SessionInstructionRenameOperation;

export interface SessionResourceUpdateRequest {
  expectedSequence?: number;
  operations?: SessionResourceOperation[];
  /** Operations on user SSOT instructions (add/remove/clear) */
  instructionOperations?: SessionInstructionOperation[];
  /** Update session title (e.g. after linking issue or merging PR) */
  title?: string;
}

export interface SessionResourceUpdateResult {
  ok: boolean;
  reason?: 'SESSION_NOT_FOUND' | 'INVALID_OPERATION' | 'SEQUENCE_MISMATCH';
  error?: string;
  snapshot: SessionResourceSnapshot;
  sequenceMismatch?: {
    expected: number;
    actual: number;
  };
  /**
   * When true, the host deferred `instructionOperations` for user y/n
   * confirmation instead of applying them. Resource operations on the same
   * request are still applied normally.
   */
  instructionsPending?: boolean;
}

export interface SaveContextResultFile {
  name: string;
  content: string;
}

export interface SaveContextResultPayload {
  success?: boolean;
  status?: string;
  id?: string;
  save_id?: string;
  dir?: string;
  path?: string;
  summary?: string;
  title?: string;
  files?: SaveContextResultFile[];
  error?: string;
}

/**
 * User choice option for interactive selection
 */
export interface UserChoiceOption {
  id: string; // Unique ID (e.g., "1", "2", "a", "b")
  label: string; // Short label for button
  description?: string; // Optional longer description
}

/**
 * Single question in a choice form
 */
export interface UserChoiceQuestion {
  id: string; // Unique question ID (e.g., "q1", "auth", "db")
  question: string; // The question being asked
  choices: UserChoiceOption[]; // 2-5 options
  context?: string; // Optional context
  /** ID of the recommended choice option; must match one of choices[].id */
  recommendedChoiceId?: string;
}

/**
 * Structured output for single user choice
 * Claude outputs this JSON when user input is needed
 */
export interface UserChoice {
  type: 'user_choice';
  question: string; // The question being asked
  choices: UserChoiceOption[]; // 2-5 options
  context?: string; // Optional context about why this choice matters
  /** ID of the recommended choice option; must match one of choices[].id */
  recommendedChoiceId?: string;
}

/**
 * Structured output for multiple user choices (form)
 * Claude outputs this JSON when multiple inputs are needed at once
 */
export interface UserChoices {
  type: 'user_choices';
  title?: string; // Form title
  description?: string; // Form description
  questions: UserChoiceQuestion[]; // Multiple questions
}
