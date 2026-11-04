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

// The goal evaluator matches the work model's effort: ultra is not a CLI `--effort` value and no backend takes it on
// the wire — the one-shot runner runs it as max, like the streaming query.
describe('toSdkOptions — an effort the CLI does not take', () => {
  it('ultra runs as max; an SDK level stays; the env is never touched', async () => {
    const { toSdkOptions } = await import('../claude-code-runner');
    const base = { model: 'gpt-6.1-sol[1m]', maxTurns: 1, systemPrompt: 's' };
    const env = { A: '1' };
    const ultra = toSdkOptions({ ...base, extensions: { claudeCode: { env, effort: 'ultra' } } } as never);
    expect(ultra.effort).toBe('max');
    expect(ultra.env).toEqual({ A: '1' });
    expect(toSdkOptions({ ...base, extensions: { claudeCode: { env, effort: 'high' } } } as never).effort).toBe('high');
  });
});

// Review gate round 2 (astra-zhuge P1 #4, PR #906): a safeguards block that
// arrives only in the result's errors[] must not read as an empty answer.
describe('runOneShotText — safeguards block in the result errors[]', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it('throws the block instead of returning empty text', async () => {
    queryMock.mockReturnValue(
      makeStream([
        {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          errors: [
            "API Error: Opus 5.5 (1M context)'s safeguards flagged this message (https://www.anthropic.com/legal/aup).\n\nDetails: `[reasoning_extraction]`\n\nRequest ID: req_r2",
          ],
        },
      ]),
    );
    await expect(runOneShotText('p', { model: 'm' } as any)).rejects.toThrow(/safeguards flagged this message/);
  });

  it('other result errors keep the old behavior (empty text, no throw)', async () => {
    queryMock.mockReturnValue(
      makeStream([{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'] }]),
    );
    await expect(runOneShotText('p', { model: 'm' } as any)).resolves.toBe('');
  });
});

// Review gate round 6 (astra-zhuge P1): text written before the block must not
// hide it — the guardian would read the earlier text as its verdict.
describe('runOneShotText — safeguards block after earlier text', () => {
  const BLOCK =
    "API Error: Opus 5.5 (1M context)'s safeguards flagged this message (https://www.anthropic.com/legal/aup).\n\nDetails: `[reasoning_extraction]`\n\nRequest ID: req_r6";
  const earlier = {
    type: 'assistant',
    message: { content: [{ type: 'text', text: '{"verdict":"allow","reason":"ok"}' }] },
  };

  beforeEach(() => {
    queryMock.mockReset();
  });

  it('a block in its own assistant message throws, and the query stops there', async () => {
    let pulledAfterBlock = false;
    queryMock.mockReturnValue(
      (async function* () {
        yield earlier;
        yield { type: 'assistant', message: { content: [{ type: 'text', text: BLOCK }] } };
        pulledAfterBlock = true;
        yield { type: 'result', subtype: 'success', is_error: false };
      })(),
    );
    await expect(runOneShotText('p', { model: 'm' } as any)).rejects.toThrow(/safeguards flagged this message/);
    expect(pulledAfterBlock).toBe(false);
  });

  it("a block in the result's errors[] throws even after earlier text", async () => {
    queryMock.mockReturnValue(
      makeStream([earlier, { type: 'result', subtype: 'error_during_execution', is_error: true, errors: [BLOCK] }]),
    );
    await expect(runOneShotText('p', { model: 'm' } as any)).rejects.toThrow(/safeguards flagged this message/);
  });

  it('a thrown block throws even after earlier text', async () => {
    queryMock.mockReturnValue(
      (async function* () {
        yield earlier;
        throw new Error(BLOCK);
      })(),
    );
    await expect(runOneShotText('p', { model: 'm' } as any)).rejects.toThrow(/safeguards flagged this message/);
  });

  it('an ordinary crash after usable text still returns the text', async () => {
    queryMock.mockReturnValue(
      (async function* () {
        yield earlier;
        throw new Error('Claude Code process exited with code 143');
      })(),
    );
    await expect(runOneShotText('p', { model: 'm' } as any)).resolves.toContain('allow');
  });
});
