/**
 * `ClaudeHandler` streaming-input turn + steering controls (user-steering WU1).
 *
 * The Slack turn used to call `query({ prompt: '<text>' })`, which is
 * single-prompt mode: the CLI exits after the turn and control requests
 * (interrupt / cancel_async_message) are unavailable (sdk.d.ts:2522-2536 —
 * "only supported when streaming input/output is used"). This suite pins the
 * switch to streaming input: the prompt is a `TurnInputChannel`, mid-turn
 * pushes reach the CLI before the turn's `result`, and the channel closes on
 * `result` so "one turn per query()" is preserved.
 *
 * The SDK is mocked at the module boundary (same style as
 * `agent-runtime/__tests__/runner.test.ts`) together with the credential /
 * option-building collaborators, so no CLI child process is spawned.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock, releaseMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  releaseMock: vi.fn(async () => {}),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock,
}));

vi.mock('../credentials-manager', () => ({
  ensureActiveSlotAuth: vi.fn(async () => ({
    heartbeat: async () => {},
    release: releaseMock,
  })),
  getCredentialStatus: () => ({}),
  NoHealthySlotError: class NoHealthySlotError extends Error {},
}));

vi.mock('../credential-alert', () => ({ sendCredentialAlert: vi.fn(async () => {}) }));
vi.mock('../token-manager', () => ({ getTokenManager: () => ({}) }));
vi.mock('../auth/llmux-tenant-keys', () => ({ ensureTenantKey: vi.fn(async () => null) }));
vi.mock('../auth/query-env-builder', () => ({ buildQueryEnv: () => ({ env: {} }) }));
vi.mock('../agent-runtime/claude-code/build-stream-options', () => ({
  buildStreamOptions: vi.fn(async () => ({
    options: { model: 'claude-test' },
    getStderrBuffer: () => '',
  })),
}));

import { ClaudeHandler } from '../claude-handler';
import type { McpManager } from '../mcp-manager';

const SESSION_KEY = 'C123:1700000000.1';

interface FakeQuery {
  received: unknown[];
  interrupt: ReturnType<typeof vi.fn>;
  cancelAsyncMessage: ReturnType<typeof vi.fn>;
  releaseSteerGate(): void;
  inputEnded: boolean;
}

let fake: FakeQuery;

/**
 * Install a fake `query()` that behaves like a streaming-input session:
 * it reads one input message, replies, parks on a gate the test opens after
 * steering, reads the injected message, then emits the turn `result`.
 */
function installFakeQuery(): void {
  queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    const received: unknown[] = [];
    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const inputs = (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();

    const gen = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-test', tools: [] };
      received.push((await inputs.next()).value);
      yield { type: 'assistant', message: { model: 'claude-test', content: [{ type: 'text', text: 'ack' }] } };
      await gate;
      received.push((await inputs.next()).value);
      yield {
        type: 'result',
        subtype: 'success',
        result: 'done',
        duration_ms: 1,
        is_error: false,
        num_turns: 1,
        stop_reason: 'end_turn',
      };
      // The turn is over: the handler must have closed the channel, so this
      // read completes instead of hanging the CLI forever.
      fake.inputEnded = (await inputs.next()).done === true;
    })();

    fake = {
      received,
      interrupt: vi.fn(async () => ({ still_queued: ['q-1'], cancelled: [] })),
      cancelAsyncMessage: vi.fn(async () => true),
      releaseSteerGate: () => openGate(),
      inputEnded: false,
    };
    return Object.assign(gen, {
      interrupt: fake.interrupt,
      cancelAsyncMessage: fake.cancelAsyncMessage,
    });
  });
}

function newHandler(): ClaudeHandler {
  return new ClaudeHandler({ getPluginManager: () => null } as unknown as McpManager);
}

