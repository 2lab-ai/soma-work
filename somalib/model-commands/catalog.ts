import type {
  SessionInstruction,
  SessionInstructionOperation,
  SessionLink,
  SessionResourceSnapshot,
  SessionResourceType,
  SessionResourceUpdateRequest,
} from './session-types';
// Memory store interface — injected by the host app via registerMemoryStore().
// MCP servers that don't use SAVE_MEMORY/GET_MEMORY don't need to register.
export interface MemoryStore {
  addMemory(user: string, target: string, content: string): { ok: boolean; message: string };
  replaceMemory(user: string, target: string, oldText: string, content: string): { ok: boolean; message: string };
  removeMemory(user: string, target: string, oldText: string): { ok: boolean; message: string };
  loadMemory(user: string, target: string): { entries: string[]; charLimit: number; totalChars: number; percentUsed: number };
}

let _memoryStore: MemoryStore | null = null;

/** Register the memory store implementation. Must be called before SAVE_MEMORY/GET_MEMORY commands. */
export function registerMemoryStore(store: MemoryStore): void {
  _memoryStore = store;
}

function getMemoryStore(): MemoryStore {
  if (!_memoryStore) {
    throw new Error('Memory store not registered. Call registerMemoryStore() before using SAVE_MEMORY/GET_MEMORY.');
  }
  return _memoryStore;
}

// Skill store interface — injected by the host app via registerSkillStore().
export interface SkillStore {
  listSkills(user: string): Array<{ name: string; description: string }>;
  createSkill(user: string, name: string, content: string): { ok: boolean; message: string };
  updateSkill(user: string, name: string, content: string): { ok: boolean; message: string };
  deleteSkill(user: string, name: string): { ok: boolean; message: string };
  /**
   * Read the full SKILL.md content for cross-user copy-paste install.
   *
   * Contract:
   *   - happy: `{ ok: true, message, content }` — `content` is the raw SKILL.md
   *     bytes, not yet capped (the dispatcher applies `SHARE_CONTENT_CHAR_LIMIT`)
   *   - invalid name: `{ ok: false, message: invalidSkillNameMessage(name) }`
   *   - not found:    `{ ok: false, message: skillNotFoundMessage(name) }`
   *
   * Both implementations import their messages from `skill-share-errors.ts`
   * so the two layers cannot drift on user-facing wording.
   */
  shareSkill(
    user: string,
    name: string,
  ): { ok: boolean; message: string; content?: string };
  /**
   * Rename a skill directory in place: `skills/{name}/` → `skills/{newName}/`.
   *
   * Implementation contract (both storage layers):
   *   - happy:        `{ ok: true, message: skillRenameSuccessMessage(...) }`
   *   - same name:    `{ ok: false, message, error: 'INVALID' }`
   *   - source gone:  `{ ok: false, message, error: 'NOT_FOUND' }`
   *   - target taken: `{ ok: false, message, error: 'EEXIST' }`
   *   - bad name:     `{ ok: false, message, error: 'INVALID' }`
   *   - fs failure:   `{ ok: false, message, error: 'IO' }` (post-pre-check race)
   *
   * Move semantics: the implementation MUST stage through a temporary path
   * inside the user's `skills/` directory so case-only renames (e.g. `foo`
   * → `Foo`) work on case-insensitive filesystems without losing the source.
   * Plain `fs.renameSync(src, dst)` would no-op on Darwin/Windows when the
   * inode is identical.
   */
  renameSkill(
    user: string,
    name: string,
    newName: string,
  ): { ok: boolean; message: string; error?: 'NOT_FOUND' | 'EEXIST' | 'INVALID' | 'IO' };
}

let _skillStore: SkillStore | null = null;

/** Register the skill store implementation. Must be called before MANAGE_SKILL commands. */
export function registerSkillStore(store: SkillStore): void {
  _skillStore = store;
}

function getSkillStore(): SkillStore {
  if (!_skillStore) {
    throw new Error('Skill store not registered. Call registerSkillStore() before using MANAGE_SKILL.');
  }
  return _skillStore;
}

