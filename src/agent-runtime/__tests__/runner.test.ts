/**
 * Adapter behaviour: `runOneShotText` accumulates assistant text blocks
 * and forwards mapped options to `query()`.
 *
 * These tests mock the SDK at the module boundary so the dispatcher +
 * adapter + mapper are exercised together without spawning the Claude
 * Code child process.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock,
}));

import { runOneShotText } from '../index';

function makeStream(messages: unknown[]): AsyncIterable<unknown> {
  return (async function* () {
    for (const m of messages) yield m;
  })();
}

describe('runOneShotText (Claude Code adapter)', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it('concatenates assistant text blocks across the stream', async () => {
    queryMock.mockReturnValue(
      makeStream([
        { type: 'system' },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'hello' },
              { type: 'thinking', thinking: 'should not leak' },
              { type: 'text', text: ' world' },
            ],
          },
        },
        { type: 'result' },
      ]),
    );

    const text = await runOneShotText('prompt', { model: 'm' });
    expect(text).toBe('hello world');
  });

  it('forwards mapped options (model/thinking/env) to the SDK query call', async () => {
    queryMock.mockReturnValue(makeStream([]));

    await runOneShotText('p', {
      model: 'claude-haiku-4-5',
      maxTurns: 1,
      systemPrompt: 'sys',
      extensions: {
        claudeCode: {
          env: { CLAUDE_CODE_OAUTH_TOKEN: 'V' },
          thinking: { type: 'disabled' },
        },
      },
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const arg = queryMock.mock.calls[0][0] as {
      prompt: string;
      options: {
        model: string;
        systemPrompt: string;
        thinking: unknown;
        env: Record<string, string | undefined>;
      };
    };
    expect(arg.prompt).toBe('p');
    expect(arg.options.model).toBe('claude-haiku-4-5');
    expect(arg.options.systemPrompt).toBe('sys');
    expect(arg.options.thinking).toEqual({ type: 'disabled' });
    expect(arg.options.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'V' });
  });

  it('returns an empty string when the stream has no assistant messages', async () => {
    queryMock.mockReturnValue(makeStream([{ type: 'system' }, { type: 'result' }]));
    const text = await runOneShotText('p', { model: 'm' });
    expect(text).toBe('');
  });
});
