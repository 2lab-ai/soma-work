import { validateModelCommandRunArgs } from '@soma/process-shared/model-commands/validator.js';
import { describe, expect, it } from 'vitest';
import {
  buildModelCommandListResponse,
  buildModelCommandRunResponse,
  parseModelCommandContext,
  runModelCommandAwaitingHost,
} from './model-command-mcp-server';

describe('model-command MCP server helpers', () => {
  it('#855 — an old `surface: task` in SOMA_COMMAND_CONTEXT is ignored: every command a Slack thread has is offered', () => {
    const context = parseModelCommandContext(JSON.stringify({ user: 'U1', surface: 'task' }));
    expect(context).not.toHaveProperty('surface');
    const continued = buildModelCommandRunResponse(
      { commandId: 'CONTINUE_SESSION', params: { prompt: 'x', resetSession: true } },
      context,
    );
    expect(continued.ok).toBe(true);
    expect(buildModelCommandListResponse(context).commands.map((c) => c.id)).toContain('ASK_USER_QUESTION');
  });

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
    expect(withoutRenew.commands.map((command) => command.id)).toContain('CONTINUE_SESSION');
  });

  it('runs GET_SESSION and returns current snapshot', () => {
    const result = buildModelCommandRunResponse(
      { commandId: 'GET_SESSION' },
      {
        session: {
          issues: [{ url: 'https://jira.example/PROJ-1', type: 'issue', provider: 'jira' }],
          prs: [],
          docs: [],
          active: {
            issue: { url: 'https://jira.example/PROJ-1', type: 'issue', provider: 'jira' },
          },
          sequence: 3,
        },
      },
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
                url: 'https://jira.example/PROJ-2',
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
      },
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
                  { id: '3', label: 'C' },
                ],
              },
            ],
          },
        },
      },
      { session: { issues: [], prs: [], docs: [], active: {}, sequence: 0 } },
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
      { session: { issues: [], prs: [], docs: [], active: {}, sequence: 0 } },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_ARGS');
  });

  it('runs CONTINUE_SESSION and returns typed continuation payload', () => {
    const result = buildModelCommandRunResponse(
      {
        commandId: 'CONTINUE_SESSION',
        params: {
          prompt: 'new https://github.com/acme/repo/pull/1',
          resetSession: true,
          dispatchText: 'https://github.com/acme/repo/pull/1',
          forceWorkflow: 'pr-review',
        },
      },
      { session: { issues: [], prs: [], docs: [], active: {}, sequence: 0 } },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commandId).toBe('CONTINUE_SESSION');
    if (result.commandId !== 'CONTINUE_SESSION') return;
    expect(result.payload.continuation.prompt).toContain('github.com/acme/repo/pull/1');
    expect(result.payload.continuation.resetSession).toBe(true);
    expect(result.payload.continuation.forceWorkflow).toBe('pr-review');
  });

  it('rejects CONTINUE_SESSION forceWorkflow when resetSession is false', () => {
    const result = buildModelCommandRunResponse(
      {
        commandId: 'CONTINUE_SESSION',
        params: {
          prompt: 'new https://github.com/acme/repo/pull/1',
          resetSession: false,
          forceWorkflow: 'pr-review',
        },
      },
      { session: { issues: [], prs: [], docs: [], active: {}, sequence: 0 } },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_ARGS');
    expect(result.error.message).toContain('forceWorkflow');
  });

  it('returns detailed ASK_USER_QUESTION schema guidance on invalid payload', () => {
    const result = buildModelCommandRunResponse(
      {
        commandId: 'ASK_USER_QUESTION',
        params: {
          question: 'Choose next step',
          options: ['A', 'B'],
        },
      },
      { session: { issues: [], prs: [], docs: [], active: {}, sequence: 0 } },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_ARGS');
    expect(result.error.message).toContain('ASK_USER_QUESTION');
    expect(result.error.message).toContain('params.payload');
    expect(result.error.message).toContain('"type":"user_choice"');
    expect(result.error.message).toContain('user_choice');
    expect(result.error.message).toContain('user_choice_group');
    expect(result.error.message).toContain('"choices"');
    expect(result.error.message).toContain('"label"');
    expect(result.error.details).toMatchObject({
      requiredTopLevel: ['payload'],
      allowedPayloadTypes: ['user_choice', 'user_choice_group'],
    });
  });

  it('surfaces full SAVE_MEMORY help on a failed run (the production bug)', () => {
    // Reproduces the reported failure: the model called SAVE_MEMORY without an
    // action/target and got a terse one-liner it could not recover from. The
    // failed run must now carry every action + an example each in details.help.
    const result = buildModelCommandRunResponse(
      { commandId: 'SAVE_MEMORY', params: {} },
      { user: 'U1', session: { issues: [], prs: [], docs: [], active: {}, sequence: 0 } },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_ARGS');
    const help = (
      result.error.details as { help?: { commandId: string; actions?: string[]; examples: Array<{ action?: string }> } }
    ).help;
    expect(help).toBeDefined();
    expect(help?.commandId).toBe('SAVE_MEMORY');
    expect(help?.actions).toEqual(expect.arrayContaining(['add', 'replace', 'remove']));
    for (const action of ['add', 'replace', 'remove']) {
      expect(help?.examples.some((e) => e.action === action)).toBe(true);
    }
  });

  it('survives JSON round-trip with help attached (MCP stdio serialization)', () => {
    const result = buildModelCommandRunResponse(
      { commandId: 'MANAGE_SKILL', params: { action: 'bogus' } },
      { user: 'U1', session: { issues: [], prs: [], docs: [], active: {}, sequence: 0 } },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const roundTripped = JSON.parse(JSON.stringify(result)) as typeof result;
    if (roundTripped.ok) return;
    const help = (roundTripped.error.details as { help?: { commandId: string } }).help;
    expect(help?.commandId).toBe('MANAGE_SKILL');
  });

  it('rejects ASK_USER_QUESTION params.user_choice wrapper outside payload', () => {
    const result = buildModelCommandRunResponse(
      {
        commandId: 'ASK_USER_QUESTION',
        params: {
          user_choice: {
            question: 'Choose next step',
            options: [
              { id: '1', label: 'Write spec' },
              { id: '2', label: 'Start implementation' },
            ],
          },
        },
      },
      { session: { issues: [], prs: [], docs: [], active: {}, sequence: 0 } },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_ARGS');
    expect(result.error.message).toContain('params.payload');
  });

  it('auto-normalizes ASK_USER_QUESTION flat params (question/options without payload wrapper)', () => {
    const result = buildModelCommandRunResponse(
      {
        commandId: 'ASK_USER_QUESTION',
        params: {
          question: 'MIN-63 브레인스토밍 완료. 다음 단계로 무엇을 진행할까요?',
          options: [
            { label: 'Implementation Spec 작성 (권장)' },
            { label: '바로 구현 시작' },
            { label: '프로토타입 먼저' },
          ],
        },
      },
      { session: { issues: [], prs: [], docs: [], active: {}, sequence: 0 } },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commandId).toBe('ASK_USER_QUESTION');
    expect(result.payload.question).toBeDefined();
  });

  it('auto-normalizes ASK_USER_QUESTION flat params with choices key', () => {
    const result = buildModelCommandRunResponse(
      {
        commandId: 'ASK_USER_QUESTION',
        params: {
          question: '어떤 방식으로 진행할까요?',
          choices: [{ label: 'Option A' }, { label: 'Option B' }, { label: 'Option C' }],
        },
      },
      { session: { issues: [], prs: [], docs: [], active: {}, sequence: 0 } },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commandId).toBe('ASK_USER_QUESTION');
    expect(result.payload.question).toBeDefined();
  });

  it('auto-normalizes ASK_USER_QUESTION flat params with type user_choice_group', () => {
    const result = buildModelCommandRunResponse(
      {
        commandId: 'ASK_USER_QUESTION',
        params: {
          type: 'user_choice_group',
          question: '두 가지 결정이 필요합니다',
          choices: [
            {
              question: '첫 번째 결정',
              options: [
                { id: '1', label: 'A' },
                { id: '2', label: 'B' },
                { id: '3', label: 'C' },
              ],
            },
          ],
        },
      },
      { session: { issues: [], prs: [], docs: [], active: {}, sequence: 0 } },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commandId).toBe('ASK_USER_QUESTION');
    expect(result.payload.question).toBeDefined();
  });

  it('accepts ASK_USER_QUESTION when strict payload schema is satisfied', () => {
    const result = buildModelCommandRunResponse(
      {
        commandId: 'ASK_USER_QUESTION',
        params: {
          payload: {
            type: 'user_choice',
            question: 'MIN-63 브레인스토밍 완료. 다음 단계로 무엇을 진행할까요?',
            choices: [
              { id: '1', label: 'Implementation Spec 작성 (권장)' },
              { id: '2', label: '바로 구현 시작' },
              { id: '3', label: '프로토타입 먼저' },
            ],
          },
        },
      },
      { session: { issues: [], prs: [], docs: [], active: {}, sequence: 0 } },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commandId).toBe('ASK_USER_QUESTION');
    if (result.commandId !== 'ASK_USER_QUESTION') return;
    expect(result.payload.question.type).toBe('user_choice');
    if (result.payload.question.type !== 'user_choice') return;
    expect(result.payload.question.choices).toHaveLength(3);
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
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CONTEXT_ERROR');
  });

  it('accepts SAVE_CONTEXT_RESULT when payload is nested as params.result.save_result', () => {
    const result = buildModelCommandRunResponse(
      {
        commandId: 'SAVE_CONTEXT_RESULT',
        params: {
          result: {
            save_result: {
              success: true,
              id: 'save_nested',
              dir: '.claude/omc/tasks/save/save_nested',
            },
          },
        },
      },
      {
        renewState: 'pending_save',
        session: {
          issues: [],
          prs: [],
          docs: [],
          active: {},
          sequence: 0,
        },
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commandId).toBe('SAVE_CONTEXT_RESULT');
    if (result.commandId !== 'SAVE_CONTEXT_RESULT') return;
    expect(result.payload.saveResult.id).toBe('save_nested');
    expect(result.payload.saveResult.success).toBe(true);
  });

  it('accepts SAVE_CONTEXT_RESULT when result is provided at top-level without params', () => {
    const result = buildModelCommandRunResponse(
      {
        commandId: 'SAVE_CONTEXT_RESULT',
        result: {
          success: true,
          id: 'save_top_level',
          dir: '.claude/omc/tasks/save/save_top_level',
        },
      },
      {
        renewState: 'pending_save',
        session: {
          issues: [],
          prs: [],
          docs: [],
          active: {},
          sequence: 0,
        },
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commandId).toBe('SAVE_CONTEXT_RESULT');
    if (result.commandId !== 'SAVE_CONTEXT_RESULT') return;
    expect(result.payload.saveResult.id).toBe('save_top_level');
    expect(result.payload.saveResult.success).toBe(true);
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
                url: 'https://jira.example/PROJ-999',
                type: 'issue',
                provider: 'jira',
              },
            },
          ],
        },
      },
      context,
    );

    expect(update.ok).toBe(true);

    const readBack = buildModelCommandRunResponse(
      {
        commandId: 'GET_SESSION',
      },
      context,
    );

    expect(readBack.ok).toBe(true);
    if (!readBack.ok) return;
    expect(readBack.commandId).toBe('GET_SESSION');
    if (readBack.commandId !== 'GET_SESSION') return;
    expect(readBack.payload.session.sequence).toBe(1);
    expect(readBack.payload.session.issues).toHaveLength(1);
    expect(readBack.payload.session.issues[0]?.url).toBe('https://jira.example/PROJ-999');
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

  it('accepts CONTINUE_SESSION with resetSession and forceWorkflow', () => {
    const result = validateModelCommandRunArgs({
      commandId: 'CONTINUE_SESSION',
      params: {
        prompt: 'new fix https://github.com/acme/repo/pull/2',
        resetSession: true,
        dispatchText: 'fix https://github.com/acme/repo/pull/2',
        forceWorkflow: 'pr-fix-and-update',
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.commandId).toBe('CONTINUE_SESSION');
  });
});

/**
 * Issue #1082 T2 — SET_GOAL must be reachable through the MCP server process
 * boundary: listed when a user context exists, and runnable end-to-end via
 * `buildModelCommandRunResponse` (validator → catalog echo).
 */
describe('SET_GOAL — MCP server wire-up (#1082)', () => {
  const baseSession = { issues: [], prs: [], docs: [], active: {}, sequence: 0 };

  it('list exposes SET_GOAL when user context exists, hides it otherwise', () => {
    const withUser = buildModelCommandListResponse({ session: baseSession, user: 'U123' });
    const withoutUser = buildModelCommandListResponse({ session: baseSession });

    expect(withUser.commands.map((command) => command.id)).toContain('SET_GOAL');
    expect(withoutUser.commands.map((command) => command.id)).not.toContain('SET_GOAL');
  });

  it('run validates and echoes SET_GOAL params', () => {
    const result = buildModelCommandRunResponse(
      {
        commandId: 'SET_GOAL',
        params: { objective: 'ship the feature', userRequestEvidence: 'goal: ship the feature' },
      },
      { session: baseSession, user: 'U123' },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commandId).toBe('SET_GOAL');
    if (result.commandId !== 'SET_GOAL') return;
    expect(result.payload).toMatchObject({
      objective: 'ship the feature',
      userRequestEvidence: 'goal: ship the feature',
    });
  });

  it('run rejects malformed SET_GOAL params with INVALID_ARGS + help', () => {
    const result = buildModelCommandRunResponse(
      { commandId: 'SET_GOAL', params: { objective: '' } },
      { session: baseSession, user: 'U123' },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_ARGS');
    const help = (result.error.details as { help?: { commandId?: string } } | undefined)?.help;
    expect(help?.commandId).toBe('SET_GOAL');
  });
});

// #846 item 2 — the host-confirmed receipt: UPDATE_SESSION names its write, GET_SESSION reads back what the host
// applied (`host`) and says whether the host has handled the last write yet (`hostPending`).
describe('host-confirmed receipt', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-receipt-'));
  const file = path.join(dir, 'r.json');
  const ctx = () =>
    parseModelCommandContext(JSON.stringify({ channel: 'C1', threadTs: '1.1', user: 'U1', receiptFile: file }));
  const add = {
    commandId: 'UPDATE_SESSION',
    params: { operations: [{ action: 'add', resourceType: 'pr', link: { url: 'https://github.com/o/r/pull/9' } }] },
  };
  const hostReceipt = (receiptId: string | undefined, sequence: number) => ({
    sequence,
    session: {
      issues: [],
      prs: [{ url: 'https://github.com/o/r/pull/9', type: 'pr' }],
      docs: [],
      active: {},
      instructions: [],
      sequence,
    },
    tldr: ['a', '⚠️ **PR #9 open**', 'b'],
    followUp: 'PR #9 open',
    // What the host writes: the last write, and the same write in the per-write ledger.
    ...(receiptId
      ? {
          lastWrite: { receiptId, ok: true, tldrApplied: true, at: 1 },
          acks: { [receiptId]: { receiptId, ok: true, tldrApplied: true, at: 1 } },
        }
      : {}),
    at: 2,
  });

  it('reads the receipt file path from SOMA_COMMAND_CONTEXT', () => {
    expect(ctx().receiptFile).toBe(file);
    expect(parseModelCommandContext(JSON.stringify({ receiptFile: 3 })).receiptFile).toBeUndefined();
  });

  it('UPDATE_SESSION answers with a receiptId', () => {
    const c = ctx();
    const r = buildModelCommandRunResponse(add, c) as any;
    expect(r.ok).toBe(true);
    expect(r.payload.receiptId).toMatch(/^r_/);
    expect(c.lastReceiptId).toBe(r.payload.receiptId);
  });

  it('GET_SESSION: hostPending while the host has not handled the last write', () => {
    const c = ctx();
    const w = buildModelCommandRunResponse(add, c) as any;
    fs.writeFileSync(file, JSON.stringify(hostReceipt('r_older', 3)));
    const g = buildModelCommandRunResponse({ commandId: 'GET_SESSION' }, c) as any;
    expect(g.payload.host.sequence).toBe(3);
    expect(g.payload.hostPending).toBe(true);
    // Once the host wrote the receipt for this write, it is the truth: TL;DR, follow-up, sequence.
    fs.writeFileSync(file, JSON.stringify(hostReceipt(w.payload.receiptId, 7)));
    const g2 = buildModelCommandRunResponse({ commandId: 'GET_SESSION' }, c) as any;
    expect(g2.payload.hostPending).toBe(false);
    expect(g2.payload.host.followUp).toBe('PR #9 open');
    expect(g2.payload.host.lastWrite.ok).toBe(true);
    expect(g2.payload.session.sequence).toBe(7);
    // …and later writes use the host's sequence.
    expect(c.session?.sequence).toBe(7);
  });

  it('a receipt this server did not ask for is advisory: the spawned snapshot stays the lock (grok R1 P1)', () => {
    const c = parseModelCommandContext(
      JSON.stringify({
        channel: 'C1',
        threadTs: '1.1',
        user: 'U1',
        receiptFile: file,
        session: { issues: [], prs: [], docs: [], active: {}, instructions: [], sequence: 11 },
      }),
    );
    fs.writeFileSync(file, JSON.stringify(hostReceipt(undefined, 3)));
    const g = buildModelCommandRunResponse({ commandId: 'GET_SESSION' }, c) as any;
    expect(g.payload.host.sequence).toBe(3);
    expect(g.payload.hostPending).toBe(false);
    expect(g.payload.session.sequence).toBe(11);
    expect(c.session?.sequence).toBe(11);
    // A receipt for another server's write (a previous turn) is not this server's either.
    fs.writeFileSync(file, JSON.stringify(hostReceipt('r_from_another_turn', 3)));
    expect((buildModelCommandRunResponse({ commandId: 'GET_SESSION' }, c) as any).payload.session.sequence).toBe(11);
  });

  it('per-write acks (astra R1 P1): two servers, both writes handled — each sees its own; a late ack keeps the other', () => {
    const ctxOf = () =>
      parseModelCommandContext(JSON.stringify({ channel: 'C1', threadTs: '1.1', user: 'U1', receiptFile: file }));
    const a = ctxOf();
    const b = ctxOf();
    const wa = buildModelCommandRunResponse(add, a) as any;
    const wb = buildModelCommandRunResponse(add, b) as any;
    expect(wa.payload.receiptId).not.toBe(wb.payload.receiptId);
    const ack = (receiptId: string, ok: boolean) => ({ receiptId, ok, at: 1 });
    // The host handled B's write last; A's ack is still in the ledger.
    fs.writeFileSync(
      file,
      JSON.stringify({
        ...hostReceipt(wb.payload.receiptId, 8),
        acks: {
          [wa.payload.receiptId]: ack(wa.payload.receiptId, true),
          [wb.payload.receiptId]: ack(wb.payload.receiptId, false),
        },
      }),
    );
    const ga = buildModelCommandRunResponse({ commandId: 'GET_SESSION' }, a) as any;
    expect(ga.payload.hostPending).toBe(false);
    expect(ga.payload.host.lastWrite).toMatchObject({ receiptId: wa.payload.receiptId, ok: true });
    const gb = buildModelCommandRunResponse({ commandId: 'GET_SESSION' }, b) as any;
    expect(gb.payload.hostPending).toBe(false);
    expect(gb.payload.host.lastWrite).toMatchObject({ receiptId: wb.payload.receiptId, ok: false });
  });

  it('before this server writes, `host.lastWrite` is absent — a previous turn’s write is not yours (fable R3 P3)', () => {
    const c = ctx();
    fs.writeFileSync(file, JSON.stringify(hostReceipt('r_from_another_turn', 3)));
    const g = buildModelCommandRunResponse({ commandId: 'GET_SESSION' }, c) as any;
    expect(g.payload.host.sequence).toBe(3);
    expect(g.payload.host).not.toHaveProperty('lastWrite');
    expect(g.payload.hostPending).toBe(false);
  });

  it('a receipt with a corrupt link never breaks GET_SESSION (astra R3 P2)', () => {
    const c = ctx();
    const w = buildModelCommandRunResponse(add, c) as any;
    const r = hostReceipt(w.payload.receiptId, 9);
    fs.writeFileSync(file, JSON.stringify({ ...r, session: { ...r.session, prs: [null] } }));
    const g = buildModelCommandRunResponse({ commandId: 'GET_SESSION' }, c) as any;
    expect(g.ok).toBe(true);
    expect(g.payload.host).toBeUndefined();
    expect(c.session?.sequence).not.toBe(9);
  });

  it('no receipt file (or none yet): GET_SESSION is the server copy as before', () => {
    const c = parseModelCommandContext(JSON.stringify({ channel: 'C1', threadTs: '1.1', user: 'U1' }));
    const g = buildModelCommandRunResponse({ commandId: 'GET_SESSION' }, c) as any;
    expect(g.ok).toBe(true);
    expect(g.payload.host).toBeUndefined();
    expect(g.payload.hostPending).toBeUndefined();
    const missing = parseModelCommandContext(
      JSON.stringify({ channel: 'C1', user: 'U1', receiptFile: path.join(dir, 'none.json') }),
    );
    expect((buildModelCommandRunResponse({ commandId: 'GET_SESSION' }, missing) as any).payload.host).toBeUndefined();
  });
});

// #881 A — GET_SESSION { waitForAckMs } waits for the host's ack of this server's own last write.
describe('GET_SESSION waits for the host ack', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-wait-'));
  let n = 0;
  const setup = () => {
    const file = path.join(dir, `r${++n}.json`);
    const c = parseModelCommandContext(
      JSON.stringify({ channel: 'C1', threadTs: '1.1', user: 'U1', receiptFile: file }),
    );
    return { file, c };
  };
  const add = {
    commandId: 'UPDATE_SESSION',
    params: { operations: [{ action: 'add', resourceType: 'pr', link: { url: 'https://github.com/o/r/pull/9' } }] },
  };
  const receipt = (sequence: number, ackId?: string) => ({
    sequence,
    session: {
      issues: [],
      prs: [{ url: 'https://github.com/o/r/pull/9', type: 'pr' }],
      docs: [],
      active: {},
      instructions: [],
      sequence,
    },
    ...(ackId ? { acks: { [ackId]: { receiptId: ackId, ok: true, at: 5 } } } : {}),
    at: 1,
  });
  // A fake clock: each sleep advances time; `onSleep` lets the test play the host.
  const clock = (onSleep?: (t: number) => void) => {
    let t = 0;
    return {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
        onSleep?.(t);
      },
    };
  };

  it('waits until the host acks this server’s write, then answers caught up', async () => {
    const { file, c } = setup();
    const w = buildModelCommandRunResponse(add, c) as any;
    fs.writeFileSync(file, JSON.stringify(receipt(3)));
    const k = clock((t) => {
      if (t >= 2_000) fs.writeFileSync(file, JSON.stringify(receipt(4, w.payload.receiptId)));
    });
    const g = (await runModelCommandAwaitingHost(
      { commandId: 'GET_SESSION', params: { waitForAckMs: 30_000 } },
      c,
      k,
    )) as any;
    expect(g.ok).toBe(true);
    expect(g.payload.hostPending).toBe(false);
    expect(g.payload.host.lastWrite.receiptId).toBe(w.payload.receiptId);
    expect(g.payload.hostWaitedMs).toBe(2_000);
    expect(c.session?.sequence).toBe(4);
  });

  it('gives up at the bound: still pending, and says how long it waited', async () => {
    const { file, c } = setup();
    buildModelCommandRunResponse(add, c);
    fs.writeFileSync(file, JSON.stringify(receipt(3)));
    const k = clock();
    const g = (await runModelCommandAwaitingHost(
      { commandId: 'GET_SESSION', params: { waitForAckMs: 3_000 } },
      c,
      k,
    )) as any;
    expect(g.payload.hostPending).toBe(true);
    expect(g.payload.hostWaitedMs).toBe(3_000);
  });

  it('does not wait when there is nothing of its own to wait for, or no wait was asked', async () => {
    const { file, c } = setup();
    fs.writeFileSync(file, JSON.stringify(receipt(3)));
    const k = clock();
    const noWrite = (await runModelCommandAwaitingHost(
      { commandId: 'GET_SESSION', params: { waitForAckMs: 30_000 } },
      c,
      k,
    )) as any;
    expect(noWrite.payload.hostWaitedMs).toBeUndefined();
    expect(k.now()).toBe(0);
    buildModelCommandRunResponse(add, c);
    const noAsk = (await runModelCommandAwaitingHost({ commandId: 'GET_SESSION' }, c, k)) as any;
    expect(noAsk.payload.hostPending).toBe(true);
    expect(noAsk.payload.hostWaitedMs).toBeUndefined();
    expect(k.now()).toBe(0);
  });

  it('no receipt file on disk (the host could not write it): answers at once (fable R1 P2)', async () => {
    const { c } = setup();
    buildModelCommandRunResponse(add, c);
    const k = clock();
    const g = (await runModelCommandAwaitingHost(
      { commandId: 'GET_SESSION', params: { waitForAckMs: 30_000 } },
      c,
      k,
    )) as any;
    expect(k.now()).toBe(0);
    expect(g.payload.host).toBeUndefined();
    expect(g.payload.hostWaitedMs).toBe(0);
  });

  it('a write made while it waits moves the wait; the answer is about that same write (astra R2 P2)', async () => {
    const { file, c } = setup();
    const first = buildModelCommandRunResponse(add, c) as any;
    fs.writeFileSync(file, JSON.stringify(receipt(3)));
    let second: any;
    const k = clock((t) => {
      if (t === 500) second = buildModelCommandRunResponse(add, c);
      // The host acks the first write, then (later) the second.
      if (t === 1_000) fs.writeFileSync(file, JSON.stringify(receipt(4, first.payload.receiptId)));
      if (t >= 2_000) {
        const r = receipt(5, second.payload.receiptId);
        fs.writeFileSync(
          file,
          JSON.stringify({
            ...r,
            acks: { ...r.acks, [first.payload.receiptId]: { receiptId: first.payload.receiptId, ok: true, at: 4 } },
          }),
        );
      }
    });
    const g = (await runModelCommandAwaitingHost(
      { commandId: 'GET_SESSION', params: { waitForAckMs: 30_000 } },
      c,
      k,
    )) as any;
    expect(g.payload.hostWaitedMs).toBe(2_000);
    expect(g.payload.hostPending).toBe(false);
    expect(g.payload.host.lastWrite.receiptId).toBe(second.payload.receiptId);
    expect(c.session?.sequence).toBe(5);
  });

  it('other commands run as before', async () => {
    const { c } = setup();
    const r = (await runModelCommandAwaitingHost(add, c, clock())) as any;
    expect(r.ok).toBe(true);
    expect(r.payload.receiptId).toMatch(/^r_/);
  });
});
