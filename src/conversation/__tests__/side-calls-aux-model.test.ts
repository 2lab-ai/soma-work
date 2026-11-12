/**
 * The model each conversation side call runs on (agent-runtime/aux-model.ts).
 *
 * Every side call names a tier and follows the MAIN model's provider — the
 * session's model when the call is made for a session, else the user's default
 * model: Claude → `haiku` / `sonnet`, Codex → `luna` / `terra`, Grok → `grok` at
 * effort low / medium. Aliases resolve through the alias table at call time.
 * SUMMARY_MODEL (operator) still overrides the summary-class calls as-is.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { configMock, queryMock } = vi.hoisted(() => ({
  configMock: { conversation: { summaryModel: undefined as string | undefined } },
  queryMock: vi.fn(),
}));

vi.mock('../../config', () => ({ config: configMock }));
vi.mock('../../credentials-manager', () => {
  class FakeNoHealthySlotError extends Error {}
  const lease = { slotId: 's', accessToken: 't', kind: 'setup_token' as const, release: vi.fn(async () => {}) };
  return { ensureActiveSlotAuth: vi.fn(async () => lease), NoHealthySlotError: FakeNoHealthySlotError };
});
vi.mock('../../token-manager', () => ({ getTokenManager: vi.fn(() => ({})) }));
vi.mock('../../auth/llmux-tenant-keys', () => ({ ensureTenantKey: vi.fn(async () => null) }));
vi.mock('../../auth/query-env-builder', () => ({ buildQueryEnv: vi.fn(() => ({ env: { FAKE: '1' } })) }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));
vi.mock('../../prompt/user-instructions-block', () => ({ computeCompletedUpstreamHash: vi.fn(() => 'fake-hash') }));

import { improveEntry } from '../../slack/z/topics/memory-improve';
import type { ConversationSession, SessionInstruction } from '../../types';
import { MODEL_ALIASES, userSettingsStore } from '../../user-settings-store';
import { regenerateInstructionsSummaryIfStale, summarizeCompletedInstructions } from '../instructions-summarizer';
import { summarizeIssueAndPrTitles } from '../link-derived-title';
import { generateSessionSummaryTitle, summarizeResponse } from '../summarizer';
import { generateTitle } from '../title-generator';

/** Every query answers `text` (one per call, the last one repeating). */
function answers(...texts: string[]): void {
  let i = 0;
  queryMock.mockImplementation(() => {
    const text = texts[Math.min(i++, texts.length - 1)];
    return (async function* () {
      yield { type: 'assistant', message: { content: [{ type: 'text', text }] } };
    })();
  });
}

/** [model, effort] of every SDK query, in call order. */
function sent(): Array<[string | undefined, string | undefined]> {
  return queryMock.mock.calls.map((c) => {
    const o = (c[0] as { options: { model?: string; effort?: string } }).options;
    return [o.model, o.effort];
  });
}

const GROK = /^grok-/;
const COMPLETED = [
  { id: 'i1', text: 'fix the login bug', status: 'completed' },
  { id: 'i2', text: 'add a test', status: 'completed' },
] as unknown as SessionInstruction[];

