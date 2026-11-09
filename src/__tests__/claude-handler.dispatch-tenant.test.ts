/**
 * llmux tenant keys on one-shot side calls: a `dispatchOneShot` made for a
 * Slack user (workflow classification, goal eval, guardian, executive summary)
 * carries that user's own llmux key, so llmux meters it under their tenant —
 * not the shared key (tenant `local`). Production evidence: a haiku workflow
 * classification for a user's PR link arrived at llmux as tenant `local`.
 *
 * No user → `ensureTenantKey` is never asked and the env is the shared key, as
 * before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { leaseMock, tenantMock, buildQueryEnvMock, queryMock } = vi.hoisted(() => ({
  leaseMock: vi.fn(async () => ({
    keyId: 'slot-1',
    heartbeat: async () => {},
    release: async () => {},
  })),
  tenantMock: vi.fn(async (_user: string, _profile?: unknown) => ({
    secret: 'lmk-dan',
    baseUrl: 'http://127.0.0.1:3456',
  })),
  buildQueryEnvMock: vi.fn((_lease: unknown, _opts?: unknown) => ({ env: { ANTHROPIC_API_KEY: 'x' } })),
  queryMock: vi.fn(),
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
vi.mock('../auth/query-env-builder', () => ({ buildQueryEnv: buildQueryEnvMock }));

import { ClaudeHandler } from '../claude-handler';
import type { McpManager } from '../mcp-manager';

function newHandler(): ClaudeHandler {
  return new ClaudeHandler({ getPluginManager: () => null } as unknown as McpManager);
}

/** The SDK answers one assistant text turn. */
function answer(text: string): void {
  queryMock.mockImplementation(() =>
    (async function* () {
      yield { type: 'assistant', message: { content: [{ type: 'text', text }] } };
    })(),
  );
}

describe('ClaudeHandler.dispatchOneShot — llmux tenant key', () => {
  beforeEach(() => {
    leaseMock.mockClear();
    tenantMock.mockClear();
    buildQueryEnvMock.mockClear();
    queryMock.mockReset();
    answer('{"workflow":"pr-review","title":"x"}');
  });

  it("a dispatch made for a user builds its env with that user's llmux key", async () => {
    const out = await newHandler().dispatchOneShot(
      'https://github.com/acme/repo/pull/1',
      'classify',
      'claude-haiku-4-5-20251001',
      undefined,
      undefined,
      undefined,
      undefined,
      { tenantUserId: 'U_DAN' },
    );

    expect(out).toContain('pr-review');
    expect(tenantMock).toHaveBeenCalledTimes(1);
    expect(tenantMock).toHaveBeenCalledWith('U_DAN', expect.any(Object));
    expect(buildQueryEnvMock).toHaveBeenCalledTimes(1);
    expect(buildQueryEnvMock.mock.calls[0][1]).toEqual({
      llmuxTenant: { secret: 'lmk-dan', baseUrl: 'http://127.0.0.1:3456' },
    });
  });

  it('a dispatch with no user stays on the shared key and never asks for a tenant key', async () => {
    await newHandler().dispatchOneShot('hello', 'classify', 'claude-haiku-4-5-20251001');

    expect(tenantMock).not.toHaveBeenCalled();
    expect(buildQueryEnvMock).toHaveBeenCalledTimes(1);
    expect(buildQueryEnvMock.mock.calls[0][1]).toEqual({ llmuxTenant: null });
  });

  it('issuance unavailable (ensureTenantKey → null) falls back to the shared key', async () => {
    tenantMock.mockResolvedValueOnce(null as never);

    await newHandler().dispatchOneShot('hello', 'classify', undefined, undefined, undefined, undefined, undefined, {
      tenantUserId: 'U_DAN',
    });

    expect(tenantMock).toHaveBeenCalledWith('U_DAN', expect.any(Object));
    expect(buildQueryEnvMock.mock.calls[0][1]).toEqual({ llmuxTenant: null });
  });

  it('the guardian (safety classifier) dispatch carries the session user', async () => {
    answer('{"verdict":"ask","reason":"host-wide"}');
    const classifier = (
      newHandler() as unknown as {
        getSafetyClassifier(): import('../agent-runtime/policy/safety-classifier').SafetyClassifier;
      }
    ).getSafetyClassifier();

    const verdict = await classifier.classify({
      toolName: 'Bash',
      command: 'rm -rf /tmp/U_DAN/build',
      toolInput: { command: 'rm -rf /tmp/U_DAN/build' },
      matchedRuleIds: ['rm-recursive'],
      user: 'U_DAN',
    });

    expect(verdict.verdict).toBe('ask');
    expect(tenantMock).toHaveBeenCalledWith('U_DAN', expect.any(Object));
    expect(buildQueryEnvMock.mock.calls[0][1]).toEqual({
      llmuxTenant: { secret: 'lmk-dan', baseUrl: 'http://127.0.0.1:3456' },
    });
  });
});
