/**
 * Regression tests for #762 — every LLM call site that drives a session
 * title or summary must pass `thinking: { type: 'disabled' }` to the SDK.
 * Adaptive thinking on Haiku/Sonnet 4.5 silently consumed the entire output
 * budget on these tiny prompts, leaving an empty response that broke
 * JSON.parse downstream.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  };
});

vi.mock('../../token-manager', () => ({
  getTokenManager: vi.fn(() => ({})),
}));

vi.mock('../../auth/query-env-builder', () => ({
  buildQueryEnv: vi.fn(() => ({ env: { FAKE: '1' } })),
}));

const { queryMock } = vi.hoisted(() => {
  const queryMock = vi.fn(() => {
    return (async function* () {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } };
    })();
  });
  return { queryMock };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock,
}));

vi.mock('../../prompt/user-instructions-block', () => ({
  computeCompletedUpstreamHash: vi.fn(() => 'fake-hash'),
}));

import { summarizeCompletedInstructions } from '../instructions-summarizer';
import { generateSessionSummaryTitle, summarizeResponse } from '../summarizer';
import { generateTitle } from '../title-generator';

function lastCallOptions(): { thinking?: unknown } {
  const calls = queryMock.mock.calls as unknown as Array<[{ prompt: string; options: { thinking?: unknown } }]>;
  expect(calls.length).toBeGreaterThan(0);
  const lastCall = calls[calls.length - 1];
  return lastCall[0].options;
}

function nthCallOptions(index: number): { thinking?: unknown; model: string } {
  const calls = queryMock.mock.calls as unknown as Array<
    [{ prompt: string; options: { thinking?: unknown; model: string } }]
  >;
  expect(calls.length).toBeGreaterThan(index);
  return calls[index][0].options;
}

describe('#762 — thinking option propagates through every title/summary LLM site', () => {
  beforeEach(() => {
    queryMock.mockClear();
    // Default script: each query yields a JSON-shaped response so the parsers
    // succeed and the call site fully exercises the options path.
    queryMock.mockImplementation(() => {
      return (async function* () {
        yield {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'text',
                text: '{"title":"Fix login bug","body":"line1\\nline2\\nline3"}',
              },
            ],
          },
        };
      })();
    });
  });

  it('summarizeResponse passes thinking: { type: "disabled" }', async () => {
    await summarizeResponse('long assistant response text');
    expect(lastCallOptions().thinking).toEqual({ type: 'disabled' });
  });

  it('generateTitle passes thinking: { type: "disabled" }', async () => {
    queryMock.mockImplementationOnce(() => {
      return (async function* () {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'My Title' }] },
        };
      })();
    });
    await generateTitle('a conversation');
    expect(lastCallOptions().thinking).toEqual({ type: 'disabled' });
  });

  it('generateSessionSummaryTitle passes thinking: { type: "disabled" } on every model attempt', async () => {
    queryMock.mockImplementationOnce(() => {
      return (async function* () {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: '{"title":"Refactor auth flow"}' }] },
        };
      })();
    });
    await generateSessionSummaryTitle(['please refactor auth']);
    // Haiku attempt was made — verify thinking was disabled.
    const haikuOptions = nthCallOptions(0);
    expect(haikuOptions.thinking).toEqual({ type: 'disabled' });
    expect(haikuOptions.model).toBe('claude-haiku-4-5');
  });

  it('generateSessionSummaryTitle disables thinking on Sonnet fallback too', async () => {
    queryMock
      .mockImplementationOnce(() => {
        return (async function* () {
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: '{"title":"N/A"}' }] }, // fails quality gate
          };
        })();
      })
      .mockImplementationOnce(() => {
        return (async function* () {
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: '{"title":"Real Sonnet Title"}' }] },
          };
        })();
      });
    const result = await generateSessionSummaryTitle(['msg']);
    expect(result?.model).toBe('sonnet');
    expect(queryMock).toHaveBeenCalledTimes(2);
    const sonnetOptions = nthCallOptions(1);
    expect(sonnetOptions.thinking).toEqual({ type: 'disabled' });
    expect(sonnetOptions.model).toBe('claude-sonnet-4-5');
  });

  it('summarizeCompletedInstructions passes thinking: { type: "disabled" }', async () => {
    queryMock.mockImplementationOnce(() => {
      return (async function* () {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'compact prose summary of two completed items' }] },
        };
      })();
    });
    const items = [
      {
        id: 'a',
        text: 'fix bug',
        status: 'completed' as const,
        createdAt: '2026-04-27T00:00:00.001Z',
        completedAt: '2026-04-27T00:00:00.002Z',
        linkedSessionIds: [],
        source: 'model' as const,
        sourceRawInputIds: [],
      },
      {
        id: 'b',
        text: 'add tests',
        status: 'completed' as const,
        createdAt: '2026-04-27T00:00:00.003Z',
        completedAt: '2026-04-27T00:00:00.004Z',
        linkedSessionIds: [],
        source: 'model' as const,
        sourceRawInputIds: [],
      },
    ];
    const result = await summarizeCompletedInstructions(items);
    expect(result).toBeTruthy();
    expect(lastCallOptions().thinking).toEqual({ type: 'disabled' });
  });
});
