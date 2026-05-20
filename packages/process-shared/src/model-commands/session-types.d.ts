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
 * Renew command state
 */
export type RenewState = 'pending_save' | 'pending_load' | null;
/**
 * Continuation for chained execution
 * Allows execute() to return "what to do next" instead of recursing
 */
export interface Continuation {
  prompt: string;
  resetSession?: boolean;
  dispatchText?: string;
  forceWorkflow?: WorkflowType;
}
/**
 * Link attached to a session (issue, PR, doc)
 */
export interface SessionLink {
  url: string;
  type: 'issue' | 'pr' | 'doc';
  provider: 'github' | 'jira' | 'confluence' | 'linear' | 'unknown';
  label?: string;
  title?: string;
  status?: string;
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
 * A single user instruction stored as SSOT in the session.
 * Persisted to disk and exposed to the model via GET_SESSION.
 */
export interface SessionInstruction {
  id: string;
  text: string;
  addedAt: number;
  source?: string;
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
  source?: string;
}
export interface SessionInstructionRemoveOperation {
  action: 'remove';
  id: string;
}
export interface SessionInstructionClearOperation {
  action: 'clear';
}
export type SessionInstructionOperation =
  | SessionInstructionAddOperation
  | SessionInstructionRemoveOperation
  | SessionInstructionClearOperation;
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
  id: string;
  label: string;
  description?: string;
}
/**
 * Single question in a choice form
 */
export interface UserChoiceQuestion {
  id: string;
  question: string;
  choices: UserChoiceOption[];
  context?: string;
  /** ID of the recommended choice option; must match one of choices[].id */
  recommendedChoiceId?: string;
}
/**
 * Structured output for single user choice
 * Claude outputs this JSON when user input is needed
 */
export interface UserChoice {
  type: 'user_choice';
  question: string;
  choices: UserChoiceOption[];
  context?: string;
  /** ID of the recommended choice option; must match one of choices[].id */
  recommendedChoiceId?: string;
}
/**
 * Structured output for multiple user choices (form)
 * Claude outputs this JSON when multiple inputs are needed at once
 */
export interface UserChoices {
  type: 'user_choices';
  title?: string;
  description?: string;
  questions: UserChoiceQuestion[];
}
//# sourceMappingURL=session-types.d.ts.map
