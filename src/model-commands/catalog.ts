import {
  SessionLink,
  SessionResourceSnapshot,
  SessionResourceType,
  SessionResourceUpdateRequest,
} from '../types';
import {
  ModelCommandContext,
  ModelCommandDescriptor,
  ModelCommandError,
  ModelCommandRunRequest,
  ModelCommandRunResponse,
} from './types';

const HISTORY_KEY_BY_RESOURCE: Record<SessionResourceType, 'issues' | 'prs' | 'docs'> = {
  issue: 'issues',
  pr: 'prs',
  doc: 'docs',
};

const ACTIVE_KEY_BY_RESOURCE: Record<SessionResourceType, 'issue' | 'pr' | 'doc'> = {
  issue: 'issue',
  pr: 'pr',
  doc: 'doc',
};

const UPDATE_SESSION_SCHEMA = {
  type: 'object',
  properties: {
    expectedSequence: {
      type: 'number',
      description: 'Optional optimistic lock sequence from GET_SESSION',
    },
    operations: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['add', 'remove', 'set_active'],
          },
          resourceType: {
            type: 'string',
            enum: ['issue', 'pr', 'doc'],
          },
          link: { type: 'object' },
          url: { type: 'string' },
        },
        required: ['action', 'resourceType'],
      },
    },
  },
  required: ['operations'],
};

const ASK_USER_QUESTION_SCHEMA = {
  type: 'object',
  properties: {
    payload: {
      type: 'object',
      description: 'user_choice | user_choices | user_choice_group payload',
    },
  },
  required: ['payload'],
};

const SAVE_CONTEXT_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    result: {
      type: 'object',
      description: 'save_result payload (success/id/path/files/error)',
    },
  },
  required: ['result'],
};

export function getDefaultSessionSnapshot(): SessionResourceSnapshot {
  return {
    issues: [],
    prs: [],
    docs: [],
    active: {},
    sequence: 0,
  };
}

export function normalizeSessionSnapshot(
  snapshot: SessionResourceSnapshot | undefined
): SessionResourceSnapshot {
  if (!snapshot) {
    return getDefaultSessionSnapshot();
  }

  return {
    issues: (snapshot.issues || []).map((link) => normalizeLink(link, 'issue')),
    prs: (snapshot.prs || []).map((link) => normalizeLink(link, 'pr')),
    docs: (snapshot.docs || []).map((link) => normalizeLink(link, 'doc')),
    active: {
      issue: snapshot.active?.issue
        ? normalizeLink(snapshot.active.issue, 'issue')
        : undefined,
      pr: snapshot.active?.pr ? normalizeLink(snapshot.active.pr, 'pr') : undefined,
      doc: snapshot.active?.doc ? normalizeLink(snapshot.active.doc, 'doc') : undefined,
    },
    sequence: Number.isFinite(snapshot.sequence) ? snapshot.sequence : 0,
  };
}

export function listModelCommands(context: ModelCommandContext): ModelCommandDescriptor[] {
  const commands: ModelCommandDescriptor[] = [
    {
      id: 'GET_SESSION',
      description: 'Read current session resources (issues/prs/docs + active + sequence)',
      paramsSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      id: 'UPDATE_SESSION',
      description: 'Update session resources with add/remove/set_active operations',
      paramsSchema: UPDATE_SESSION_SCHEMA,
    },
    {
      id: 'ASK_USER_QUESTION',
      description: 'Render user-choice UI in Slack thread',
      paramsSchema: ASK_USER_QUESTION_SCHEMA,
    },
  ];

  if (context.renewState === 'pending_save') {
    commands.push({
      id: 'SAVE_CONTEXT_RESULT',
      description: 'Store save result payload for renew continuation',
      paramsSchema: SAVE_CONTEXT_RESULT_SCHEMA,
    });
  }

  return commands;
}

function toRunError(
  commandId: ModelCommandRunRequest['commandId'],
  error: ModelCommandError
): ModelCommandRunResponse {
  return {
    type: 'model_command_result',
    commandId,
    ok: false,
    error,
  };
}

