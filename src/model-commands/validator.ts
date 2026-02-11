import {
  SaveContextResultPayload,
  SessionLink,
  SessionResourceOperation,
  SessionResourceType,
  SessionResourceUpdateRequest,
  UserChoice,
  UserChoiceOption,
  UserChoiceQuestion,
  UserChoices,
} from '../types';
import {
  AskUserQuestionParams,
  ModelCommandError,
  ModelCommandRunRequest,
  SaveContextResultParams,
} from './types';

type ValidationResult =
  | { ok: true; request: ModelCommandRunRequest }
  | { ok: false; error: ModelCommandError };

const RESOURCE_TYPES: SessionResourceType[] = ['issue', 'pr', 'doc'];

export function validateModelCommandRunArgs(args: unknown): ValidationResult {
  if (!isRecord(args)) {
    return invalidArgs('run arguments must be an object');
  }

  const commandId = args.commandId;
  if (
    commandId !== 'GET_SESSION'
    && commandId !== 'UPDATE_SESSION'
    && commandId !== 'ASK_USER_QUESTION'
    && commandId !== 'SAVE_CONTEXT_RESULT'
  ) {
    return {
      ok: false,
      error: {
        code: 'INVALID_COMMAND',
        message: `Unsupported commandId: ${String(commandId)}`,
      },
    };
  }

  const params = args.params;

  if (commandId === 'GET_SESSION') {
    return {
      ok: true,
      request: {
        commandId: 'GET_SESSION',
        params: undefined,
      },
    };
  }

  if (commandId === 'UPDATE_SESSION') {
    const parsed = parseUpdateSessionRequest(params);
    if (!parsed.ok) {
      return parsed;
    }
    return {
      ok: true,
      request: {
        commandId: 'UPDATE_SESSION',
        params: parsed.value,
      },
    };
  }

  if (commandId === 'ASK_USER_QUESTION') {
    const parsed = parseAskUserQuestionParams(params);
    if (!parsed.ok) {
      return parsed;
    }
    return {
      ok: true,
      request: {
        commandId: 'ASK_USER_QUESTION',
        params: parsed.value,
      },
    };
  }

  const saveParams = params !== undefined
    ? params
    : buildSaveContextFallbackParams(args);
  const parsed = parseSaveContextResultParams(saveParams);
  if (!parsed.ok) {
    return parsed;
  }
  return {
    ok: true,
    request: {
      commandId: 'SAVE_CONTEXT_RESULT',
      params: parsed.value,
    },
  };
}

function buildSaveContextFallbackParams(
  args: Record<string, unknown>
): Record<string, unknown> | undefined {
  const fallback: Record<string, unknown> = {};
  if ('result' in args) {
    fallback.result = args.result;
  }
  if ('save_result' in args) {
    fallback.save_result = args.save_result;
  }
  if ('payload' in args) {
    fallback.payload = args.payload;
  }
  return Object.keys(fallback).length > 0 ? fallback : undefined;
}

function parseUpdateSessionRequest(
  raw: unknown
): { ok: true; value: SessionResourceUpdateRequest } | { ok: false; error: ModelCommandError } {
  if (!isRecord(raw)) {
    return invalidArgs('UPDATE_SESSION params must be an object');
  }

  const rawOps = raw.operations;
  if (!Array.isArray(rawOps) || rawOps.length === 0) {
    return invalidArgs('UPDATE_SESSION operations must be a non-empty array');
  }

  const operations: SessionResourceOperation[] = [];
  for (const entry of rawOps) {
    const parsed = parseSessionOperation(entry);
    if (!parsed.ok) {
      return parsed;
    }
    operations.push(parsed.value);
  }

  const expectedSequence = raw.expectedSequence;
  if (expectedSequence !== undefined && !Number.isInteger(expectedSequence)) {
    return invalidArgs('UPDATE_SESSION expectedSequence must be an integer');
  }

  return {
    ok: true,
    value: {
      expectedSequence: expectedSequence as number | undefined,
      operations,
    },
  };
}

