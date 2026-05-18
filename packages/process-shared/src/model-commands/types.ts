import type {
  Continuation,
  RenewState,
  SaveContextResultPayload,
  SessionResourceSnapshot,
  SessionResourceUpdateRequest,
  UserChoice,
  UserChoices,
  WorkflowType,
} from './session-types';

export type ModelCommandId =
  | 'GET_SESSION'
  | 'UPDATE_SESSION'
  | 'ASK_USER_QUESTION'
  | 'CONTINUE_SESSION'
  | 'SAVE_CONTEXT_RESULT'
  | 'SAVE_MEMORY'
  | 'GET_MEMORY'
  | 'MANAGE_SKILL'
  | 'RATE';

export interface ModelCommandContext {
  channel?: string;
  threadTs?: string;
  user?: string;
  workflow?: WorkflowType;
  renewState?: RenewState;
  session?: SessionResourceSnapshot;
  /** Current session title (for GET_SESSION response) */
  sessionTitle?: string;
}

export interface ModelCommandDescriptor {
  id: ModelCommandId;
  description: string;
  paramsSchema: Record<string, unknown>;
  /**
   * Optional metadata flags consumed by the host runtime. Currently:
   *   - `user_instructions_write_gated` — the command may write `session.instructions`
   *     but the host requires user y/n confirmation before committing.
   */
  metadata?: Record<string, unknown>;
}

export interface ModelCommandListResponse {
  type: 'model_command_list';
  commands: ModelCommandDescriptor[];
}

export interface AskUserQuestionParams {
  question: UserChoice | UserChoices;
}

export interface SaveContextResultParams {
  result: SaveContextResultPayload;
}

export interface ContinueSessionParams extends Continuation {}

export interface SaveMemoryParams {
  action: 'add' | 'replace' | 'remove';
  target: 'memory' | 'user';
  content?: string;
  old_text?: string;
}

export interface ManageSkillParams {
  action: 'create' | 'update' | 'delete' | 'list' | 'share' | 'rename';
  name?: string;
  /**
   * New skill name for `action='rename'` only.
   *
   * Validator and dispatcher both require `newName` to be present (and a
   * different string than `name`) when `action==='rename'`; absent for every
   * other action. Same kebab-case predicate as `name`.
   */
  newName?: string;
  content?: string;
}

/**
 * Mutation signal attached to a successful MANAGE_SKILL payload.
 *
 * Why it's a distinct field rather than implicit on `action`: the payload
 * crosses an MCP wire boundary (model-command server → host stream-executor),
 * so the host needs an explicit, machine-readable trigger to invalidate the
 * cached `session.systemPrompt` for the affected user. `kind: 'skill'` lets
 * future stores (e.g. team-shared skills) widen this without breaking the
 * existing match.
 *
 * Only emitted on the four mutating actions (create/update/delete/rename)
 * AND only on `payload.ok === true`. `share` and `list` are read-only.
 */
export interface ManageSkillMutationSignal {
  kind: 'skill';
  user: string;
  action: 'create' | 'update' | 'delete' | 'rename';
}

export interface ModelCommandParamsMap {
  GET_SESSION: undefined;
  UPDATE_SESSION: SessionResourceUpdateRequest;
  ASK_USER_QUESTION: AskUserQuestionParams;
  CONTINUE_SESSION: ContinueSessionParams;
  SAVE_CONTEXT_RESULT: SaveContextResultParams;
  SAVE_MEMORY: SaveMemoryParams;
  GET_MEMORY: undefined;
  MANAGE_SKILL: ManageSkillParams;
  RATE: undefined;
}

export interface ModelCommandPayloadMap {
  GET_SESSION: {
    session: SessionResourceSnapshot;
    title: string | null;
  };
  UPDATE_SESSION: {
    session: SessionResourceSnapshot;
    appliedOperations: number;
    /**
     * Count of instruction operations that were actually committed.
     * Since instruction writes now require user y/n confirmation (see
     * `UPDATE_SESSION` description), this is always `0` on the model-command
     * layer. `pendingInstructionOperations` carries the count queued for
     * confirmation.
     */
    appliedInstructionOperations: number;
    /** Count of instruction operations queued for user y/n confirmation. */
    pendingInstructionOperations: number;
    /** True when the host must render a confirmation UI before committing. */
    confirmationRequired: boolean;
    request: SessionResourceUpdateRequest;
    title?: string;
  };
  ASK_USER_QUESTION: {
    question: UserChoice | UserChoices;
    /**
     * Soft quality warnings from `checkAskUserQuestionQuality`.
     * Present only when at least one rule triggered; absent when the question
     * is high-quality. Never causes validation failure — purely advisory.
     */
    warnings?: string[];
  };
  CONTINUE_SESSION: {
    continuation: Continuation;
  };
  SAVE_CONTEXT_RESULT: {
    saveResult: SaveContextResultPayload;
  };
  SAVE_MEMORY: {
    ok: boolean;
    message: string;
  };
  GET_MEMORY: {
    memory: string[];
    user: string[];
    memoryChars: number;
    memoryLimit: number;
    userChars: number;
    userLimit: number;
  };
  MANAGE_SKILL: {
    ok: boolean;
    message: string;
    skills?: Array<{ name: string; description: string }>;
    /** Skill name echoed on share happy path (so recipient knows what to install). */
    name?: string;
    /**
     * Full SKILL.md content. Present only on share happy path; omitted on
     * over-limit / not-found / invalid-name. Recipient model renders as a
     * fenced code block (see MANAGE_SKILL descriptor for the format contract).
     */
    content?: string;
    /**
     * Wire-level signal that the host should invalidate cached system prompts
     * for `user`. Present iff the dispatcher succeeded on a mutating action
     * (create/update/delete/rename) AND the storage call returned ok=true.
     * Absent for share/list and for failures, by design — see
     * `ManageSkillMutationSignal` for the field contract.
     */
    mutated?: ManageSkillMutationSignal;
  };
  RATE: {
    rating: number;
  };
}

export interface ModelCommandError {
  code: 'INVALID_ARGS' | 'INVALID_COMMAND' | 'INVALID_OPERATION' | 'SEQUENCE_MISMATCH' | 'CONTEXT_ERROR';
  message: string;
  details?: unknown;
}

export type ModelCommandRunRequest = {
  [K in ModelCommandId]: {
    commandId: K;
    params: ModelCommandParamsMap[K];
  };
}[ModelCommandId];

export type ModelCommandRunSuccess = {
  [K in ModelCommandId]: {
    type: 'model_command_result';
    commandId: K;
    ok: true;
    payload: ModelCommandPayloadMap[K];
  };
}[ModelCommandId];

export interface ModelCommandRunErrorResponse {
  type: 'model_command_result';
  commandId: ModelCommandId | 'UNKNOWN';
  ok: false;
  error: ModelCommandError;
}

export type ModelCommandRunResponse = ModelCommandRunSuccess | ModelCommandRunErrorResponse;
