import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Module mocks (hoisted) ------------------------------------------------

vi.mock('../../config', () => ({
  config: { conversation: { summaryModel: 'claude-haiku-4-5' } },
}));

vi.mock('../../credentials-manager', () => {
  class FakeNoHealthySlotError extends Error {
    constructor(message = 'No healthy CCT slot available') {
      super(message);
      this.name = 'NoHealthySlotError';
    }
  }
  const lease = {
    slotId: 'test-slot',
    accessToken: 'test-access-token',
    kind: 'setup_token' as const,
    release: vi.fn(async () => {}),
    heartbeat: vi.fn(async () => {}),
  };
  return {
    ensureActiveSlotAuth: vi.fn(async () => lease),
    NoHealthySlotError: FakeNoHealthySlotError,
    __mockLease: lease,
  };
});

vi.mock('../../token-manager', () => ({
  getTokenManager: vi.fn(() => ({})),
}));

vi.mock('../../auth/query-env-builder', () => ({
  buildQueryEnv: vi.fn(() => ({ env: { FAKE: '1' } })),
}));

// Per-test script of what each `query()` call should yield as assistant text.
// Hoisted alongside the vi.mock factory below so the factory can reference
// queryMock without TDZ errors.
const { queryMock, queryScriptRef } = vi.hoisted(() => {
  const queryScriptRef = { current: [] as string[] };
  // biome-ignore lint/suspicious/noExplicitAny: test mock surface mirrors SDK's loose shape.
  const queryMock = vi.fn((_args: { prompt: string; options: any }) => {
    const text = queryScriptRef.current.shift() ?? '';
    return (async function* () {
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text }] },
      };
    })();
  });
  return { queryMock, queryScriptRef };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock,
}));

import { generateSessionSummaryTitle } from '../summarizer';

describe('generateSessionSummaryTitle — Dashboard v2.1 chunk F', () => {
  beforeEach(() => {
    queryScriptRef.current = [];
    queryMock.mockClear();
  });

  it('returns null when user messages are empty', async () => {
    const result = await generateSessionSummaryTitle([]);
    expect(result).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('accepts a valid Haiku-generated title', async () => {
    queryScriptRef.current = [JSON.stringify({ title: 'Refactor auth flow to use OAuth2' })];
    const result = await generateSessionSummaryTitle(['please refactor the auth flow', 'use oauth2']);
    expect(result).toEqual({ title: 'Refactor auth flow to use OAuth2', model: 'haiku' });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('strips markdown code fences from LLM output', async () => {
    queryScriptRef.current = [`\`\`\`json\n${JSON.stringify({ title: 'Fix dashboard timer bug' })}\n\`\`\``];
    const result = await generateSessionSummaryTitle(['timer shows 0']);
    expect(result?.title).toBe('Fix dashboard timer bug');
    expect(result?.model).toBe('haiku');
  });

  it('falls back to Sonnet when Haiku title fails quality gate (too short)', async () => {
    queryScriptRef.current = [
      JSON.stringify({ title: 'N/A' }), // Haiku: placeholder, fails gate
      JSON.stringify({ title: 'Add Slack card debounce to avoid chat.update flood' }), // Sonnet ok
    ];
    const result = await generateSessionSummaryTitle(['slack card keeps refreshing']);
    expect(result?.model).toBe('sonnet');
    expect(result?.title).toBe('Add Slack card debounce to avoid chat.update flood');
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it('returns null when both models fail the quality gate', async () => {
    queryScriptRef.current = [JSON.stringify({ title: 'Untitled' }), JSON.stringify({ title: '...' })];
    const result = await generateSessionSummaryTitle(['foo']);
    expect(result).toBeNull();
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it('returns null when JSON is malformed (both models)', async () => {
    queryScriptRef.current = ['not json at all', 'still not json'];
    const result = await generateSessionSummaryTitle(['foo']);
    expect(result).toBeNull();
  });

  it('truncates titles to 80 chars and still passes when truncated result is clean', async () => {
    const longTitle = 'A'.repeat(200);
    queryScriptRef.current = [JSON.stringify({ title: longTitle })];
    const result = await generateSessionSummaryTitle(['msg']);
    expect(result?.title.length).toBe(80);
    expect(result?.model).toBe('haiku');
  });

  it('includes linked issue/PR context in the prompt when provided', async () => {
    queryScriptRef.current = [JSON.stringify({ title: 'Issue-linked task title resolved' })];
    await generateSessionSummaryTitle(['fix issue'], {
      issueTitle: 'Dashboard broken',
      issueLabel: '#597',
      prTitle: 'Fix dashboard',
      prLabel: '#700',
      prStatus: 'open',
    });
    expect(queryMock).toHaveBeenCalledTimes(1);
    const passedPrompt = queryMock.mock.calls[0][0].prompt as string;
    expect(passedPrompt).toContain('#597');
    expect(passedPrompt).toContain('Dashboard broken');
    expect(passedPrompt).toContain('#700');
    expect(passedPrompt).toContain('(open)');
  });
});
