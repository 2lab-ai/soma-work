/**
 * Session state machine states
 */
export type SessionState = 'INITIALIZING' | 'MAIN';

/**
 * Workflow types for session routing
 */
export type WorkflowType =
  | 'jira-executive-summary'
  | 'jira-brainstorming'
  | 'jira-planning'
  | 'jira-create-pr'
  | 'pr-review'
  | 'pr-fix-and-update'
  | 'default';

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