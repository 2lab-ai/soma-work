import type { ModelCommandError, ModelCommandId } from './types';

/**
 * Self-correcting failure help for the `run` model command.
 *
 * The model that drives this MCP only sees the JSON error returned by a failed
 * `run` call. A terse one-liner like "SAVE_MEMORY action must be 'add',
 * 'replace', or 'remove', got: undefined" tells it *what* was wrong but not the
 * full shape of a valid request — so it retries and fails again the same way
 * (observed in production: six back-to-back SAVE_MEMORY failures).
 *
 * The fix: on the FIRST failure, hand the model a complete, copy-pasteable
 * spec of the command — every action it accepts and at least one example per
 * action — embedded in `error.details.help`. One failure is enough to recover.
 *
 * This module is the single source of that spec. It is intentionally
 * dependency-free (types only) so both the validation layer (`validator.ts`)
 * and the runtime layer (`catalog.ts`) can attach the same help without a
 * circular import.
 */

/** One copy-pasteable example of a valid `params` object for `run`. */
export interface CommandHelpExample {
  /**
   * The `action` this example demonstrates, for commands that dispatch on an
   * `action` enum (SAVE_MEMORY, MANAGE_SKILL). Omitted for commands whose shape
   * is not action-keyed (UPDATE_SESSION, CONTINUE_SESSION, …).
   */
  action?: string;
  /** One-line description of what this example does. */
  title: string;
  /** A complete `params` object that would pass validation. */
  params: Record<string, unknown>;
}

/** Full self-contained help for one command. */
export interface CommandHelp {
  commandId: ModelCommandId;
  summary: string;
  /** The full action enum, present only for action-dispatch commands. */
  actions?: string[];
  /** At least one example per action (or per shape for non-action commands). */
  examples: CommandHelpExample[];
}

const SAVE_MEMORY_HELP: CommandHelp = {
  commandId: 'SAVE_MEMORY',
  summary:
    'Persist long-lived memory. target="memory" = agent notes (env facts, tool quirks, conventions); ' +
    'target="user" = user profile (preferences, style). add appends, replace edits an existing entry by ' +
    'substring match, remove deletes one. Do NOT save task progress or session outcomes.',
  actions: ['add', 'replace', 'remove'],
  examples: [
    {
      action: 'add',
      title: 'Append a new agent-memory entry',
      params: { action: 'add', target: 'memory', content: 'Repo builds with bun, not npm.' },
    },
    {
      action: 'replace',
      title: 'Replace an existing user-profile entry (old_text matches a substring)',
      params: {
        action: 'replace',
        target: 'user',
        old_text: 'prefers verbose explanations',
        content: 'prefers terse, conclusion-first answers',
      },
    },
    {
      action: 'remove',
      title: 'Remove an entry by substring match',
      params: { action: 'remove', target: 'memory', old_text: 'obsolete fact to drop' },
    },
  ],
};

const MEMORY_HELP: CommandHelp = {
  commandId: 'MEMORY',
  summary:
    'Hierarchical taxonomy memory (semantic pages + episodic). op selects the operation. ' +
    'page_upsert/page_get/page_remove take a locator: type=agent|sites|concepts use slug; type=project uses ' +
    'project (+ optional issue); type=cron uses routine. page_upsert sets title/current/history. ' +
    'episodic_append stores a raw dated observation (content). search/index browse pages.',
  examples: [
    {
      title: 'Create/update an agent page',
      params: {
        op: 'page_upsert',
        type: 'agent',
        slug: 'build-system',
        title: 'Build system',
        current: 'Repo builds with bun; run `bun run build`.',
        history: 'Confirmed bun build after npm failed.',
      },
    },
    {
      title: 'Create a project→issue page',
      params: { op: 'page_upsert', type: 'project', project: 'soma-work', issue: '1234', current: 'Spec: ...' },
    },
    { title: 'Append an episodic observation', params: { op: 'episodic_append', content: 'User prefers KRW tables.' } },
    { title: 'Read a page', params: { op: 'page_get', type: 'agent', slug: 'build-system' } },
    { title: 'Search pages', params: { op: 'search', query: 'build' } },
    { title: 'List all pages', params: { op: 'index' } },
  ],
};

const MANAGE_SKILL_HELP: CommandHelp = {
  commandId: 'MANAGE_SKILL',
  summary:
    'Manage personal skills (SKILL.md files invoked via $user:skill-name). create/update need name + content; ' +
    'delete/share/rename/get need name (no content); rename also needs newName; list needs nothing.',
  actions: ['create', 'update', 'delete', 'list', 'share', 'rename', 'get'],
  examples: [
    {
      action: 'create',
      title: 'Create a new skill',
      params: {
        action: 'create',
        name: 'my-deploy',
        content: '---\nname: my-deploy\ndescription: Deploy helper\n---\n\nSteps...',
      },
    },
    {
      action: 'update',
      title: 'Overwrite an existing skill',
      params: {
        action: 'update',
        name: 'my-deploy',
        content: '---\nname: my-deploy\ndescription: Deploy helper v2\n---\n\nUpdated steps...',
      },
    },
    { action: 'delete', title: 'Delete a skill', params: { action: 'delete', name: 'my-deploy' } },
    { action: 'list', title: 'List all your skills', params: { action: 'list' } },
    {
      action: 'share',
      title: 'Return full SKILL.md for cross-user install',
      params: { action: 'share', name: 'my-deploy' },
    },
    {
      action: 'rename',
      title: 'Rename a skill (newName must differ, kebab-case)',
      params: { action: 'rename', name: 'my-deploy', newName: 'my-deploy-v2' },
    },
    {
      action: 'get',
      title: 'Read back your own skill content (self-fetch, no cap)',
      params: { action: 'get', name: 'my-deploy' },
    },
  ],
};

