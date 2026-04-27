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
 * A single user instruction stored as SSOT in the session.
 * Persisted to disk (legacy: `data/sessions.json::session.instructions[]`;
 * sealed master: `data/users/{userId}/user-session.json::instructions[]`)
 * and exposed to the model via GET_SESSION.
 *
 * Both legacy session-scope + sealed user-scope storage share this shape.
 * The user-scope master adds two extra fields beyond the legacy session
 * mirror: `linkedSessionIds` and `sourceRawInputIds`. Those are optional
 * here so legacy sessions can serialize without them.
 *
 * `addedAt` is kept for backward-compatibility; the user-scope store also
 * carries an ISO `createdAt` (see `UserInstruction` in
 * `src/user-session-store.ts`) for sealed schema parity.
 */
export interface SessionInstruction {
  id: string; // Unique ID (e.g., "instr_1712000000000_0")
  text: string; // The instruction content
  addedAt: number; // Unix ms when added (legacy)
  /**
   * Origin of the entry. Legacy free-form string is kept for backward
   * compatibility with older sessions.json payloads; the sealed master
   * tightens this to the enum below (see `UserInstructionSource`).
   */
  source?: string;
  /**
   * Lifecycle status (defaults to 'active' when absent — migration is handled
   * at load time in session-registry.loadSessions).
   */
  status?: SessionInstructionStatus;
  /**
   * Evidence describing why an instruction is `completed` (e.g., PR link,
   * commit SHA, test name). Required at host-side when model asks to mark
   * completed; stripped from prompt injection for brevity.
   */
  evidence?: string;
  /** Unix ms when status transitioned to `completed`. */
  completedAt?: number;
  /** Unix ms when status transitioned to `cancelled` (sealed schema). */
  cancelledAt?: number;
  /**
   * Sessions that have ever been linked to this instruction (sealed schema).
   * Append-only, deduplicated. Optional on legacy session-scope mirrors.
   */
  linkedSessionIds?: string[];
  /**
   * Raw-input back-references populated by #760. Each entry pins a single
   * raw-input row by `{ sessionKey, rawInputId }` so the instruction can be
   * traced back to the user's original message text even after compaction.
   * Optional everywhere until #760 lands.
   */
  sourceRawInputIds?: Array<{ sessionKey: string; rawInputId: string }>;
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
 * Explicitly transition an instruction to a new status (escape hatch).
 * Use `complete` when moving to `completed` so the evidence/timestamp
 * contract is enforced.
 */
export interface SessionInstructionSetStatusOperation {
  action: 'setStatus';
  id: string;
  status: SessionInstructionStatus;
}

export type SessionInstructionOperation =
  | SessionInstructionAddOperation
  | SessionInstructionRemoveOperation
  | SessionInstructionClearOperation
  | SessionInstructionCompleteOperation
  | SessionInstructionSetStatusOperation;

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