// Rating store interface — injected by the host app via registerRatingStore().
// Returns user's current model rating (0-10, default 5).
export interface RatingStore {
  getUserRating(userId: string): number;
}

let _ratingStore: RatingStore | null = null;

/** Register the rating store implementation. Must be called before RATE command. */
export function registerRatingStore(store: RatingStore): void {
  _ratingStore = store;
}

function getRatingStore(): RatingStore | null {
  return _ratingStore;
}

import type {
  ContinueSessionParams,
  ManageSkillParams,
  ModelCommandContext,
  ModelCommandDescriptor,
  ModelCommandError,
  ModelCommandRunRequest,
  ModelCommandRunResponse,
  SaveMemoryParams,
} from './types';
import {
  SHARE_CONTENT_CHAR_LIMIT,
  shareOverLimitMessage,
  shareSuccessMessage,
} from './skill-share-errors';
import { checkAskUserQuestionQuality } from './validator';

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
    title: {
      type: 'string',
      maxLength: 100,
      description: 'Update session title (e.g. after linking issue or merging PR)',
    },
    operations: {
      type: 'array',
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
    instructionOperations: {
      type: 'array',
      description:
        'Operations on user SSOT instructions (add/remove/clear/complete/setStatus). ' +
        'Writes are NOT applied immediately — the host wraps them in a user y/n ' +
        'confirmation button in Slack. Only `y` commits.',
      items: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['add', 'remove', 'clear', 'complete', 'setStatus'],
          },
          text: {
            type: 'string',
            description: 'Instruction text (required for add)',
          },
          source: {
            type: 'string',
            description: 'Who added this instruction (default: "user")',
          },
          id: {
            type: 'string',
            description: 'Instruction ID (required for remove/complete/setStatus)',
          },
          evidence: {
            type: 'string',
            description: 'Evidence string (required for complete)',
          },
          status: {
            type: 'string',
            enum: ['active', 'todo', 'completed'],
            description: 'New status (required for setStatus)',
          },
        },
        required: ['action'],
      },
    },
  },
  // operations OR title OR instructionOperations must be present
  additionalProperties: false,
};

const ASK_USER_QUESTION_SCHEMA = {
  type: 'object',
  properties: {
    payload: {
      oneOf: [
        {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['user_choice'] },
            question: { type: 'string' },
            context: { type: 'string' },
            recommendedChoiceId: {
              type: 'string',
              description: 'ID of the recommended choice option (must match one of choices[].id)',
            },
            choices: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  label: { type: 'string' },
                  description: { type: 'string' },
                },
                required: ['label'],
              },
            },
          },
          required: ['type', 'question', 'choices'],
        },
        {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['user_choice_group'] },
            question: { type: 'string' },
            context: { type: 'string' },
            choices: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                properties: {
                  question: { type: 'string' },
                  context: { type: 'string' },
                  recommendedChoiceId: {
                    type: 'string',
                    description: 'ID of the recommended option for this question',
                  },
                  options: {
                    type: 'array',
                    minItems: 1,
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        label: { type: 'string' },
                        description: { type: 'string' },
                      },
                      required: ['label'],
                    },
                  },
                  choices: {
                    type: 'array',
                    minItems: 1,
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        label: { type: 'string' },
                        description: { type: 'string' },
                      },
                      required: ['label'],
                    },
                  },
                },
                required: ['question'],
              },
            },
          },
          required: ['type', 'question', 'choices'],
        },
      ],
      description: 'Strict payload: user_choice or user_choice_group',
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

const SAVE_MEMORY_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['add', 'replace', 'remove'],
      description: 'add: append new entry, replace: update existing, remove: delete entry',
    },
    target: {
      type: 'string',
      enum: ['memory', 'user'],
      description: 'memory: agent notes (env facts, conventions), user: user profile (preferences, style)',
    },
    content: {
      type: 'string',
      description: 'Text to save (required for add/replace)',
    },
    old_text: {
      type: 'string',
      description: 'Substring to match existing entry (required for replace/remove)',
    },
  },
  required: ['action', 'target'],
};

