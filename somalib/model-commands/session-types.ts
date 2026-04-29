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
 * One per-task dispatch payload extracted from a `plan-to-work` handoff.
 *
 * The planner authored it as a self-contained subagent prompt; the new
 * session passes the `prompt` verbatim into an `Agent` dispatch in z phase 2.
 * The body is delivered inside the handoff under `### <taskId>` wrapped in a
 * **4+-backtick** fenced code block (the 4-tick wrap is mandatory because
 * real planner-authored prompts contain inner triple-backtick code blocks
 * for commit-message HEREDOC, PR body, language-tagged samples; a 3-tick
 * outer fence would terminate at the first inner block and silently
 * truncate the payload). The parser unwraps the outer fence; the `prompt`
 * field carries the body verbatim including any inner 3-tick blocks.
 *
 * `taskId` is the matching id from the handoff's `## Dependency Groups` —
 * e.g. `Group 1: [task-id-A, task-id-B]` and the corresponding
 * `### task-id-A` / `### task-id-B` blocks under `## Per-Task Dispatch Payloads`.
 */
export interface PerTaskDispatchPayload {
  taskId: string;
  prompt: string;
}

/**
 * Plan-time codex review record carried in the handoff for downstream
 * reference. Persisted on `HandoffContext.codexReview` so the new session can
 * reproduce or audit the score that gated phase 1.
 *
 * Free-form `score` (string) is preserved verbatim — common shapes are
 * `"95/100"` or `"95"`. The numeric value is not cross-validated; the
 * verdict text is the producer's APPROVE_FOR_EXECUTION line or equivalent.
 */
export interface CodexReviewRecord {
  score: string;
  verdict: string;
}

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
 * - `originalRequestExcerpt` (from optional `## Original Request Excerpt`;
 *   the user's verbatim instruction excerpt — needed by the new session to
 *   re-verify the Case A escape `no-issue-first` clause)
 * - `repositoryPolicy` (from optional `## Repository Policy`; the area-B
 *   explore report's verdict on whether repo policy requires an issue —
 *   needed by the new session to re-verify Case A escape clause c)
 * - `dependencyGroups` (from required `## Dependency Groups`, plan-to-work
 *   only; the new session needs this to drive per-group parallel dispatch
 *   without reading the working folder's `PLAN.md`)
 * - `perTaskDispatchPayloads` (from required `## Per-Task Dispatch Payloads`,
 *   plan-to-work only; the new session passes each payload verbatim to an
 *   implementer `Agent` dispatch)
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
  /**
   * Plan-to-work only. The user's original SSOT instruction (or an excerpt of
   * it) — carried so the new session can re-verify Case A escape conditions
   * without re-prompting the user. Null when absent or when handoffKind is
   * `work-complete`.
   */
  originalRequestExcerpt: string | null;
  /**
   * Plan-to-work only. The area-B explore report's verdict on whether the
   * repository's CONTRIBUTING / branch-protection / PR-template policy
   * requires every PR to be linked to an issue. The new session uses this to
   * re-verify Case A escape clause (c). Null when absent or when handoffKind
   * is `work-complete`.
   */
  repositoryPolicy: string | null;
  /**
   * Plan-to-work only. Ordered list of dependency groups; each group is an
   * array of `taskId`s that may run in parallel. Across groups is sequential.
   * Empty array on `work-complete` handoffs.
   */
  dependencyGroups: ReadonlyArray<ReadonlyArray<string>>;
  /**
   * Plan-to-work only. Per-task self-contained subagent prompts authored by
   * the planner. The new session looks up `taskId`s from `dependencyGroups`
   * here. Empty array on `work-complete` handoffs.
   */
  perTaskDispatchPayloads: ReadonlyArray<PerTaskDispatchPayload>;
  /**
   * Plan-to-work only. The planner-loop's final codex review record (score +
   * verdict) carried from phase 1.3 — persisted so the new session can
   * surface or audit the gated score without re-running the review. Null
   * when absent or when handoffKind is `work-complete`.
   */
  codexReview: CodexReviewRecord | null;
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
  | 'type-workflow-mismatch'
  /**
   * `plan-to-work` payload structurally invalid even though all required
   * headings are present. Triggered by:
   *   - empty `## Dependency Groups` (no parseable groups)
   *   - empty `## Per-Task Dispatch Payloads` (no parseable tasks)
   *   - groups reference taskIds with no matching `### taskId` payload
   *   - payloads define taskIds not referenced in any group
   *   - a `### taskId` payload body is not wrapped in a **4+-backtick**
   *     (`` ```` … ```` ``) fenced block — the only safe carrier for
   *     self-contained subagent prompts that contain their own ## / ###
   *     headings AND inner triple-backtick code blocks
   * `detail` field carries the specific sub-reason.
   */
  | 'invalid-plan-payload';

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
 * - `active`: currently guiding the model (default)
 * - `todo`: queued for later; still prompt-injected
 * - `completed`: finished — once there are ≥ 2 completed entries the host
 *   summarises them into `session.instructionsCompletedSummary` to keep the
 *   prompt compact.
 */
export type SessionInstructionStatus = 'active' | 'todo' | 'completed';

/**
 * A single user instruction stored as SSOT in the session.
 * Persisted to disk and exposed to the model via GET_SESSION.
 */
export interface SessionInstruction {
  id: string; // Unique ID (e.g., "instr_1712000000000_0")
  text: string; // The instruction content
  addedAt: number; // Unix ms when added
  source?: string; // Who added it (e.g., "user", "model")
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
