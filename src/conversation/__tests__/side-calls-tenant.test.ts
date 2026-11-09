/**
 * llmux tenant keys on the conversation side calls: a title / summary call
 * made for a user's session carries that user's own llmux key, so llmux meters
 * it under their tenant instead of the shared key (tenant `local`). No user →
 * the shared key, and `ensureTenantKey` is never asked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config', () => ({
  config: { conversation: { summaryModel: 'claude-haiku-4-5' } },
}));

vi.mock('../../credentials-manager', () => {
  class FakeNoHealthySlotError extends Error {}
  const lease = {
    slotId: 'test-slot',
    accessToken: 'test-access-token',
    kind: 'setup_token' as const,
    release: vi.fn(async () => {}),
    heartbeat: vi.fn(async () => {}),
  };
  return { ensureActiveSlotAuth: vi.fn(async () => lease), NoHealthySlotError: FakeNoHealthySlotError };
});

vi.mock('../../token-manager', () => ({ getTokenManager: vi.fn(() => ({})) }));

const { queryMock, tenantMock, buildQueryEnvMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  tenantMock: vi.fn(async (user: string, _profile?: unknown) => ({ secret: `lmk-${user}`, baseUrl: 'http://llmux' })),
  buildQueryEnvMock: vi.fn((_lease: unknown, _opts?: unknown) => ({ env: { FAKE: '1' } })),
}));

vi.mock('../../auth/llmux-tenant-keys', () => ({ ensureTenantKey: tenantMock }));
vi.mock('../../auth/query-env-builder', () => ({ buildQueryEnv: buildQueryEnvMock }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));
vi.mock('../../prompt/user-instructions-block', () => ({
  computeCompletedUpstreamHash: vi.fn(() => 'fake-hash'),
}));

import type { ConversationSession, SessionInstruction } from '../../types';
import { regenerateInstructionsSummaryIfStale, summarizeCompletedInstructions } from '../instructions-summarizer';
import { summarizeIssueAndPrTitles } from '../link-derived-title';
import { generateSessionSummaryTitle, summarizeResponse } from '../summarizer';
import { generateTitle } from '../title-generator';

/** Every query answers with this text. */
function answer(text: string): void {
  queryMock.mockImplementation(() =>
    (async function* () {
      yield { type: 'assistant', message: { content: [{ type: 'text', text }] } };
    })(),
  );
}

/** The `llmuxTenant` each `buildQueryEnv` call got, in call order. */
function tenantsBuilt(): unknown[] {
  return buildQueryEnvMock.mock.calls.map((c) => (c[1] as { llmuxTenant?: unknown } | undefined)?.llmuxTenant);
}

const DAN_KEY = { secret: 'lmk-U_DAN', baseUrl: 'http://llmux' };

const COMPLETED: SessionInstruction[] = [
  { id: 'i1', text: 'fix the login bug', status: 'completed' },
  { id: 'i2', text: 'add a test', status: 'completed' },
] as unknown as SessionInstruction[];

beforeEach(() => {
  queryMock.mockReset();
  tenantMock.mockClear();
  buildQueryEnvMock.mockClear();
  answer('{"title":"Fix the login bug in prod","body":"a\\nb\\nc"}');
});

describe('summarizeResponse (per-turn summary)', () => {
  it("carries the tenant user's llmux key", async () => {
    await summarizeResponse('long assistant response', { tenantUserId: 'U_DAN' });
    expect(tenantMock).toHaveBeenCalledWith('U_DAN', expect.any(Object));
    expect(tenantsBuilt()).toEqual([DAN_KEY]);
  });

  it('no user → the shared key, no tenant lookup', async () => {
    await summarizeResponse('long assistant response');
    expect(tenantMock).not.toHaveBeenCalled();
    expect(tenantsBuilt()).toEqual([null]);
  });
});

describe('generateSessionSummaryTitle (session title)', () => {
  it('both the Haiku try and the Sonnet fallback carry the same tenant key, resolved once', async () => {
    answer('{"title":"..."}'); // fails the quality gate → Sonnet fallback runs too
    await generateSessionSummaryTitle(['fix login'], undefined, { tenantUserId: 'U_DAN' });
    expect(tenantMock).toHaveBeenCalledTimes(1);
    expect(tenantsBuilt()).toEqual([DAN_KEY, DAN_KEY]);
  });

  it('summarizeIssueAndPrTitles forwards the session user', async () => {
    await summarizeIssueAndPrTitles('Login fails', 'Fix login', 'U_DAN');
    expect(tenantMock).toHaveBeenCalledWith('U_DAN', expect.any(Object));
    expect(tenantsBuilt()[0]).toEqual(DAN_KEY);
  });
});

describe('generateTitle (dashboard subtitle)', () => {
  it("carries the conversation owner's key", async () => {
    answer('로그인 버그 수정');
    await generateTitle('[user]: fix login', { tenantUserId: 'U_DAN' });
    expect(tenantsBuilt()).toEqual([DAN_KEY]);
  });

  it('no user → the shared key', async () => {
    answer('로그인 버그 수정');
    await generateTitle('[user]: fix login');
    expect(tenantMock).not.toHaveBeenCalled();
    expect(tenantsBuilt()).toEqual([null]);
  });
});

describe('instructions summarizer', () => {
  it('summarizeCompletedInstructions carries the tenant key', async () => {
    answer('fixed the login bug, added a test');
    await summarizeCompletedInstructions(COMPLETED, { tenantUserId: 'U_DAN' });
    expect(tenantsBuilt()).toEqual([DAN_KEY]);
  });

  it("regenerateInstructionsSummaryIfStale uses the session's initiator, else its owner", async () => {
    answer('fixed the login bug, added a test');
    const withInitiator = {
      instructions: COMPLETED,
      currentInitiatorId: 'U_DAN',
      ownerId: 'U_OWNER',
      userId: 'U_OWNER',
    } as unknown as ConversationSession;
    const ownerOnly = {
      instructions: COMPLETED,
      ownerId: 'U_OWNER',
      userId: 'U_OWNER',
    } as unknown as ConversationSession;

    await regenerateInstructionsSummaryIfStale(withInitiator);
    await regenerateInstructionsSummaryIfStale(ownerOnly);

    expect(tenantMock.mock.calls.map((c) => c[0])).toEqual(['U_DAN', 'U_OWNER']);
  });
});
