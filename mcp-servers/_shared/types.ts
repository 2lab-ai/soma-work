/**
 * Shared types for MCP servers.
 * Extracted from src/types.ts to allow mcp-servers/ to be independent of src/.
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

export type RenewState = 'pending_save' | 'pending_load' | null;

export interface Continuation {
  prompt: string;
  resetSession?: boolean;
  dispatchText?: string;
  forceWorkflow?: WorkflowType;
}

export interface SessionLink {
  url: string;
  type: 'issue' | 'pr' | 'doc';
  provider: 'github' | 'jira' | 'confluence' | 'linear' | 'unknown';
  label?: string;
  title?: string;
  status?: string;
  statusCheckedAt?: number;
}

export interface SessionLinks {
  issue?: SessionLink;
  pr?: SessionLink;
  doc?: SessionLink;
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
  title?: string;
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

export interface UserChoiceOption {
  id: string;
  label: string;
  description?: string;
}

export interface UserChoiceQuestion {
  id: string;
  question: string;
  choices: UserChoiceOption[];
  context?: string;
}

export interface UserChoice {
  type: 'user_choice';
  question: string;
  choices: UserChoiceOption[];
  context?: string;
}

export interface UserChoices {
  type: 'user_choices';
  title?: string;
  description?: string;
  questions: UserChoiceQuestion[];
}
