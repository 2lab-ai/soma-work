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
  label?: string; // e.g., "PROJ-123", "PR #456"
  title?: string; // e.g., "Fix login redirect bug"
  status?: string; // e.g., "open", "merged", "in-progress"
  statusCheckedAt?: number;
  /** Recorded from the conversation (세션 링크 자동 기록), not set by the model or the user: only these are trimmed. */
  auto?: boolean;
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

/** A layer of a session's code changes (.prd/26 §3): not committed, committed but in no session PR, an open PR, merged. */
export type CodeChangeLayer = 'uncommitted' | 'committed' | 'pr' | 'merged';
export type CodeChangePrState = 'open' | 'draft' | 'merged' | 'closed';
export interface CodeChangeTotals {
  files: number;
  additions: number;
  deletions: number;
}

/**
 * .prd/26 §6 — what the session's code changes come to, as counts and a few paths (never a patch): the session keeps it,
 * the board stamps it, the model reads it (GET_SESSION `session.codeChanges`, the turn context's uncommitted line).
 */
export interface CodeChangesSummary {
  /** When it was collected (epoch ms) — the last turn end, or a dashboard refresh. */
  updatedAt: number;
  layers: Record<CodeChangeLayer, CodeChangeTotals>;
  repos: Array<{
    repo: string;
    dir?: string;
    branch?: string;
    uncommitted: CodeChangeTotals;
    committed: CodeChangeTotals & { commits: number };
    /** The first paths of the uncommitted, then committed, layer (≤ 8). */
    paths: string[];
    skipped?: string;
  }>;
  prs: Array<{
    url: string;
    number: number;
    repo: string;
    state: CodeChangePrState;
    additions: number;
    deletions: number;
    changedFiles: number;
  }>;
}

/**
 * .prd/29 — the session's issue tree: external issues (GitHub · Jira …), issues that live only in this session
 * (internal), and PRs. Every session has an issue node; no PR is a root (its parent is an issue or a PR). The host keeps
 * the invariants (`rebalanceIssueTree`); the model shapes the tree through UPDATE_SESSION (`parent`, `add_internal`,
 * `move`, `remove`).
 */
export type IssueTreeNodeKind = 'issue' | 'pr';
export type IssueTreeSource = 'github' | 'jira' | 'linear' | 'confluence' | 'internal' | 'unknown';
/** Why a node sits where it sits: `model` is the model's choice (the host never moves it); the rest are the host's. */
export type IssueTreePlacement = 'model' | 'sub-issue' | 'closes' | 'stack' | 'default' | 'seed';
/** Relations the host knows from GitHub (node ids): the parent issue, the issues a PR closes, the PR a PR is stacked on. */
export interface IssueTreeRelations {
  subOf?: string;
  closes?: string[];
  base?: string;
}
export interface IssueTreeNode {
  /** An external node's canonical URL (`issueTreeNodeId`), or `internal:<n>`. */
  id: string;
  kind: IssueTreeNodeKind;
  source: IssueTreeSource;
  url?: string;
  label?: string;
  /** Absent on the seed: it shows the session's title. */
  title?: string;
  status?: string;
  /** The parent node's id; absent = a root. */
  parent?: string;
  placed: IssueTreePlacement;
  rel?: IssueTreeRelations;
  addedAt: number;
  /** When the host read this GitHub node's relations (the issue's parent) — once per node. */
  checkedAt?: number;
  /** When a read of it last failed (a deleted issue, no access): the next reads go to the others first. */
  triedAt?: number;
  /** When the read behind its relations began: an older read (another reader, slower) does not replace them. */
  relReadAt?: number;
}
export interface SessionIssueTree {
  nodes: IssueTreeNode[];
  /** The next internal issue number (`internal:<n>`). */
  nextInternal: number;
}
/**
 * A node as GET_SESSION and the dashboard read it: the stored node (its relations included, so a preview rebuilt from
 * the view places nodes as the host does) without the host's read bookkeeping.
 */