describe('ClaudeHandler streaming-input turn (user-steering WU1)', () => {
  beforeEach(() => {
    queryMock.mockReset();
    releaseMock.mockClear();
    installFakeQuery();
  });

  it('passes an AsyncIterable prompt whose first message is the user text', async () => {
    const handler = newHandler();
    const it = handler
      .streamQuery('hello there', undefined, undefined, undefined, undefined, SESSION_KEY)
      [Symbol.asyncIterator]();

    await it.next(); // init
    await it.next(); // assistant

    const arg = queryMock.mock.calls[0][0];
    expect(typeof arg.prompt).not.toBe('string');
    expect(typeof (arg.prompt as any)[Symbol.asyncIterator]).toBe('function');
    expect(fake.received[0]).toMatchObject({
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'hello there' },
    });

    fake.releaseSteerGate();
    await it.return?.(undefined);
  });

  it('steerTurn injects a uuid-stamped user message the CLI receives before the result', async () => {
    const handler = newHandler();
    const it = handler
      .streamQuery('hello there', undefined, undefined, undefined, undefined, SESSION_KEY)
      [Symbol.asyncIterator]();

    await it.next();
    await it.next();

    expect(
      handler.steerTurn(SESSION_KEY, {
        uuid: 'u-steer-1',
        text: 'actually, do X',
        images: [{ mediaType: 'image/png', base64: 'AAAA' }],
      }),
    ).toBe(true);
    fake.releaseSteerGate();

    const result = await it.next();
    expect((result.value as { type: string }).type).toBe('result');
    expect(fake.received[1]).toMatchObject({
      type: 'user',
      uuid: 'u-steer-1',
      parent_tool_use_id: null,
    });
    const content = (fake.received[1] as any).message.content;
    expect(content).toEqual([
      { type: 'text', text: 'actually, do X' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ]);
    // `shouldQuery` unset means "run a turn for this message".
    expect((fake.received[1] as any).shouldQuery).toBeUndefined();

    await it.next();
  });

  it('closes the input channel on the result frame and forgets the turn afterwards', async () => {
    const handler = newHandler();
    const it = handler
      .streamQuery('hello there', undefined, undefined, undefined, undefined, SESSION_KEY)
      [Symbol.asyncIterator]();

    await it.next();
    await it.next();
    handler.steerTurn(SESSION_KEY, { uuid: 'u-1', text: 'more' });
    fake.releaseSteerGate();
    await it.next(); // result
    expect((await it.next()).done).toBe(true);

    expect(fake.inputEnded).toBe(true);
    expect(handler.steerTurn(SESSION_KEY, { uuid: 'u-2', text: 'too late' })).toBe(false);
    expect(await handler.interruptTurn(SESSION_KEY)).toBeUndefined();
    expect(releaseMock).toHaveBeenCalled();
  });

  it('interruptTurn calls Query.interrupt() and returns the receipt without aborting', async () => {
    const handler = newHandler();
    const abortController = new AbortController();
    const it = handler
      .streamQuery('hello there', undefined, abortController, undefined, undefined, SESSION_KEY)
      [Symbol.asyncIterator]();

    await it.next();
    await it.next();

    const receipt = await handler.interruptTurn(SESSION_KEY);
    expect(fake.interrupt).toHaveBeenCalledTimes(1);
    expect(receipt).toEqual({ stillQueued: ['q-1'], cancelled: [] });
    expect(abortController.signal.aborted).toBe(false);

    fake.releaseSteerGate();
    await it.return?.(undefined);
  });

  it('cancelSteeredMessage forwards to cancelAsyncMessage and reports its boolean', async () => {
    const handler = newHandler();
    const it = handler
      .streamQuery('hello there', undefined, undefined, undefined, undefined, SESSION_KEY)
      [Symbol.asyncIterator]();

    await it.next();
    await it.next();

    expect(await handler.cancelSteeredMessage(SESSION_KEY, 'u-1')).toBe(true);
    expect(fake.cancelAsyncMessage).toHaveBeenCalledWith('u-1');
    expect(await handler.cancelSteeredMessage('no-such-key', 'u-1')).toBe(false);

    fake.releaseSteerGate();
    await it.return?.(undefined);
  });

  it('steerTurn is false for an unknown session key', () => {
    const handler = newHandler();
    expect(handler.steerTurn('nobody', { uuid: 'u-1', text: 'x' })).toBe(false);
  });

  it('streamAgentEvents surfaces steer_lifecycle through the neutral stream', async () => {
    queryMock.mockImplementation(() => {
      const gen = (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sess-2', model: 'claude-test', tools: [] };
        yield {
          type: 'assistant',
          user_message_uuid: 'u-steer-1',
          message: { model: 'claude-test', content: [{ type: 'text', text: 'on it' }] },
        };
        yield {
          type: 'result',
          subtype: 'success',
          result: 'done',
          user_message_uuid: 'u-steer-1',
          duration_ms: 1,
          is_error: false,
          num_turns: 1,
          stop_reason: 'end_turn',
        };
      })();
      return Object.assign(gen, { interrupt: vi.fn(), cancelAsyncMessage: vi.fn() });
    });

    const handler = newHandler();
    const events = [];
    for await (const e of handler.streamAgentEvents('hello', undefined, undefined, undefined, undefined, SESSION_KEY)) {
      events.push(e);
    }

    expect(events.filter((e) => e.type === 'steer_lifecycle')).toEqual([
      { type: 'steer_lifecycle', uuid: 'u-steer-1', phase: 'started' },
      { type: 'steer_lifecycle', uuid: 'u-steer-1', phase: 'completed' },
    ]);
  });
});