const MANAGE_SKILL_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['create', 'update', 'delete', 'list', 'share', 'rename'],
      description:
        'create: new skill, update: overwrite existing, delete: remove, ' +
        'list: show all, share: return full content for cross-user copy-paste install, ' +
        'rename: move SKILL.md directory from `name` to `newName`',
    },
    name: {
      type: 'string',
      description:
        'Skill name in kebab-case (e.g. my-deploy). Required for create/update/delete/share/rename.',
    },
    newName: {
      type: 'string',
      description:
        'New skill name (kebab-case). Required for rename only — must differ from `name`.',
    },
    content: {
      type: 'string',
      description:
        'Full SKILL.md content with YAML frontmatter. Required for create/update. ' +
        'Must NOT be supplied for share or rename (server reads existing content for share; ' +
        'rename is metadata-only and does not change SKILL.md bytes).',
    },
  },
  required: ['action'],
};

const CONTINUE_SESSION_SCHEMA = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      description: 'Prompt to send into the next execution turn',
    },
    resetSession: {
      type: 'boolean',
      description: 'Reset session context before continuing',
    },
    dispatchText: {
      type: 'string',
      description: 'Optional dispatch text used for workflow routing',
    },
    forceWorkflow: {
      type: 'string',
      enum: [
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
      ],
      description: 'Optional explicit workflow to enter after reset',
    },
  },
  required: ['prompt'],
};

export function getDefaultSessionSnapshot(): SessionResourceSnapshot {
  return {
    issues: [],
    prs: [],
    docs: [],
    active: {},
    instructions: [],
    sequence: 0,
  };
}

export function normalizeSessionSnapshot(snapshot: SessionResourceSnapshot | undefined): SessionResourceSnapshot {
  if (!snapshot) {
    return getDefaultSessionSnapshot();
  }

  return {
    issues: (snapshot.issues || []).map((link) => normalizeLink(link, 'issue')),
    prs: (snapshot.prs || []).map((link) => normalizeLink(link, 'pr')),
    docs: (snapshot.docs || []).map((link) => normalizeLink(link, 'doc')),
    active: {
      issue: snapshot.active?.issue ? normalizeLink(snapshot.active.issue, 'issue') : undefined,
      pr: snapshot.active?.pr ? normalizeLink(snapshot.active.pr, 'pr') : undefined,
      doc: snapshot.active?.doc ? normalizeLink(snapshot.active.doc, 'doc') : undefined,
    },
    instructions: Array.isArray(snapshot.instructions) ? snapshot.instructions : [],
    sequence: Number.isFinite(snapshot.sequence) ? snapshot.sequence : 0,
  };
}

