import type {
  SaveContextResultPayload,
  SessionLink,
  SessionResourceOperation,
  SessionResourceType,
  SessionResourceUpdateRequest,
  UserChoice,
  UserChoiceOption,
  UserChoiceQuestion,
  UserChoices,
  WorkflowType,
} from './session-types';
import type {
  AskUserQuestionParams,
  ContinueSessionParams,
  ModelCommandError,
  ModelCommandRunRequest,
  SaveContextResultParams,
} from './types';

type ValidationResult = { ok: true; request: ModelCommandRunRequest } | { ok: false; error: ModelCommandError };

const RESOURCE_TYPES: SessionResourceType[] = ['issue', 'pr', 'doc'];
const WORKFLOW_TYPES: WorkflowType[] = [
  'onboarding',
  'jira-executive-summary',
  'jira-brainstorming',
  'jira-planning',
  'jira-create-pr',
  'pr-review',
  'pr-fix-and-update',
  'pr-docs-confluence',
  'deploy',
  'default',
];

const ASK_USER_QUESTION_ALLOWED_TYPES = ['user_choice', 'user_choice_group'] as const;

const ASK_USER_QUESTION_EXAMPLES = {
  user_choice: {
    payload: {
      type: 'user_choice',
      question: 'Choose next step',
      recommendedChoiceId: '1',
      choices: [
        { id: '1', label: 'Write implementation spec', description: 'Document API and tasks first' },
        { id: '2', label: 'Start implementation', description: 'Code immediately from current context' },
      ],
    },
  },
  user_choice_group: {
    payload: {
      type: 'user_choice_group',
      question: 'Choose implementation path',
      context: 'Need a decision before coding',
      choices: [
        {
          question: 'Which approach?',
          recommendedChoiceId: '1',
          options: [
            { id: '1', label: 'Option A' },
            { id: '2', label: 'Option B' },
          ],
        },
      ],
    },
  },
};

const ASK_USER_QUESTION_INVALID_MESSAGE = [
  'ASK_USER_QUESTION params must follow a strict schema.',
  'Required top-level shape: params.payload = { ... }',
  'Allowed payload.type values: "user_choice" | "user_choice_group".',
  'Do not send wrapper formats like params.user_choice or root question/options.',
  'Minimum user_choice schema:',
  '{ "type":"user_choice", "question":"...", "recommendedChoiceId":"1", "choices":[{ "id":"1", "label":"Option A", "description":"optional" }] }',
  'Minimum user_choice_group schema:',
  '{ "type":"user_choice_group", "question":"...", "choices":[{ "question":"...", "recommendedChoiceId":"1", "options":[{ "id":"1", "label":"Option A" }] }] }',
  'Rules: "choices" or "options" must be a non-empty array of objects, and each item requires "label" (string).',
  'Optional: "recommendedChoiceId" must match one of the option ids; if it does not, it is silently dropped.',
].join('\n');

