import { describe, expect, it } from 'vitest';
import {
  buildModelCommandListResponse,
  buildModelCommandRunResponse,
  parseModelCommandContext,
} from './model-command-mcp-server';
import { validateModelCommandRunArgs } from './model-commands/validator';

describe('model-command MCP server helpers', () => {
  it('returns safe defaults when SOMA_COMMAND_CONTEXT is invalid', () => {
    const context = parseModelCommandContext('not-json');
    expect(context.session?.issues).toEqual([]);
    expect(context.session?.prs).toEqual([]);
    expect(context.session?.docs).toEqual([]);
    expect(context.session?.sequence).toBe(0);
  });

  it('list exposes SAVE_CONTEXT_RESULT only during pending_save', () => {
    const withoutRenew = buildModelCommandListResponse({
      session: {
        issues: [],
        prs: [],
        docs: [],
        active: {},
        sequence: 0,
      },
      renewState: null,
    });
    const withRenew = buildModelCommandListResponse({
      session: {
        issues: [],
        prs: [],
        docs: [],
        active: {},
        sequence: 0,
      },
      renewState: 'pending_save',
    });

    expect(withoutRenew.commands.map((command) => command.id)).not.toContain('SAVE_CONTEXT_RESULT');
    expect(withRenew.commands.map((command) => command.id)).toContain('SAVE_CONTEXT_RESULT');
  });

  it('runs GET_SESSION and returns current snapshot', () => {
    const result = buildModelCommandRunResponse(
      { commandId: 'GET_SESSION' },
      {
        session: {
          issues: [{ url: 'https://jira.example/PTN-1', type: 'issue', provider: 'jira' }],
          prs: [],
          docs: [],
          active: {
            issue: { url: 'https://jira.example/PTN-1', type: 'issue', provider: 'jira' },
          },
          sequence: 3,
        },
      }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commandId).toBe('GET_SESSION');
    if (result.commandId !== 'GET_SESSION') return;
    expect(result.payload.session.sequence).toBe(3);
    expect(result.payload.session.issues).toHaveLength(1);
  });

  it('runs UPDATE_SESSION and enforces optimistic locking', () => {
    const mismatch = buildModelCommandRunResponse(
      {
        commandId: 'UPDATE_SESSION',
        params: {
          expectedSequence: 99,
          operations: [
            {
              action: 'add',
              resourceType: 'issue',
              link: {
                url: 'https://jira.example/PTN-2',
                type: 'issue',
                provider: 'jira',
              },
            },
          ],
        },
      },
      {
        session: {
          issues: [],
          prs: [],
          docs: [],
          active: {},
          sequence: 1,
        },
      }
    );

    expect(mismatch.ok).toBe(false);
    if (mismatch.ok) return;
    expect(mismatch.error.code).toBe('SEQUENCE_MISMATCH');
  });

  it('normalizes user_choice_group into ASK_USER_QUESTION payload', () => {
    const result = buildModelCommandRunResponse(
      {
        commandId: 'ASK_USER_QUESTION',
        params: {
          payload: {
            type: 'user_choice_group',
            question: 'Choose next step',
            choices: [
              {
                question: 'Which path?',
                options: [
                  { id: '1', label: 'A' },
                  { id: '2', label: 'B' },
                ],
              },
            ],
          },
        },
      },
      { session: { issues: [], prs: [], docs: [], active: {}, sequence: 0 } }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commandId).toBe('ASK_USER_QUESTION');
    if (result.commandId !== 'ASK_USER_QUESTION') return;
    expect(result.payload.question.type).toBe('user_choices');
  });

  it('returns structured error on invalid params', () => {
    const result = buildModelCommandRunResponse(
      {
        commandId: 'UPDATE_SESSION',
        params: { operations: [] },
      },
      { session: { issues: [], prs: [], docs: [], active: {}, sequence: 0 } }
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_ARGS');
  });

  it('rejects SAVE_CONTEXT_RESULT outside renew pending_save state', () => {
    const result = buildModelCommandRunResponse(
      {
        commandId: 'SAVE_CONTEXT_RESULT',
        params: {
          result: {
            success: true,
            id: 'save_1',
          },
        },
      },
      {
        renewState: null,
        session: {
          issues: [],
          prs: [],
          docs: [],
          active: {},
          sequence: 0,
        },
      }
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CONTEXT_ERROR');
  });

  it('keeps run state consistent across sequential calls with shared context', () => {
    const context = {
      renewState: null,
      session: {
        issues: [],
        prs: [],
        docs: [],
        active: {},
        sequence: 0,
      },
    };

    const update = buildModelCommandRunResponse(
      {
        commandId: 'UPDATE_SESSION',
        params: {
          operations: [
            {
              action: 'add',
              resourceType: 'issue',
              link: {
                url: 'https://jira.example/PTN-999',
                type: 'issue',
                provider: 'jira',
              },
            },
          ],
        },
      },
      context
    );

    expect(update.ok).toBe(true);

    const readBack = buildModelCommandRunResponse(
      {
        commandId: 'GET_SESSION',
      },
      context
    );

    expect(readBack.ok).toBe(true);
    if (!readBack.ok) return;
    expect(readBack.commandId).toBe('GET_SESSION');
    if (readBack.commandId !== 'GET_SESSION') return;
    expect(readBack.payload.session.sequence).toBe(1);
    expect(readBack.payload.session.issues).toHaveLength(1);
    expect(readBack.payload.session.issues[0]?.url).toBe('https://jira.example/PTN-999');
  });
});

describe('validateModelCommandRunArgs', () => {
  it('rejects unknown command id', () => {
    const result = validateModelCommandRunArgs({
      commandId: 'DO_NOT_EXIST',
      params: {},
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_COMMAND');
  });
});
