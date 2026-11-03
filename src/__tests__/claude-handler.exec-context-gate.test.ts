/**
 * The turn gate (#597, .prd/17 D2, T6): `ClaudeHandler.streamQuery` runs a turn
 * only under a context the server vouches for — the Slack event's user. Without
 * one the turn is refused before a credential slot is leased or the SDK is
 * called; it never falls back to the old "no Slack context → bypass, no policy
 * hook" options. (#855 — the Slack-less task's context is gone.)
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

import { ExecutionContextMissingError } from '../agent-runtime/execution-context';
import { ClaudeHandler } from '../claude-handler';
import type { SlackContext } from '../mcp-config-builder';
import type { McpManager } from '../mcp-manager';

function newHandler(): ClaudeHandler {
  return new ClaudeHandler({ getPluginManager: () => null } as unknown as McpManager);
}

describe('ClaudeHandler.streamQuery — the execution-context gate (#597)', () => {
  beforeEach(() => {
    queryMock.mockReset();
    leaseMock.mockClear();
    buildOptionsMock.mockClear();
    tenantMock.mockClear();
  });

  it('T6 — no Slack user: refused before a slot lease, options or the SDK', async () => {
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
});
