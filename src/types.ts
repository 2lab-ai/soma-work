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
export type ActivityState = 'working' | 'waiting' | 'idle';

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
  | 'default';

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
  currentInputTokens: number;       // Input tokens in most recent request (includes history)
  currentOutputTokens: number;      // Output tokens in most recent response
  currentCacheReadTokens: number;   // Cache read tokens in current request
  currentCacheCreateTokens: number; // Cache create tokens in current request
  contextWindow: number;            // Max context window — dynamically set from SDK (e.g. 1_000_000)

  // Cumulative session totals
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;

  lastUpdated: number;              // Timestamp of last update
}

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
  resetSession?: boolean;  // Reset session before executing (triggers re-dispatch)
  dispatchText?: string;   // Text to use for dispatch classification (if different from prompt)
  forceWorkflow?: WorkflowType;
}

/**
 * Link attached to a session (issue, PR, doc)
 */
export interface SessionLink {
  url: string;
  type: 'issue' | 'pr' | 'doc';
  provider: 'github' | 'jira' | 'confluence' | 'linear' | 'unknown';
  label?: string;        // e.g., "PTN-123", "PR #456"
  title?: string;        // e.g., "Fix login redirect bug"
  status?: string;       // e.g., "open", "merged", "in-progress"
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

export interface SessionResourceSnapshot {
  issues: SessionLink[];
  prs: SessionLink[];
  docs: SessionLink[];
  active: SessionLinks;
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

export interface SessionResourceUpdateRequest {
  expectedSequence?: number;
  operations?: SessionResourceOperation[];
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

export interface ActionPanelPRStatus {
  state: string;      // 'open' | 'closed' | 'merged'
  mergeable: boolean;
  draft: boolean;
  merged: boolean;
  approved?: boolean; // true if PR has been approved
  head?: string;      // source branch
  base?: string;      // target branch
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
  renderKey?: string;
  lastRenderedAt?: number;
  prStatus?: ActionPanelPRStatus;
  summaryBlocks?: any[];
}

export interface ConversationSession {
  ownerId: string;           // User who started the session
  ownerName?: string;        // Display name of owner
  currentInitiatorId?: string; // User who triggered the current response
  currentInitiatorName?: string; // Display name of current initiator
  channelId: string;
  threadTs?: string;
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
  state?: SessionState;      // Current state (INITIALIZING -> MAIN)
  workflow?: WorkflowType;   // Determined workflow type
  // Token usage tracking
  usage?: SessionUsage;
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
  // Tool-driven save result used by renew command (preferred over text parsing)
  renewSaveResult?: SaveContextResultPayload;
  // Ghost Session Fix #99: defense-in-depth flag for in-flight code to self-terminate
  terminated?: boolean;
  // Dashboard: session hidden from dashboard view but kept in conversation list
  trashed?: boolean;
  // Sleep mode
  sleepStartedAt?: Date;
  // Conversation history recording ID
  conversationId?: string;
  // Bot activity state (working/waiting/idle)
  activityState?: ActivityState;
  activityStateChangedAt?: number;
  actionPanel?: ActionPanelState;
  // Log verbosity bitmask (controls which output types are shown in Slack)
  logVerbosity?: number;
  // Effort level for Claude thinking (low/medium/high/max)
  effort?: 'low' | 'medium' | 'high' | 'max';
  // Thread model: user-initiated (default) or bot-initiated (bot creates root message)
  threadModel?: 'user-initiated' | 'bot-initiated';
  // For bot-initiated threads: the root message ts (used for chat.update)
  threadRootTs?: string;
  // Onboarding flag: true when session is an onboarding flow for first-time user
  isOnboarding?: boolean;
  // Session-unique base working directory (auto-created on new session, cleaned up on end)
  sessionWorkingDir?: string;
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
  // Not serialized to disk (runtime-only).
  pendingRetryTimer?: ReturnType<typeof setTimeout>;
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
}

export interface WorkingDirectoryConfig {
  channelId: string;
  threadTs?: string;
  userId?: string;
  directory: string;
  setAt: Date;
}

/**
 * User choice option for interactive selection
 */
export interface UserChoiceOption {
  id: string;           // Unique ID (e.g., "1", "2", "a", "b")
  label: string;        // Short label for button
  description?: string; // Optional longer description
}

/**
 * Single question in a choice form
 */
export interface UserChoiceQuestion {
  id: string;                    // Unique question ID (e.g., "q1", "auth", "db")
  question: string;              // The question being asked
  choices: UserChoiceOption[];   // 2-5 options
  context?: string;              // Optional context
}

/**
 * Structured output for single user choice
 * Claude outputs this JSON when user input is needed
 */
export interface UserChoice {
  type: 'user_choice';
  question: string;              // The question being asked
  choices: UserChoiceOption[];   // 2-5 options
  context?: string;              // Optional context about why this choice matters
}

/**
 * Structured output for multiple user choices (form)
 * Claude outputs this JSON when multiple inputs are needed at once
 */
export interface UserChoices {
  type: 'user_choices';
  title?: string;                // Form title
  description?: string;          // Form description
  questions: UserChoiceQuestion[]; // Multiple questions
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
  question: string;              // Group title/context
  choices: UserChoice[];         // Array of individual choices
  context?: string;              // Why these decisions are needed
}