export function listModelCommands(context: ModelCommandContext): ModelCommandDescriptor[] {
  const commands: ModelCommandDescriptor[] = [
    {
      id: 'GET_SESSION',
      description: 'Read current session resources (issues/prs/docs + active + instructions + sequence)',
      paramsSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      id: 'UPDATE_SESSION',
      description:
        'Update session resources (issues/prs/docs) with add/remove/set_active operations. ' +
        'Instruction writes via `instructionOperations` (add/remove/clear/complete/setStatus) ' +
        'are **gated**: the host posts a user y/n button and only commits on `y`. ' +
        'Until `y`, the model’s view of `session.instructions` is unchanged.',
      paramsSchema: UPDATE_SESSION_SCHEMA,
      metadata: {
        user_instructions_write_gated: true,
      },
    },
    {
      id: 'ASK_USER_QUESTION',
      description: 'Render user-choice UI in Slack thread',
      paramsSchema: ASK_USER_QUESTION_SCHEMA,
    },
    {
      id: 'CONTINUE_SESSION',
      description: 'Return a typed continuation so the host can continue or re-dispatch the workflow',
      paramsSchema: CONTINUE_SESSION_SCHEMA,
    },
  ];

  if (context.user) {
    commands.push(
      {
        id: 'SAVE_MEMORY',
        description:
          'Save persistent memory across sessions. Use for: user preferences, environment details, tool quirks, stable conventions. Do NOT save: task progress, session outcomes, temporary state.',
        paramsSchema: SAVE_MEMORY_SCHEMA,
      },
      {
        id: 'GET_MEMORY',
        description: 'Read current persistent memory and user profile entries',
        paramsSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      {
        id: 'MANAGE_SKILL',
        description:
          'Create, update, delete, rename, list, or share user personal skills. ' +
          'Skills are SKILL.md files with YAML frontmatter. Invoke via $user:skill-name. ' +
          'Immediately available after creation. ' +
          'rename: pass `name` (current) + `newName` (kebab-case, different) — moves ' +
          'the entire skill directory in place so multi-file skills keep their ' +
          'sibling resources. ' +
          'share: pass only `name` — the response payload returns the full SKILL.md ' +
          'content for cross-user copy-paste install. When you receive a share response, ' +
          'render the returned content verbatim inside a fenced code block in the Slack ' +
          'thread, then append a single line instructing any reader to invoke MANAGE_SKILL ' +
          'with action=create using the same name and content to install the skill on ' +
          "their own account. Maximum shareable content is " +
          `${SHARE_CONTENT_CHAR_LIMIT} characters; over-cap returns ok=false and the ` +
          'caller must trim the SKILL.md before retrying.',
        paramsSchema: MANAGE_SKILL_SCHEMA,
      },
      {
        id: 'RATE',
        description: 'Get the current user rating for this model (0-10). The rating reflects user satisfaction and is also visible in <your_rating> context tag.',
        paramsSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
    );
  }

  if (context.renewState === 'pending_save') {
    commands.push({
      id: 'SAVE_CONTEXT_RESULT',
      description: 'Store save result payload for renew continuation',
      paramsSchema: SAVE_CONTEXT_RESULT_SCHEMA,
    });
  }

  return commands;
}

function toRunError(commandId: ModelCommandRunRequest['commandId'], error: ModelCommandError): ModelCommandRunResponse {
  return {
    type: 'model_command_result',
    commandId,
    ok: false,
    error,
  };
}

function updateActiveFromArray(snapshot: SessionResourceSnapshot, resourceType: SessionResourceType): void {
  const historyKey = HISTORY_KEY_BY_RESOURCE[resourceType];
  const activeKey = ACTIVE_KEY_BY_RESOURCE[resourceType];
  const links = snapshot[historyKey];
  snapshot.active[activeKey] = links.length > 0 ? links[links.length - 1] : undefined;
}

export function applySessionUpdateToSnapshot(
  snapshot: SessionResourceSnapshot,
  request: SessionResourceUpdateRequest,
): { ok: true; snapshot: SessionResourceSnapshot } | { ok: false; error: ModelCommandError } {
  if (typeof request.expectedSequence === 'number' && request.expectedSequence !== snapshot.sequence) {
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

  for (const operation of request.operations ?? []) {
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

  // NOTE: Instruction operations are NOT applied here.
  // They are applied host-side only (session-registry) to ensure
  // a single source of truth for generated IDs/timestamps.

  if (changed) {
    snapshot.sequence += 1;
  }

  return { ok: true, snapshot };
}

export function runModelCommand(
  request: ModelCommandRunRequest,
  context: ModelCommandContext,
): ModelCommandRunResponse {
  const session = normalizeSessionSnapshot(context.session);

  if (request.commandId === 'GET_SESSION') {
    return {
      type: 'model_command_result',
      commandId: 'GET_SESSION',
      ok: true,
      payload: {
        session,
        title: context.sessionTitle ?? null,
      },
    };
  }

  if (request.commandId === 'UPDATE_SESSION') {
    // Apply resource operations (model-side preview)
    const operations = request.params.operations ?? [];
    const updateResult = applySessionUpdateToSnapshot(session, { ...request.params, operations });
    if (!updateResult.ok) {
      return toRunError('UPDATE_SESSION', updateResult.error);
    }

    const instructionOps = request.params.instructionOperations ?? [];
    // Instruction writes are user y/n gated — the model-command layer
    // never applies them directly. The host (stream-executor) wraps them
    // in a confirmation UI and only commits on `y`. Emit the counts so the
    // model can see its writes are pending, not dropped.
    const confirmationRequired = instructionOps.length > 0;

    return {
      type: 'model_command_result',
      commandId: 'UPDATE_SESSION',
      ok: true,
      payload: {
        session: updateResult.snapshot,
        appliedOperations: operations.length,
        appliedInstructionOperations: 0,
        pendingInstructionOperations: instructionOps.length,
        confirmationRequired,
        request: request.params,
        // title is passed through for host to apply
        ...(request.params.title ? { title: request.params.title } : {}),
      },
    };
  }

  if (request.commandId === 'ASK_USER_QUESTION') {
    const warnings = checkAskUserQuestionQuality(request.params);
    return {
      type: 'model_command_result',
      commandId: 'ASK_USER_QUESTION',
      ok: true,
      payload: {
        question: request.params.question,
        ...(warnings.length > 0 ? { warnings } : {}),
      },
    };
  }

  if (request.commandId === 'CONTINUE_SESSION') {
    return {
      type: 'model_command_result',
      commandId: 'CONTINUE_SESSION',
      ok: true,
      payload: {
        continuation: normalizeContinuation(request.params),
      },
    };
  }

  if (request.commandId === 'SAVE_MEMORY') {
    if (!context.user) {
      return toRunError('SAVE_MEMORY', { code: 'CONTEXT_ERROR', message: 'No user context available' });
    }
    const params = request.params as SaveMemoryParams;
    let result;
    if (params.action === 'add') {
      if (!params.content) {
        return toRunError('SAVE_MEMORY', { code: 'INVALID_ARGS', message: 'content is required for add' });
      }
      result = getMemoryStore().addMemory(context.user, params.target, params.content);
    } else if (params.action === 'replace') {
      if (!params.old_text || !params.content) {
        return toRunError('SAVE_MEMORY', {
          code: 'INVALID_ARGS',
          message: 'old_text and content are required for replace',
        });
      }
      result = getMemoryStore().replaceMemory(context.user, params.target, params.old_text, params.content);
    } else if (params.action === 'remove') {
      if (!params.old_text) {
        return toRunError('SAVE_MEMORY', { code: 'INVALID_ARGS', message: 'old_text is required for remove' });
      }
      result = getMemoryStore().removeMemory(context.user, params.target, params.old_text);
    } else {
      return toRunError('SAVE_MEMORY', { code: 'INVALID_ARGS', message: `Unknown action: ${params.action}` });
    }
    return {
      type: 'model_command_result',
      commandId: 'SAVE_MEMORY',
      ok: true,
      payload: { ok: result.ok, message: result.message },
    };
  }

  if (request.commandId === 'GET_MEMORY') {
    if (!context.user) {
      return toRunError('GET_MEMORY', { code: 'CONTEXT_ERROR', message: 'No user context available' });
    }
    const store = getMemoryStore();
    const mem = store.loadMemory(context.user, 'memory');
    const usr = store.loadMemory(context.user, 'user');
    return {
      type: 'model_command_result',
      commandId: 'GET_MEMORY',
      ok: true,
      payload: {
        memory: mem.entries,
        user: usr.entries,
        memoryChars: mem.totalChars,
        memoryLimit: mem.charLimit,
        userChars: usr.totalChars,
        userLimit: usr.charLimit,
      },
    };
  }

  if (request.commandId === 'MANAGE_SKILL') {
    if (!context.user) {
      return toRunError('MANAGE_SKILL', { code: 'CONTEXT_ERROR', message: 'No user context available' });
    }
    const params = request.params as ManageSkillParams;
    const store = getSkillStore();

    if (params.action === 'list') {
      const skills = store.listSkills(context.user);
      return {
        type: 'model_command_result',
        commandId: 'MANAGE_SKILL',
        ok: true,
        payload: { ok: true, message: `${skills.length} skills found`, skills },
      };
    }
    if (params.action === 'create') {
      if (!params.name || !params.content) {
        return toRunError('MANAGE_SKILL', { code: 'INVALID_ARGS', message: 'name and content required for create' });
      }
      const result = store.createSkill(context.user, params.name, params.content);
      return {
        type: 'model_command_result',
        commandId: 'MANAGE_SKILL',
        ok: true,
        payload: {
          ok: result.ok,
          message: result.message,
          // Stamp the mutation signal only on the happy path. A failed create
          // (over cap, name collision, validation error) hasn't changed disk
          // state, so emitting `mutated` would falsely invalidate the cached
          // system prompt and trigger a wasted rebuild.
          ...(result.ok
            ? { mutated: { kind: 'skill' as const, user: context.user, action: 'create' as const } }
            : {}),
        },
      };
    }
    if (params.action === 'update') {
      if (!params.name || !params.content) {
        return toRunError('MANAGE_SKILL', { code: 'INVALID_ARGS', message: 'name and content required for update' });
      }
      const result = store.updateSkill(context.user, params.name, params.content);
      return {
        type: 'model_command_result',
        commandId: 'MANAGE_SKILL',
        ok: true,
        payload: {
          ok: result.ok,
          message: result.message,
          ...(result.ok
            ? { mutated: { kind: 'skill' as const, user: context.user, action: 'update' as const } }
            : {}),
        },
      };
    }
    if (params.action === 'delete') {
      if (!params.name) {
        return toRunError('MANAGE_SKILL', { code: 'INVALID_ARGS', message: 'name required for delete' });
      }
      const result = store.deleteSkill(context.user, params.name);
      return {
        type: 'model_command_result',
        commandId: 'MANAGE_SKILL',
        ok: true,
        payload: {
          ok: result.ok,
          message: result.message,
          ...(result.ok
            ? { mutated: { kind: 'skill' as const, user: context.user, action: 'delete' as const } }
            : {}),
        },
      };
    }
    if (params.action === 'rename') {
      if (!params.name || !params.newName) {
        return toRunError('MANAGE_SKILL', {
          code: 'INVALID_ARGS',
          message: 'name and newName required for rename',
        });
      }
      const result = store.renameSkill(context.user, params.name, params.newName);
      return {
        type: 'model_command_result',
        commandId: 'MANAGE_SKILL',
        ok: true,
        payload: {
          ok: result.ok,
          message: result.message,
          // Same emit-on-success-only invariant as create/update/delete:
          // a failed rename did not change disk state. The granular `error`
          // discriminant from storage is intentionally NOT exposed on the
          // wire — Slack rename modal consumes it via the in-process call,
          // and remote callers only need ok/message.
          ...(result.ok
            ? { mutated: { kind: 'skill' as const, user: context.user, action: 'rename' as const } }
            : {}),
        },
      };
    }
    if (params.action === 'share') {
      if (!params.name) {
        return toRunError('MANAGE_SKILL', { code: 'INVALID_ARGS', message: 'name required for share' });
      }
      const result = store.shareSkill(context.user, params.name);
      // Storage-level failures (invalid name / not found) propagate verbatim —
      // both layers source their messages from `skill-share-errors.ts` so they
      // cannot drift.
      if (!result.ok || result.content === undefined) {
        return {
          type: 'model_command_result',
          commandId: 'MANAGE_SKILL',
          ok: true,
          payload: { ok: result.ok, message: result.message },
        };
      }
      // Wire-format constraint owned by the dispatcher, not the storage layer:
      // refuse to ship payloads larger than the Slack rich-text rendering
      // budget. Measured in characters (UTF-16 code units), matching how the
      // recipient model will count when it inlines the body in a code block.
      if (result.content.length > SHARE_CONTENT_CHAR_LIMIT) {
        return {
          type: 'model_command_result',
          commandId: 'MANAGE_SKILL',
          ok: true,
          payload: {
            ok: false,
            message: shareOverLimitMessage(params.name, result.content.length),
          },
        };
      }
      return {
        type: 'model_command_result',
        commandId: 'MANAGE_SKILL',
        ok: true,
        payload: {
          ok: true,
          message: shareSuccessMessage(params.name),
          name: params.name,
          content: result.content,
        },
      };
    }
    return toRunError('MANAGE_SKILL', { code: 'INVALID_ARGS', message: `Unknown action: ${params.action}` });
  }

  if (request.commandId === 'RATE') {
    if (!context.user) {
      return toRunError('RATE', { code: 'CONTEXT_ERROR', message: 'No user context available' });
    }
    const store = getRatingStore();
    const rating = store ? store.getUserRating(context.user) : 5;
    return {
      type: 'model_command_result',
      commandId: 'RATE',
      ok: true,
      payload: { rating },
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

function normalizeContinuation(params: ContinueSessionParams) {
  return {
    prompt: params.prompt,
    resetSession: params.resetSession,
    dispatchText: params.dispatchText,
    forceWorkflow: params.forceWorkflow,
  };
}

/** Maximum number of instructions per session to prevent unbounded growth. */
const MAX_INSTRUCTIONS = 50;

let _instrCounter = 0;

/**
 * Apply instruction operations (add/remove/clear) to a mutable instructions array.
 * Shared between catalog (snapshot) and session-registry (host-side).
 * Returns true if any mutation occurred.
 */
export function applyInstructionOperations(
  instructions: SessionInstruction[],
  ops: SessionInstructionOperation[] | undefined,
): boolean {
  if (!ops || ops.length === 0) return false;

  let changed = false;
  for (const op of ops) {
    if (op.action === 'add') {
      if (!op.text || op.text.trim().length === 0) continue;
      if (instructions.length >= MAX_INSTRUCTIONS) continue;
      const now = Date.now();
      instructions.push({
        id: `instr_${now}_${++_instrCounter}`,
        text: op.text.trim(),
        addedAt: now,
        source: op.source || 'user',
        status: 'active',
      });
      changed = true;
      continue;
    }

    if (op.action === 'remove') {
      const idx = instructions.findIndex((i) => i.id === op.id);
      if (idx >= 0) {
        instructions.splice(idx, 1);
        changed = true;
      }
      continue;
    }

    if (op.action === 'clear') {
      if (instructions.length > 0) {
        instructions.length = 0;
        changed = true;
      }
      continue;
    }

    if (op.action === 'complete') {
      // Evidence is required — silently skip rather than throw, matching the
      // lenient semantics of the rest of this function (malformed ops drop).
      if (!op.id || !op.evidence || op.evidence.trim().length === 0) continue;
      const entry = instructions.find((i) => i.id === op.id);
      if (!entry) continue;
      entry.status = 'completed';
      entry.evidence = op.evidence.trim();
      entry.completedAt = Date.now();
      changed = true;
      continue;
    }

    if (op.action === 'setStatus') {
      if (!op.id || !op.status) continue;
      const entry = instructions.find((i) => i.id === op.id);
      if (!entry) continue;
      if (entry.status === op.status) continue;
      entry.status = op.status;
      if (op.status === 'completed') {
        // setStatus→completed is an escape hatch — stamp completedAt so the
        // summary hash and block builder see a consistent timestamp. Evidence
        // is NOT required on this path (prefer `complete` when evidence exists).
        entry.completedAt = entry.completedAt ?? Date.now();
      } else {
        // Moving out of `completed` — clear the boundary fields.
        entry.completedAt = undefined;
        entry.evidence = undefined;
      }
      changed = true;
    }
  }
  return changed;
}