beforeEach(() => {
  queryMock.mockReset();
  configMock.conversation.summaryModel = undefined;
  answers('{"title":"Fix the login bug in prod","body":"a\\nb\\nc"}');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('summarizeResponse / generateTitle — the sonnet tier', () => {
  it("the session's model picks the provider", async () => {
    await summarizeResponse('long response', { mainModel: 'claude-opus-5-5[1m]' });
    await summarizeResponse('long response', { mainModel: 'gpt-6.1-sol[1m]' });
    await generateTitle('a conversation', { mainModel: 'gpt-6.1-sol[1m]' });
    expect(sent()).toEqual([
      [MODEL_ALIASES.sonnet, undefined],
      [MODEL_ALIASES.terra, undefined],
      [MODEL_ALIASES.terra, undefined],
    ]);
  });

  it("no session model → the user's default model", async () => {
    const defaults = vi.spyOn(userSettingsStore, 'getUserDefaultModel').mockReturnValue('gpt-6.1-sol[1m]');
    await summarizeResponse('long response', { tenantUserId: 'U_DAN' });
    await generateTitle('a conversation', { tenantUserId: 'U_DAN' });
    expect(defaults).toHaveBeenCalledWith('U_DAN');
    expect(sent()).toEqual([
      [MODEL_ALIASES.terra, undefined],
      [MODEL_ALIASES.terra, undefined],
    ]);
  });

  it('a Grok main model runs grok at effort medium', async () => {
    await summarizeResponse('long response', { mainModel: 'grok-4.7' });
    const [[model, effort]] = sent();
    expect(model).toMatch(GROK);
    expect(effort).toBe('medium');
  });

  it('SUMMARY_MODEL wins as-is', async () => {
    configMock.conversation.summaryModel = 'claude-sonnet-4-6';
    await summarizeResponse('long response', { mainModel: 'grok-4.7' });
    await generateTitle('a conversation', { mainModel: 'gpt-6.1-sol[1m]' });
    expect(sent()).toEqual([
      ['claude-sonnet-4-6', undefined],
      ['claude-sonnet-4-6', undefined],
    ]);
  });
});

describe('generateSessionSummaryTitle — haiku tier, then sonnet tier', () => {
  it('Codex main: luna first, terra on a quality miss; the result names the tier', async () => {
    answers('{"title":"N/A"}', '{"title":"Fix the login bug in prod"}');
    const result = await generateSessionSummaryTitle(['m1'], undefined, { mainModel: 'gpt-6.1-sol[1m]' });
    expect(result).toEqual({ title: 'Fix the login bug in prod', model: 'sonnet' });
    expect(sent()).toEqual([
      [MODEL_ALIASES.luna, undefined],
      [MODEL_ALIASES.terra, undefined],
    ]);
  });

  it('Grok main: grok at effort low, then medium', async () => {
    answers('{"title":"N/A"}', '{"title":"Fix the login bug in prod"}');
    await generateSessionSummaryTitle(['m1'], undefined, { mainModel: 'grok-4.7' });
    const calls = sent();
    expect(calls.map(([m]) => m)).toEqual([expect.stringMatching(GROK), expect.stringMatching(GROK)]);
    expect(calls.map(([, e]) => e)).toEqual(['low', 'medium']);
  });

  it('Claude user default (no session model): the haiku alias', async () => {
    vi.spyOn(userSettingsStore, 'getUserDefaultModel').mockReturnValue('claude-fable-5-2[1m]');
    const result = await generateSessionSummaryTitle(['m1'], undefined, { tenantUserId: 'U_DAN' });
    expect(result?.model).toBe('haiku');
    expect(sent()).toEqual([[MODEL_ALIASES.haiku, undefined]]);
  });

  it('SUMMARY_MODEL does not pin the title tiers (they never read it)', async () => {
    configMock.conversation.summaryModel = 'claude-sonnet-4-6';
    await generateSessionSummaryTitle(['m1'], undefined, { mainModel: 'gpt-6.1-sol[1m]' });
    expect(sent()).toEqual([[MODEL_ALIASES.luna, undefined]]);
  });

  it('the link-derived title passes the session model through', async () => {
    await summarizeIssueAndPrTitles('Login is broken', 'Fix login', 'U_DAN', 'gpt-6.1-sol[1m]');
    expect(sent()).toEqual([[MODEL_ALIASES.luna, undefined]]);
  });
});

describe('instructions summary — the sonnet tier of the session model', () => {
  it('summarizeCompletedInstructions follows mainModel', async () => {
    answers('Fixed the login bug and added a test.');
    await summarizeCompletedInstructions(COMPLETED, { mainModel: 'grok-4.7' });
    const [[model, effort]] = sent();
    expect(model).toMatch(GROK);
    expect(effort).toBe('medium');
  });

  it("regenerateInstructionsSummaryIfStale uses the session's model", async () => {
    answers('Fixed the login bug and added a test.');
    const session = {
      sessionId: 's1',
      ownerId: 'U_DAN',
      model: 'gpt-6.1-sol[1m]',
      instructions: COMPLETED,
    } as unknown as ConversationSession;
    expect(await regenerateInstructionsSummaryIfStale(session)).toBe(true);
    expect(sent()).toEqual([[MODEL_ALIASES.terra, undefined]]);
  });
});

describe('memory improve — the sonnet tier of the user default', () => {
  it("follows the user's default model; SUMMARY_MODEL overrides", async () => {
    answers('Repo builds with bun.');
    vi.spyOn(userSettingsStore, 'getUserDefaultModel').mockReturnValue('grok-4.7');
    await improveEntry('repo builds with bun not npm', 'memory', { tenantUserId: 'U_DAN' });
    configMock.conversation.summaryModel = 'claude-sonnet-4-6';
    await improveEntry('repo builds with bun not npm', 'memory', { tenantUserId: 'U_DAN' });
    const calls = sent();
    expect(calls[0][0]).toMatch(GROK);
    expect(calls[0][1]).toBe('medium');
    expect(calls[1]).toEqual(['claude-sonnet-4-6', undefined]);
  });
});
