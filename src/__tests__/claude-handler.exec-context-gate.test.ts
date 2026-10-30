/**
 * The turn gate (#597, .prd/17 D2, T6): `ClaudeHandler.streamQuery` runs a turn
 * only under a context the server vouches for — the Slack event's user, or a
 * Slack-less task's execution context. Without one the turn is refused before
 * a credential slot is leased or the SDK is called; it never falls back to the
 * old "no Slack context → bypass, no policy hook" options.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock, leaseMock, buildOptionsMock, tenantMock } = vi.hoisted(() => ({
  tenantMock: vi.fn(async (_user: string, _profile?: unknown) => null),
  queryMock: vi.fn(),
  leaseMock: vi.fn(async () => ({ heartbeat: async () => {}, release: async () => {} })),
  buildOptionsMock: vi.fn(async () => {
    throw new Error('options-built'); // the gate passed: stop here, before the SDK
  }),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));
vi.mock('../credentials-manager', () => ({
  ensureActiveSlotAuth: leaseMock,
  getCredentialStatus: () => ({}),
  NoHealthySlotError: class NoHealthySlotError extends Error {},
}));
vi.mock('../credential-alert', () => ({ sendCredentialAlert: vi.fn(async () => {}) }));
vi.mock('../token-manager', () => ({ getTokenManager: () => ({}) }));
vi.mock('../auth/llmux-tenant-keys', () => ({ ensureTenantKey: tenantMock }));
vi.mock('../auth/query-env-builder', () => ({ buildQueryEnv: () => ({ env: {} }) }));
vi.mock('../agent-runtime/claude-code/build-stream-options', () => ({ buildStreamOptions: buildOptionsMock }));

import {
  type ExecutionContext,
  ExecutionContextMissingError,
  executionContextForTask,
} from '../agent-runtime/execution-context';
import { ClaudeHandler } from '../claude-handler';
import type { SlackContext } from '../mcp-config-builder';
import type { McpManager } from '../mcp-manager';
import type { ConversationSession } from '../types';

function newHandler(): ClaudeHandler {
  return new ClaudeHandler({ getPluginManager: () => null } as unknown as McpManager);
}

const taskContext: ExecutionContext = executionContextForTask({
  ownerId: 'U1',
  slackless: true,
  taskId: '11111111-2222-4333-8444-555555555555',
  channelId: '',
  workingDirectory: '/tmp/U1/session_x',
} as ConversationSession);

describe('ClaudeHandler.streamQuery — the execution-context gate (#597)', () => {
  beforeEach(() => {
    queryMock.mockReset();
    leaseMock.mockClear();
    buildOptionsMock.mockClear();
    tenantMock.mockClear();
  });

  it('T6 — no Slack user and no task context: refused before a slot lease, options or the SDK', async () => {
    const it = newHandler().streamQuery('hi', undefined, undefined, '/tmp/x', undefined, 'task:x');
    await expect(it.next()).rejects.toBeInstanceOf(ExecutionContextMissingError);
    expect(leaseMock).not.toHaveBeenCalled();
    expect(buildOptionsMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('T6 — a Slack context with an empty user is no context', async () => {
    const slack = { user: '', channel: 'C1', threadTs: '1.1' } as SlackContext;
    const it = newHandler().streamQuery('hi', undefined, undefined, '/tmp/x', slack, 'work:C1:1.1');
    await expect(it.next()).rejects.toBeInstanceOf(ExecutionContextMissingError);
    expect(leaseMock).not.toHaveBeenCalled();
  });

  it('a Slack turn passes the gate as before', async () => {
    const slack = { user: 'U1', channel: 'C1', threadTs: '1.1' } as SlackContext;
    const it = newHandler().streamQuery('hi', undefined, undefined, '/tmp/x', slack, 'work:C1:1.1');
    await expect(it.next()).rejects.toThrow('options-built');
  });

  it('a Slack-less task passes the gate, and its context reaches the option builder', async () => {
    const it = newHandler().streamQuery(
      'hi',
      undefined,
      undefined,
      taskContext.workingDirectory,
      undefined,
      taskContext.sessionKey,
      taskContext,
    );
    await expect(it.next()).rejects.toThrow('options-built');
    expect(buildOptionsMock).toHaveBeenCalledTimes(1);
    expect((buildOptionsMock.mock.calls[0] as unknown[])[0]).toMatchObject({ executionContext: taskContext });
  });

  describe('a task context is bound to the session it runs (#613 R2)', () => {
    const taskSession = (over: Record<string, unknown> = {}) =>
      ({
        ownerId: 'U1',
        userId: 'U1',
        slackless: true,
        taskId: taskContext.taskId,
        channelId: '',
        ...over,
      }) as unknown as ConversationSession;
    const run = (session: ConversationSession | undefined, sessionKey: string, slack?: SlackContext) =>
      newHandler().streamQuery('hi', session, undefined, undefined, slack, sessionKey, taskContext);

    it('a different session key is refused before a lease', async () => {
      await expect(run(taskSession(), 'task:22222222-2222-4222-8222-222222222222').next()).rejects.toBeInstanceOf(
        ExecutionContextMissingError,
      );
      expect(leaseMock).not.toHaveBeenCalled();
    });

    it('another task’s session is refused', async () => {
      const other = taskSession({ taskId: '22222222-2222-4222-8222-222222222222' });
      await expect(run(other, taskContext.sessionKey).next()).rejects.toBeInstanceOf(ExecutionContextMissingError);
      expect(leaseMock).not.toHaveBeenCalled();
    });

    it('a session owned by someone else is refused', async () => {
      await expect(run(taskSession({ ownerId: 'U2' }), taskContext.sessionKey).next()).rejects.toBeInstanceOf(
        ExecutionContextMissingError,
      );
    });

    it('a Slack context alongside a task context is refused — a task turn has no Slack thread', async () => {
      const slack = { user: 'U1', channel: 'C1', threadTs: '1.1' } as SlackContext;
      await expect(run(taskSession(), taskContext.sessionKey, slack).next()).rejects.toBeInstanceOf(
        ExecutionContextMissingError,
      );
    });

    it('the matching session passes, and the usage tenant is the task’s user', async () => {
      const session = taskSession({ currentInitiatorId: 'U9' });
      await expect(run(session, taskContext.sessionKey).next()).rejects.toThrow('options-built');
      expect(tenantMock.mock.calls[0][0]).toBe('U1');
    });
  });
});