const UPDATE_SESSION_HELP: CommandHelp = {
  commandId: 'UPDATE_SESSION',
  summary:
    'Update session resources and/or title. Provide at least one of: operations (add/remove/set_active on ' +
    'issue/pr/doc), instructionOperations (user SSOT, y/n gated), or title.',
  examples: [
    {
      title: 'Link a PR and make it active',
      params: {
        operations: [{ action: 'add', resourceType: 'pr', link: { url: 'https://github.com/acme/repo/pull/1' } }],
      },
    },
    { title: 'Set the session title', params: { title: 'Fix model-command help' } },
    {
      title: 'Add a user instruction (queued for y/n confirmation)',
      params: { instructionOperations: [{ action: 'add', text: 'Always run tests before PR' }] },
    },
  ],
};

const CONTINUE_SESSION_HELP: CommandHelp = {
  commandId: 'CONTINUE_SESSION',
  summary:
    'Return a typed continuation so the host continues or re-dispatches the workflow. prompt is required. ' +
    'forceWorkflow requires resetSession=true.',
  examples: [
    { title: 'Continue with a follow-up prompt', params: { prompt: 'Now run the full test suite' } },
    {
      title: 'Reset and re-dispatch into a workflow',
      params: {
        prompt: 'new https://github.com/acme/repo/pull/1',
        resetSession: true,
        forceWorkflow: 'pr-review',
        dispatchText: 'https://github.com/acme/repo/pull/1',
      },
    },
  ],
};

const SAVE_CONTEXT_RESULT_HELP: CommandHelp = {
  commandId: 'SAVE_CONTEXT_RESULT',
  summary:
    'Store the save-result payload during a renew continuation (only available while renewState is pending_save). ' +
    'Wrap the payload under `result`.',
  examples: [
    {
      title: 'Report a successful save',
      params: { result: { success: true, id: 'save_123', summary: 'Saved 3 files' } },
    },
  ],
};

const ASK_USER_QUESTION_HELP: CommandHelp = {
  commandId: 'ASK_USER_QUESTION',
  summary:
    'Render a user-choice UI in Slack. params.payload.type must be "user_choice" or "user_choice_group". ' +
    'choices/options must be a non-empty array of { label, ... }.',
  examples: [
    {
      action: 'user_choice',
      title: 'Single question',
      params: {
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
    },
    {
      action: 'user_choice_group',
      title: 'Batched multiple questions',
      params: {
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
    },
  ],
};

// Issue #1082 T2: SET_GOAL self-correcting help.
const SET_GOAL_HELP: CommandHelp = {
  commandId: 'SET_GOAL',
  summary:
    'Set the session goal (set-only) — ONLY when the user explicitly asked for it in their CURRENT message. ' +
    'objective: 1..4000 Unicode code points (trimmed). userRequestEvidence: verbatim quote from the ' +
    "user's current message proving the explicit request — the host refuses when it is not an exact " +
    'substring of that message. The host evaluates goal completion and runs a capped auto-continuation ' +
    'loop; the model cannot mark the goal complete.',
  examples: [
    {
      title: 'Set a goal the user explicitly requested in their current message',
      params: {
        objective: 'ship the goal feature end to end',
        userRequestEvidence: 'goal로 설정해줘: ship the goal feature end to end',
      },
    },
  ],
};

const COMMAND_HELP: Partial<Record<ModelCommandId, CommandHelp>> = {
  SAVE_MEMORY: SAVE_MEMORY_HELP,
  MEMORY: MEMORY_HELP,
  MANAGE_SKILL: MANAGE_SKILL_HELP,
  UPDATE_SESSION: UPDATE_SESSION_HELP,
  CONTINUE_SESSION: CONTINUE_SESSION_HELP,
  SAVE_CONTEXT_RESULT: SAVE_CONTEXT_RESULT_HELP,
  ASK_USER_QUESTION: ASK_USER_QUESTION_HELP,
  SET_GOAL: SET_GOAL_HELP,
  // GET_SESSION / GET_MEMORY / RATE take no params — nothing to guide.
};

/**
 * Full help for a command, or `undefined` for no-arg commands (GET_SESSION,
 * GET_MEMORY, RATE) and the synthetic 'UNKNOWN' id.
 */
export function getCommandHelp(commandId: ModelCommandId): CommandHelp | undefined {
  return COMMAND_HELP[commandId];
}

/**
 * Attach `details.help` to an INVALID_ARGS error so the model can self-correct
 * on the first failure. No-ops (returns the error unchanged) when:
 *   - the error is not INVALID_ARGS (e.g. CONTEXT_ERROR — not a schema problem
 *     the model can fix by reading the schema), or
 *   - the command has no help (no-arg command / UNKNOWN).
 *
 * Existing `error.message` and any existing `error.details` are preserved; help
 * is merged in under the `help` key (object-shaped details) or alongside the
 * original value (non-object details lifted to `details.info`).
 */
export function attachCommandHelp(commandId: ModelCommandId | 'UNKNOWN', error: ModelCommandError): ModelCommandError {
  if (error.code !== 'INVALID_ARGS') {
    return error;
  }
  if (commandId === 'UNKNOWN') {
    return error;
  }
  const help = getCommandHelp(commandId);
  if (!help) {
    return error;
  }
  let details: Record<string, unknown>;
  if (isRecord(error.details)) {
    details = { ...error.details, help };
  } else if (error.details !== undefined) {
    details = { info: error.details, help };
  } else {
    details = { help };
  }
  return { ...error, details };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