function parseSessionOperation(
  raw: unknown
): { ok: true; value: SessionResourceOperation } | { ok: false; error: ModelCommandError } {
  if (!isRecord(raw)) {
    return invalidArgs('UPDATE_SESSION operation must be an object');
  }

  const action = raw.action;
  const resourceType = raw.resourceType;
  if (
    action !== 'add'
    && action !== 'remove'
    && action !== 'set_active'
  ) {
    return invalidArgs(`Unsupported operation action: ${String(action)}`);
  }
  if (!RESOURCE_TYPES.includes(resourceType as SessionResourceType)) {
    return invalidArgs(`Unsupported resourceType: ${String(resourceType)}`);
  }

  if (action === 'add') {
    const link = normalizeLink(raw.link, resourceType as SessionResourceType);
    if (!link) {
      return invalidArgs('add operation requires link with url');
    }
    return {
      ok: true,
      value: {
        action: 'add',
        resourceType: resourceType as SessionResourceType,
        link,
      },
    };
  }

  if (action === 'remove') {
    if (typeof raw.url !== 'string' || raw.url.trim() === '') {
      return invalidArgs('remove operation requires url');
    }
    return {
      ok: true,
      value: {
        action: 'remove',
        resourceType: resourceType as SessionResourceType,
        url: raw.url,
      },
    };
  }

  if (raw.url !== undefined && typeof raw.url !== 'string') {
    return invalidArgs('set_active url must be a string when provided');
  }

  return {
    ok: true,
    value: {
      action: 'set_active',
      resourceType: resourceType as SessionResourceType,
      url: raw.url as string | undefined,
    },
  };
}

function parseAskUserQuestionParams(
  raw: unknown
): { ok: true; value: AskUserQuestionParams } | { ok: false; error: ModelCommandError } {
  if (!isRecord(raw)) {
    return invalidArgs('ASK_USER_QUESTION params must be an object');
  }

  const payload = raw.payload ?? raw.question ?? raw;
  const normalized = normalizeChoicePayload(payload);
  if (!normalized) {
    return invalidArgs('ASK_USER_QUESTION payload must be user_choice, user_choices, or user_choice_group');
  }

  return {
    ok: true,
    value: {
      question: normalized,
    },
  };
}

function parseSaveContextResultParams(
  raw: unknown
): { ok: true; value: SaveContextResultParams } | { ok: false; error: ModelCommandError } {
  if (!isRecord(raw)) {
    return invalidArgs('SAVE_CONTEXT_RESULT params must be an object');
  }

  const result = normalizeSaveContextResultFromVariants(raw);
  if (!result) {
    return invalidArgs('SAVE_CONTEXT_RESULT payload is empty or invalid');
  }

  return {
    ok: true,
    value: {
      result,
    },
  };
}