export type IssueTreeViewNode = Omit<IssueTreeNode, 'addedAt' | 'checkedAt' | 'triedAt' | 'relReadAt'>;
/** What the model (GET_SESSION) and the dashboard read: the nodes in the order they came, the seed's title filled in. */
export interface IssueTreeView {
  nodes: IssueTreeViewNode[];
  /** The next internal issue number — so a preview made from the view numbers a new internal issue as the host will. */
  nextInternal?: number;
}

export interface SessionResourceSnapshot {
  issues: SessionLink[];
  prs: SessionLink[];
  docs: SessionLink[];
  active: SessionLinks;
  instructions: SessionInstruction[];
  sequence: number;
  /** .prd/26 — the session's code changes as of its last collect; absent before the first one. Read-only. */
  codeChanges?: CodeChangesSummary;
  /** .prd/29 — the session's issue tree. */
  issueTree?: IssueTreeView;
}

export interface SessionResourceAddOperation {
  action: 'add';
  resourceType: SessionResourceType;
  link: SessionLink;
  /**
   * .prd/29 — an issue or PR's place in the issue tree: a node (URL or id) to sit under, `null` for "unrelated" (an
   * issue at the root), absent for the host to place it.
   */
  parent?: string | null;
}

/** .prd/29 — an issue that lives only in this session (no tracker): new, or `id` to retitle / close it. */
export interface SessionIssueAddInternalOperation {
  action: 'add_internal';
  resourceType: 'issue';
  title: string;
  status?: 'open' | 'closed';
  parent?: string | null;
  id?: string;
}

/** .prd/29 — move a node of the issue tree (by URL or id) under another node, or to the root (`null`, issues only). */
export interface SessionIssueMoveOperation {
  action: 'move';
  resourceType: 'issue' | 'pr';
  node: string;
  parent: string | null;
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
  | SessionResourceSetActiveOperation
  | SessionIssueAddInternalOperation
  | SessionIssueMoveOperation;

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
  /**
   * With `title`: the host applies it only while the session still has a host
   * stand-in title ("New Session" and friends). Used for intent titles on
   * voice / image-only sessions so a deliberate title is never overwritten.
   */
  titleFillOnly?: boolean;
  /**
   * #829 — the Executive Summary's TL;DR for the session's task card (1–5 lines). A line that starts with ⚠️
   * (an issue/PR this session created is not complete, and why) keeps the card in NEEDS YOU until the next
   * summary has none. Applied by the host only — the snapshot carries no TL;DR.
   */
  executiveSummary?: { tldr: string[] };
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
 * #1073 — decision lines: what the person needs to answer from the card alone. All optional; most questions carry
 * none. Normalized by `normalizeDecisionFields` (validator): one line each, at most `DECISION_LINE_MAX_CHARS`.
 * Shown under the question's context on Slack and the dashboard, in this order. Never part of the answer.
 */
export interface DecisionFields {
  /** The work this answer is holding up. */
  blockedWork?: string;
  /** What is at stake in the choice. */
  stakes?: string;
  /** Whether the choice can be undone (`false` is shown prominently). */
  reversible?: boolean;
  /** Why it can or cannot be undone. Kept only with `reversible`. */
  reversibleWhy?: string;
}

/**
 * Single question in a choice form
 */
export interface UserChoiceQuestion extends DecisionFields {
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
export interface UserChoice extends DecisionFields {
  type: 'user_choice';
  question: string; // The question being asked
  choices: UserChoiceOption[]; // 2-5 options
  context?: string; // Optional context about why this choice matters
  /** ID of the recommended choice option; must match one of choices[].id */
  recommendedChoiceId?: string;
  /**
   * #1070 — `'admins'`: the decision belongs to an admin. The question also appears as a card on the
   * dashboard's 관리자 승인 (admin approvals) screen, for admins only, and an admin's answer there is
   * not held for the session owner.
   */
  audience?: 'admins';
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