function updateActiveFromArray(
  snapshot: SessionResourceSnapshot,
  resourceType: SessionResourceType
): void {
  const historyKey = HISTORY_KEY_BY_RESOURCE[resourceType];
  const activeKey = ACTIVE_KEY_BY_RESOURCE[resourceType];
  const links = snapshot[historyKey];
  snapshot.active[activeKey] = links.length > 0 ? links[links.length - 1] : undefined;
}

export function applySessionUpdateToSnapshot(
  snapshot: SessionResourceSnapshot,
  request: SessionResourceUpdateRequest
): { ok: true; snapshot: SessionResourceSnapshot } | { ok: false; error: ModelCommandError } {
  if (
    typeof request.expectedSequence === 'number'
    && request.expectedSequence !== snapshot.sequence
  ) {
    return {
      ok: false,
      error: {
        code: 'SEQUENCE_MISMATCH',
        message: 'Session sequence mismatch',
        details: {
          expected: request.expectedSequence,
          actual: snapshot.sequence,
        },
      },
    };
  }

  let changed = false;

  for (const operation of request.operations) {
    const historyKey = HISTORY_KEY_BY_RESOURCE[operation.resourceType];
    const activeKey = ACTIVE_KEY_BY_RESOURCE[operation.resourceType];
    const links = snapshot[historyKey];

    if (operation.action === 'add') {
      const normalized = normalizeLink(operation.link, operation.resourceType);
      const existingIndex = links.findIndex((link) => link.url === normalized.url);
      if (existingIndex >= 0) {
        links.splice(existingIndex, 1);
      }
      links.push(normalized);
      snapshot.active[activeKey] = normalized;
      changed = true;
      continue;
    }

    if (operation.action === 'remove') {
      const existingIndex = links.findIndex((link) => link.url === operation.url);
      if (existingIndex >= 0) {
        links.splice(existingIndex, 1);
        changed = true;
      }
      if (snapshot.active[activeKey]?.url === operation.url) {
        updateActiveFromArray(snapshot, operation.resourceType);
        changed = true;
      }
      continue;
    }

    if (!operation.url) {
      if (snapshot.active[activeKey]) {
        snapshot.active[activeKey] = undefined;
        changed = true;
      }
      continue;
    }

    const found = links.find((link) => link.url === operation.url);
    if (!found) {
      return {
        ok: false,
        error: {
          code: 'INVALID_OPERATION',
          message: `Cannot set active ${operation.resourceType}: url not found in history`,
          details: operation,
        },
      };
    }

    if (snapshot.active[activeKey]?.url !== found.url) {
      snapshot.active[activeKey] = found;
      changed = true;
    }
  }

  if (changed) {
    snapshot.sequence += 1;
  }

  return { ok: true, snapshot };
}

export function runModelCommand(
  request: ModelCommandRunRequest,
  context: ModelCommandContext
): ModelCommandRunResponse {
  const session = normalizeSessionSnapshot(context.session);

  if (request.commandId === 'GET_SESSION') {
    return {
      type: 'model_command_result',
      commandId: 'GET_SESSION',
      ok: true,
      payload: {
        session,
      },
    };
  }

  if (request.commandId === 'UPDATE_SESSION') {
    const updateResult = applySessionUpdateToSnapshot(
      session,
      request.params
    );
    if (!updateResult.ok) {
      return toRunError('UPDATE_SESSION', updateResult.error);
    }

    return {
      type: 'model_command_result',
      commandId: 'UPDATE_SESSION',
      ok: true,
      payload: {
        session: updateResult.snapshot,
        appliedOperations: request.params.operations.length,
        request: request.params,
      },
    };
  }

  if (request.commandId === 'ASK_USER_QUESTION') {
    return {
      type: 'model_command_result',
      commandId: 'ASK_USER_QUESTION',
      ok: true,
      payload: {
        question: request.params.question,
      },
    };
  }

  if (request.commandId === 'SAVE_CONTEXT_RESULT') {
    return {
      type: 'model_command_result',
      commandId: 'SAVE_CONTEXT_RESULT',
      ok: true,
      payload: {
        saveResult: request.params.result,
      },
    };
  }

  const unreachable: never = request;
  throw new Error(`Unknown command: ${(unreachable as { commandId: string }).commandId}`);
}

function normalizeLink(link: SessionLink, resourceType: SessionResourceType): SessionLink {
  return {
    ...link,
    type: resourceType,
    provider: link.provider || 'unknown',
  };
}
