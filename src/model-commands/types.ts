import {
  SaveContextResultPayload,
  SessionResourceSnapshot,
  SessionResourceUpdateRequest,
  UserChoice,
  UserChoices,
  WorkflowType,
  RenewState,
} from '../types';

export type ModelCommandId =
  | 'GET_SESSION'
  | 'UPDATE_SESSION'
  | 'ASK_USER_QUESTION'
  | 'SAVE_CONTEXT_RESULT';

export interface ModelCommandContext {
  channel?: string;
  threadTs?: string;
  user?: string;
  workflow?: WorkflowType;
  renewState?: RenewState;
  session?: SessionResourceSnapshot;
}

export interface ModelCommandDescriptor {
  id: ModelCommandId;
  description: string;
  paramsSchema: Record<string, unknown>;
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

export interface ModelCommandParamsMap {
  GET_SESSION: undefined;
  UPDATE_SESSION: SessionResourceUpdateRequest;
  ASK_USER_QUESTION: AskUserQuestionParams;
  SAVE_CONTEXT_RESULT: SaveContextResultParams;
}

export interface ModelCommandPayloadMap {
  GET_SESSION: {
    session: SessionResourceSnapshot;
  };
  UPDATE_SESSION: {
    session: SessionResourceSnapshot;
    appliedOperations: number;
    request: SessionResourceUpdateRequest;
  };
  ASK_USER_QUESTION: {
    question: UserChoice | UserChoices;
  };
  SAVE_CONTEXT_RESULT: {
    saveResult: SaveContextResultPayload;
  };
}

export interface ModelCommandError {
  code:
    | 'INVALID_ARGS'
    | 'INVALID_COMMAND'
    | 'INVALID_OPERATION'
    | 'SEQUENCE_MISMATCH'
    | 'CONTEXT_ERROR';
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