export function validateModelCommandRunArgs(args: unknown): ValidationResult {
  if (!isRecord(args)) {
    return invalidArgs('run arguments must be an object');
  }

  const commandId = args.commandId;
  if (
    commandId !== 'GET_SESSION' &&
    commandId !== 'UPDATE_SESSION' &&
    commandId !== 'ASK_USER_QUESTION' &&
    commandId !== 'CONTINUE_SESSION' &&
    commandId !== 'SAVE_CONTEXT_RESULT' &&
    commandId !== 'SAVE_MEMORY' &&
    commandId !== 'GET_MEMORY' &&
    commandId !== 'MANAGE_SKILL' &&
    commandId !== 'RATE'
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

  if (commandId === 'CONTINUE_SESSION') {
    const parsed = parseContinueSessionParams(params);
    if (!parsed.ok) {
      return parsed;
    }
    return {
      ok: true,
      request: {
        commandId: 'CONTINUE_SESSION',
        params: parsed.value,
      },
    };
  }

  if (commandId === 'SAVE_MEMORY') {
    if (!isRecord(params)) {
      return invalidArgs('SAVE_MEMORY params must be an object with action, target, and content/old_text');
    }
    const action = params.action;
    const target = params.target;
    if (action !== 'add' && action !== 'replace' && action !== 'remove') {
      return invalidArgs(`SAVE_MEMORY action must be 'add', 'replace', or 'remove', got: ${String(action)}`);
    }
    if (target !== 'memory' && target !== 'user') {
      return invalidArgs(`SAVE_MEMORY target must be 'memory' or 'user', got: ${String(target)}`);
    }
    return {
      ok: true,
      request: {
        commandId: 'SAVE_MEMORY',
        params: {
          action,
          target,
          content: typeof params.content === 'string' ? params.content : undefined,
          old_text: typeof params.old_text === 'string' ? params.old_text : undefined,
        },
      },
    };
  }

  if (commandId === 'GET_MEMORY') {
    return {
      ok: true,
      request: {
        commandId: 'GET_MEMORY',
        params: undefined,
      },
    };
  }

  if (commandId === 'MANAGE_SKILL') {
    if (!isRecord(params)) {
      return invalidArgs('MANAGE_SKILL params must be an object with action');
    }
    const action = params.action;
    if (action !== 'create' && action !== 'update' && action !== 'delete' && action !== 'list') {
      return invalidArgs(`MANAGE_SKILL action must be 'create', 'update', 'delete', or 'list', got: ${String(action)}`);
    }
    if ((action === 'create' || action === 'update' || action === 'delete') && typeof params.name !== 'string') {
      return invalidArgs('MANAGE_SKILL name is required for create/update/delete');
    }
    if ((action === 'create' || action === 'update') && typeof params.content !== 'string') {
      return invalidArgs('MANAGE_SKILL content is required for create/update');
    }
    return {
      ok: true,
      request: {
        commandId: 'MANAGE_SKILL',
        params: {
          action: action as 'create' | 'update' | 'delete' | 'list',
          name: typeof params.name === 'string' ? params.name : undefined,
          content: typeof params.content === 'string' ? params.content : undefined,
        },
      },
    };
  }

  if (commandId === 'RATE') {
    return {
      ok: true,
      request: {
        commandId: 'RATE',
        params: undefined,
      },
    };
  }


  // SAVE_CONTEXT_RESULT fallback — last remaining commandId
  const saveParams = params !== undefined ? params : buildSaveContextFallbackParams(args);
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

function buildSaveContextFallbackParams(args: Record<string, unknown>): Record<string, unknown> | undefined {
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
  raw: unknown,
): { ok: true; value: SessionResourceUpdateRequest } | { ok: false; error: ModelCommandError } {
  if (!isRecord(raw)) {
    return invalidArgs('UPDATE_SESSION params must be an object');
  }

  // Extract title
  const title = typeof raw.title === 'string' ? raw.title : undefined;

  // Operations validation: allow empty/missing if title exists
  const rawOps = raw.operations;
  const operations: SessionResourceOperation[] = [];
  if (Array.isArray(rawOps) && rawOps.length > 0) {
    for (const entry of rawOps) {
      const parsed = parseSessionOperation(entry);
      if (!parsed.ok) {
        return parsed;
      }
      operations.push(parsed.value);
    }
  }

  // Must have at least one of operations or title
  if (operations.length === 0 && !title) {
    return invalidArgs('UPDATE_SESSION requires operations or title');
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
      ...(title ? { title } : {}),
    },
  };
}

function parseSessionOperation(
  raw: unknown,
): { ok: true; value: SessionResourceOperation } | { ok: false; error: ModelCommandError } {
  if (!isRecord(raw)) {
    return invalidArgs('UPDATE_SESSION operation must be an object');
  }

  const action = raw.action;
  const resourceType = raw.resourceType;
  if (action !== 'add' && action !== 'remove' && action !== 'set_active') {
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
  raw: unknown,
): { ok: true; value: AskUserQuestionParams } | { ok: false; error: ModelCommandError } {
  if (!isRecord(raw)) {
    return invalidAskUserQuestionArgs(undefined, 'params_not_object');
  }

  // Auto-normalize flat params: if payload wrapper is missing but question exists,
  // treat the entire params object as the payload (matches normalizeSaveContextResultFromVariants pattern)
  let payload: Record<string, unknown>;
  if (isRecord(raw.payload)) {
    payload = raw.payload;
  } else if (typeof raw.question === 'string') {
    payload = { ...raw, type: typeof raw.type === 'string' ? raw.type : 'user_choice' };
  } else {
    return invalidAskUserQuestionArgs(raw, 'missing_payload');
  }
  if (payload.type !== ASK_USER_QUESTION_ALLOWED_TYPES[0] && payload.type !== ASK_USER_QUESTION_ALLOWED_TYPES[1]) {
    return invalidAskUserQuestionArgs(raw, 'invalid_payload_type');
  }

  const normalized = normalizeChoicePayload(payload);
  if (!normalized) {
    return invalidAskUserQuestionArgs(raw, 'payload_schema_invalid');
  }

  return {
    ok: true,
    value: {
      question: normalized,
    },
  };
}

/**
 * Soft quality rules for ASK_USER_QUESTION payloads.
 *
 * These run AFTER schema validation (`parseAskUserQuestionParams`) and never
 * reject a request — they only advise. The returned array carries warning
 * strings for any failing rule; an empty array means the question is
 * high-quality.
 *
 * Six rules (per Epic #544 Defect B spec):
 *   1. options count must be 2..4
 *   2. question must start with a tier prefix [tiny|small|medium|large|xlarge]
 *   3. context must be present and ≥ 80 chars (trimmed)
 *   4. option labels must not be forbidden meta/approval verbs
 *   5. exactly one option must carry the Recommended marker (label only)
 *   6. question field must be non-empty (not whitespace-only)
 */
export function checkAskUserQuestionQuality(params: AskUserQuestionParams): string[] {
  const warnings: string[] = [];
  const question = params?.question;
  if (!question) {
    return warnings;
  }
  if (question.type === 'user_choice') {
    collectUserChoiceWarnings(question, warnings);
  } else if (question.type === 'user_choices') {
    collectUserChoicesWarnings(question, warnings);
  }
  return warnings;
}

const TIER_PREFIX_RE = /^\[(tiny|small|medium|large|xlarge)(?:\s+~\d+(?:\s+lines?)?)?\]\s+/i;
const RECOMMENDED_MARKER_RE = /\(Recommended\s*·\s*\d+\/\d+\)\s*$/i;

/**
 * Trailing "(Recommended)" or "(Recommended · N/M)" suffix — match-at-end-of-label only.
 *
 * Exported for reuse by Slack + dashboard legacy-fallback paths so all call sites agree on
 * what counts as a "legacy Recommended marker". Tighter than `/\(Recommended\b/i` — must anchor
 * at end-of-string (trailing whitespace allowed) so mid-label uses like
 * `"Option A (Recommended for staging only)"` do NOT match.
 */
export const LEGACY_RECOMMENDED_SUFFIX_RE = /\(Recommended(?:\s*·\s*\d+\/\d+)?\)\s*$/i;
const FORBIDDEN_META_LABELS = new Set([
  'fix_now',
  'defer',
  'skip',
  'confirm',
  'approve',
  'reject',
  'yes',
  'no',
  'ok',
  'cancel',
  'continue',
  'retry',
  'reset',
  'done',
  'next',
  'back',
  'proceed',
  'abort',
]);
const MIN_CONTEXT_LENGTH = 80;

function collectUserChoiceWarnings(payload: UserChoice, warnings: string[]): void {
  // Rule 6 — question non-empty
  const questionText = typeof payload.question === 'string' ? payload.question : '';
  const questionTrimmed = questionText.trim();
  if (questionTrimmed.length < 1) {
    warnings.push('question is empty or whitespace-only');
  }

  // Rule 2 — tier prefix
  if (questionTrimmed.length >= 1 && !TIER_PREFIX_RE.test(questionText)) {
    warnings.push(
      'question missing tier prefix — expected [tiny|small|medium|large|xlarge] (optionally with ~N lines)',
    );
  }

  // Rule 3 — context required + trimmed length ≥ 80
  pushContextWarnings(payload.context, '', warnings);

  // Rule 1 — 2..4 options
  pushOptionCountWarnings(payload.choices, '', warnings);

  // Rule 5 — Recommended marker label-only exactly-one (also catches marker in description)
  pushRecommendedWarnings(payload.choices, '', warnings, payload.recommendedChoiceId);

  // Rule 4 — forbidden meta labels (strip Recommended marker first)
  pushForbiddenLabelWarnings(payload.choices, '', warnings);
}

function collectUserChoicesWarnings(payload: UserChoices, warnings: string[]): void {
  const title = typeof payload.title === 'string' ? payload.title : undefined;
  const titleTrimmed = title?.trim() ?? '';

  // Rule 6 — if title is provided, it must be non-empty
  if (title !== undefined && titleTrimmed.length < 1) {
    warnings.push('question is empty or whitespace-only');
  }

  // Rule 2 — require tier prefix at the group level. When title is absent
  // (direct UserChoices construction with no title) we still warn so callers
  // can't silently bypass Rule 2 by omitting the title. When title has the
  // prefix the per-question prefix is not required ("Epic atomicity").
  const titleHasPrefix = titleTrimmed.length >= 1 && TIER_PREFIX_RE.test(title as string);
  if (!titleHasPrefix) {
    warnings.push(
      'question missing tier prefix — expected [tiny|small|medium|large|xlarge] (optionally with ~N lines)',
    );
  }

  // Rule 3 — accept group-level `description` as a substitute for per-question
  // `context`. After `user_choice_group` normalization the raw top-level
  // `context` lands in `description`; requiring per-question duplication would
  // force every single-question approval template to repeat itself.
  const description = typeof payload.description === 'string' ? payload.description : undefined;
  const descriptionTrimmed = description?.trim() ?? '';
  const descriptionSatisfiesRule3 = descriptionTrimmed.length >= MIN_CONTEXT_LENGTH;

  for (const q of payload.questions) {
    const prefix = `question[${q.id}]: `;

    // Rule 6 — each question.question non-empty
    const qText = typeof q.question === 'string' ? q.question : '';
    const qTrimmed = qText.trim();
    if (qTrimmed.length < 1) {
      warnings.push(`${prefix}question is empty or whitespace-only`);
    }

    // Rule 3 — per-question context required only when group description
    // doesn't already satisfy the minimum length.
    if (!descriptionSatisfiesRule3) {
      pushContextWarnings(q.context, prefix, warnings);
    }

    // Rule 1 — 2..4 options
    pushOptionCountWarnings(q.choices, prefix, warnings);

    // Rule 5 — Recommended marker per-question
    pushRecommendedWarnings(q.choices, prefix, warnings, q.recommendedChoiceId);

    // Rule 4 — forbidden meta labels
    pushForbiddenLabelWarnings(q.choices, prefix, warnings);
  }
}

function pushContextWarnings(context: string | undefined, prefix: string, warnings: string[]): void {
  const trimmed = typeof context === 'string' ? context.trim() : '';
  if (trimmed.length === 0) {
    warnings.push(`${prefix}context missing — stakeholder needs decision rationale`);
    return;
  }
  if (trimmed.length < MIN_CONTEXT_LENGTH) {
    warnings.push(
      `${prefix}context too short (${trimmed.length} chars, min ${MIN_CONTEXT_LENGTH}) — expand rationale`,
    );
  }
}

function pushOptionCountWarnings(choices: UserChoiceOption[], prefix: string, warnings: string[]): void {
  const count = choices.length;
  if (count < 2) {
    warnings.push(`${prefix}options count (${count}) below minimum 2 — provide at least 2 choices`);
  } else if (count > 4) {
    warnings.push(`${prefix}options count (${count}) exceeds maximum 4 — Slack button row readability`);
  }
}

function pushRecommendedWarnings(
  choices: UserChoiceOption[],
  prefix: string,
  warnings: string[],
  recommendedChoiceId?: string,
): void {
  // Always flag marker-in-description — that's a data-shape issue regardless of how
  // the recommended option is expressed at the question level.
  for (const choice of choices) {
    if (typeof choice.description === 'string' && RECOMMENDED_MARKER_RE.test(choice.description)) {
      warnings.push(
        `${prefix}Recommended marker in description (option [${choice.id}]) — must be in label only`,
      );
    }
  }

  if (choices.length < 2) {
    return; // Rule 1 already warned; skip marker checks for degenerate cases.
  }

  // New API: explicit recommendedChoiceId satisfies the "Recommended" invariant.
  // Only nudge toward the legacy label suffix when no valid id is provided.
  if (
    typeof recommendedChoiceId === 'string' &&
    choices.some((c) => c.id === recommendedChoiceId)
  ) {
    return;
  }

  let markerCount = 0;
  for (const choice of choices) {
    if (typeof choice.label === 'string' && RECOMMENDED_MARKER_RE.test(choice.label)) {
      markerCount += 1;
    }
  }
  if (markerCount === 0) {
    warnings.push(`${prefix}no Recommended marker — mark one option as '(Recommended · N/M)'`);
  } else if (markerCount > 1) {
    warnings.push(`${prefix}multiple Recommended markers (${markerCount}) — exactly one expected`);
  }
}

function pushForbiddenLabelWarnings(choices: UserChoiceOption[], prefix: string, warnings: string[]): void {
  for (const choice of choices) {
    if (typeof choice.label !== 'string') continue;
    const stripped = choice.label.replace(RECOMMENDED_MARKER_RE, '');
    if (isForbiddenMetaLabel(stripped)) {
      warnings.push(
        `${prefix}option [${choice.id}] label '${choice.label}' is a meta/approval verb — use actionable domain-specific verb phrase`,
      );
    }
  }
}

function isForbiddenMetaLabel(label: string): boolean {
  // Normalize: trim, strip leading/trailing non-word characters, lowercase.
  // Exact match against the forbidden set — substring match would incorrectly
  // flag valid domain labels like "Proceed to zwork".
  const normalized = label.trim().replace(/^[^\w]+|[^\w]+$/g, '').toLowerCase();
  if (normalized.length === 0) return false;
  return FORBIDDEN_META_LABELS.has(normalized);
}

function parseSaveContextResultParams(
  raw: unknown,
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

function parseContinueSessionParams(
  raw: unknown,
): { ok: true; value: ContinueSessionParams } | { ok: false; error: ModelCommandError } {
  if (!isRecord(raw)) {
    return invalidArgs('CONTINUE_SESSION params must be an object');
  }

  const prompt = toOptionalString(raw.prompt);
  if (!prompt) {
    return invalidArgs('CONTINUE_SESSION prompt must be a non-empty string');
  }

  const resetSession = raw.resetSession;
  if (resetSession !== undefined && typeof resetSession !== 'boolean') {
    return invalidArgs('CONTINUE_SESSION resetSession must be a boolean');
  }

  const dispatchText = raw.dispatchText;
  if (dispatchText !== undefined && typeof dispatchText !== 'string') {
    return invalidArgs('CONTINUE_SESSION dispatchText must be a string');
  }

  const forceWorkflow = raw.forceWorkflow;
  if (forceWorkflow !== undefined) {
    if (typeof forceWorkflow !== 'string' || !WORKFLOW_TYPES.includes(forceWorkflow as WorkflowType)) {
      return invalidArgs('CONTINUE_SESSION forceWorkflow must be a valid workflow type', {
        allowedWorkflowTypes: WORKFLOW_TYPES,
      });
    }

    if (resetSession !== true) {
      return invalidArgs('CONTINUE_SESSION forceWorkflow requires resetSession=true');
    }
  }

  return {
    ok: true,
    value: {
      prompt,
      resetSession: resetSession === undefined ? false : resetSession,
      dispatchText: toOptionalString(dispatchText),
      forceWorkflow: forceWorkflow as WorkflowType | undefined,
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

function invalidAskUserQuestionArgs(
  raw: Record<string, unknown> | undefined,
  reason: 'params_not_object' | 'missing_payload' | 'invalid_payload_type' | 'payload_schema_invalid',
): { ok: false; error: ModelCommandError } {
  const payloadType = raw && isRecord(raw.payload) ? raw.payload.type : undefined;
  const details = {
    reason,
    requiredTopLevel: ['payload'],
    allowedPayloadTypes: [...ASK_USER_QUESTION_ALLOWED_TYPES],
    receivedKeys: raw ? Object.keys(raw) : [],
    receivedPayloadType: typeof payloadType === 'string' ? payloadType : typeof payloadType,
    examples: ASK_USER_QUESTION_EXAMPLES,
  };
  return invalidArgs(ASK_USER_QUESTION_INVALID_MESSAGE, details);
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
  const recommendedChoiceId = resolveRecommendedChoiceId(raw.recommendedChoiceId, options);
  return {
    id,
    question,
    context: toOptionalString(raw.context),
    choices: options,
    ...(recommendedChoiceId ? { recommendedChoiceId } : {}),
  };
}

function normalizeUserChoice(raw: Record<string, unknown>): UserChoice | null {
  const question = toOptionalString(raw.question);
  const options = normalizeChoiceOptions(raw.choices ?? raw.options);
  if (!question || options.length === 0) {
    return null;
  }
  const recommendedChoiceId = resolveRecommendedChoiceId(raw.recommendedChoiceId, options);
  return {
    type: 'user_choice',
    question,
    context: toOptionalString(raw.context),
    choices: options,
    ...(recommendedChoiceId ? { recommendedChoiceId } : {}),
  };
}

/**
 * Resolve the recommendedChoiceId:
 * - If an explicit id is provided and it matches one of the options, keep it.
 * - If explicit id is provided but doesn't match, drop silently.
 * - If missing/invalid, scan options[].label for a legacy "(Recommended...)" marker; first match becomes implicit id.
 */
function resolveRecommendedChoiceId(
  explicitId: unknown,
  options: UserChoiceOption[],
): string | undefined {
  if (typeof explicitId === 'string' && explicitId.trim() !== '') {
    if (options.some((o) => o.id === explicitId)) {
      return explicitId;
    }
    // explicit but unknown — drop silently, fall through to legacy scan
  }
  const legacy = options.find((o) => LEGACY_RECOMMENDED_SUFFIX_RE.test(o.label));
  return legacy?.id;
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
  if (raw === 'github' || raw === 'jira' || raw === 'confluence' || raw === 'linear' || raw === 'unknown') {
    return raw;
  }
  return 'unknown';
}

function invalidArgs(message: string, details?: unknown): { ok: false; error: ModelCommandError } {
  return {
    ok: false,
    error: {
      code: 'INVALID_ARGS',
      message,
      ...(details !== undefined ? { details } : {}),
    },
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