function normalizeSaveContextResultFromVariants(raw: Record<string, unknown>): SaveContextResultPayload | null {
  const candidates: unknown[] = [];

  // Preferred shape from renew prompt.
  candidates.push(raw.result);
  // Frequent legacy/fallback envelopes.
  candidates.push(raw.save_result);
  candidates.push(raw.payload);
  // Last resort: treat params itself as payload.
  candidates.push(raw);

  for (const candidate of candidates) {
    if (!isRecord(candidate)) {
      continue;
    }
    if (isRecord(candidate.save_result)) {
      const nested = normalizeSaveContextResult(candidate.save_result);
      if (nested) {
        return nested;
      }
    }
    const normalized = normalizeSaveContextResult(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function normalizeLink(raw: unknown, resourceType: SessionResourceType): SessionLink | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (typeof raw.url !== 'string' || raw.url.trim() === '') {
    return null;
  }

  return {
    url: raw.url,
    type: resourceType,
    provider: toProvider(raw.provider),
    label: toOptionalString(raw.label),
    title: toOptionalString(raw.title),
    status: toOptionalString(raw.status),
    statusCheckedAt: Number.isFinite(raw.statusCheckedAt) ? Number(raw.statusCheckedAt) : undefined,
  };
}

function normalizeChoicePayload(raw: unknown): UserChoice | UserChoices | null {
  if (!isRecord(raw)) {
    return null;
  }

  if (raw.type === 'user_choice') {
    return normalizeUserChoice(raw);
  }

  if (raw.type === 'user_choices') {
    const questions = Array.isArray(raw.questions)
      ? raw.questions.map((question, index) => normalizeUserChoiceQuestion(question, index))
      : [];
    const compact = questions.filter((question): question is UserChoiceQuestion => !!question);
    if (compact.length === 0) {
      return null;
    }
    return {
      type: 'user_choices',
      title: toOptionalString(raw.title),
      description: toOptionalString(raw.description),
      questions: compact,
    };
  }

  if (raw.type === 'user_choice_group') {
    const rawChoices = Array.isArray(raw.choices) ? raw.choices : [];
    const questions = rawChoices
      .map((choice, index) => normalizeUserChoiceQuestion(choice, index))
      .filter((question): question is UserChoiceQuestion => !!question);
    if (questions.length === 0) {
      return null;
    }
    return {
      type: 'user_choices',
      title: toOptionalString(raw.question) || '선택이 필요합니다',
      description: toOptionalString(raw.context),
      questions,
    };
  }

  return normalizeUserChoice(raw);
}

function normalizeUserChoiceQuestion(raw: unknown, index: number): UserChoiceQuestion | null {
  if (!isRecord(raw)) {
    return null;
  }
  const question = toOptionalString(raw.question);
  const options = normalizeChoiceOptions(raw.choices ?? raw.options);
  if (!question || options.length === 0) {
    return null;
  }
  const id = toOptionalString(raw.id) || `q${index + 1}`;
  return {
    id,
    question,
    context: toOptionalString(raw.context),
    choices: options,
  };
}

function normalizeUserChoice(raw: Record<string, unknown>): UserChoice | null {
  const question = toOptionalString(raw.question);
  const options = normalizeChoiceOptions(raw.choices ?? raw.options);
  if (!question || options.length === 0) {
    return null;
  }
  return {
    type: 'user_choice',
    question,
    context: toOptionalString(raw.context),
    choices: options,
  };
}

function normalizeChoiceOptions(raw: unknown): UserChoiceOption[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const options: UserChoiceOption[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const entry = raw[index];
    if (!isRecord(entry)) continue;
    const label = toOptionalString(entry.label);
    if (!label) continue;
    const id = toOptionalString(entry.id) || String(index + 1);
    options.push({
      id,
      label,
      description: toOptionalString(entry.description),
    });
  }
  return options;
}

function normalizeSaveContextResult(raw: Record<string, unknown>): SaveContextResultPayload | null {
  const result: SaveContextResultPayload = {};

  if (typeof raw.success === 'boolean') {
    result.success = raw.success;
  }
  if (typeof raw.status === 'string') {
    result.status = raw.status;
  }
  if (typeof raw.id === 'string') {
    result.id = raw.id;
  }
  if (typeof raw.save_id === 'string') {
    result.save_id = raw.save_id;
  }
  if (typeof raw.path === 'string') {
    result.path = raw.path;
  }
  if (typeof raw.dir === 'string') {
    result.dir = raw.dir;
  }
  if (typeof raw.summary === 'string') {
    result.summary = raw.summary;
  }
  if (typeof raw.title === 'string') {
    result.title = raw.title;
  }
  if (typeof raw.error === 'string') {
    result.error = raw.error;
  }
  if (Array.isArray(raw.files)) {
    const files = raw.files
      .map((entry) => {
        if (!isRecord(entry)) return null;
        if (typeof entry.name !== 'string' || typeof entry.content !== 'string') {
          return null;
        }
        return { name: entry.name, content: entry.content };
      })
      .filter((entry): entry is { name: string; content: string } => !!entry);
    if (files.length > 0) {
      result.files = files;
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

function toProvider(raw: unknown): SessionLink['provider'] {
  if (
    raw === 'github'
    || raw === 'jira'
    || raw === 'confluence'
    || raw === 'linear'
    || raw === 'unknown'
  ) {
    return raw;
  }
  return 'unknown';
}

function invalidArgs(message: string): { ok: false; error: ModelCommandError } {
  return {
    ok: false,
    error: {
      code: 'INVALID_ARGS',
      message,
    },
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
