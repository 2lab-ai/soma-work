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

import { STEER_SETTLEMENT_SUBTYPE } from '../agent-runtime/steer-settlement';
import { ClaudeHandler, STEER_SETTLEMENT_BOUND_MS } from '../claude-handler';
import { Logger } from '../logger';
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

/**
 * Install a fake `query()` for the settlement path: it replies, parks on the
 * gate (the test steers here), then emits a `result` carrying the given
 * `queued_turn_count`. `interrupt` is whatever the case needs.
 *
 * `capabilities` lands on the `system`/`init` frame exactly where the CLI
 * advertises it (sdk.d.ts:5000) — that is the handler's feature-detection point
 * for `interrupt_cancel_queued_v1`. `resultOverrides` patches the result frame
 * (error subtype, `terminal_reason`), and `resultCount` replays it, which is how
 * a second `result` reaches the settlement path. `reinitWithoutCapabilities`
 * replays a bare `system`/`init` mid-turn (a session can re-announce itself),
 * which is how a frame that carries no `capabilities` reaches the read.
 */
function installSettlementQuery(opts: {
  queuedTurnCount?: number;
  interrupt: ReturnType<typeof vi.fn>;
  capabilities?: string[];
  resultOverrides?: Record<string, unknown>;
  resultCount?: number;
  reinitWithoutCapabilities?: boolean;
}): void {
  queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    const received: unknown[] = [];
    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const inputs = (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();

    const gen = (async function* () {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        model: 'claude-test',
        tools: [],
        ...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
      };
      received.push((await inputs.next()).value);
      yield { type: 'assistant', message: { model: 'claude-test', content: [{ type: 'text', text: 'ack' }] } };
      if (opts.reinitWithoutCapabilities) {
        yield { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-test', tools: [] };
      }
      await gate;
      for (let emitted = 0; emitted < (opts.resultCount ?? 1); emitted++) {
        yield {
          type: 'result',
          subtype: 'success',
          result: 'done',
          duration_ms: 1,
          is_error: false,
          num_turns: 1,
          stop_reason: 'end_turn',
          queued_turn_count: opts.queuedTurnCount,
          session_id: 'sess-1',
          uuid: 'result-frame-uuid',
          ...opts.resultOverrides,
        };
      }
    })();

    fake = {
      received,
      interrupt: opts.interrupt,
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

/** Drive a turn to its result, steering `uuids` in while it runs. */
async function runSteeredTurn(uuids: string[]): Promise<unknown[]> {
  const handler = newHandler();
  const it = handler
    .streamQuery('hello there', undefined, undefined, undefined, undefined, SESSION_KEY)
    [Symbol.asyncIterator]();

  const frames: unknown[] = [];
  frames.push((await it.next()).value); // init
  frames.push((await it.next()).value); // assistant
  for (const uuid of uuids) {
    expect(handler.steerTurn(SESSION_KEY, { uuid, text: `steer ${uuid}` })).toBe(true);
  }
  fake.releaseSteerGate();

  for (;;) {
    const next = await it.next();
    if (next.done) break;
    frames.push(next.value);
  }
  return frames;
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

    // A turn with pushed sends settles them first: one synthetic frame, then
    // the result (see the settlement suite below).
    const settlement = await it.next();
    expect((settlement.value as { subtype: string }).subtype).toBe('steer_settlement');
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
    await it.next(); // steer_settlement
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

  it('cancelSteeredMessage reports `withdrawn` when the SDK took the message back', async () => {
    const handler = newHandler();
    const it = handler
      .streamQuery('hello there', undefined, undefined, undefined, undefined, SESSION_KEY)
      [Symbol.asyncIterator]();

    await it.next();
    await it.next();

    expect(await handler.cancelSteeredMessage(SESSION_KEY, 'u-1')).toBe('withdrawn');
    expect(fake.cancelAsyncMessage).toHaveBeenCalledWith('u-1');

    fake.releaseSteerGate();
    await it.return?.(undefined);
  });

  /**
   * The SDK's `false` is a FACT about the message ("it already left my queue"),
   * not a failure — the caller has to record consumption, not a failed cancel.
   */
  it('cancelSteeredMessage reports `already-dequeued` when the SDK refused to withdraw', async () => {
    const handler = newHandler();
    const it = handler
      .streamQuery('hello there', undefined, undefined, undefined, undefined, SESSION_KEY)
      [Symbol.asyncIterator]();

    await it.next();
    await it.next();
    fake.cancelAsyncMessage.mockResolvedValueOnce(false);

    expect(await handler.cancelSteeredMessage(SESSION_KEY, 'u-1')).toBe('already-dequeued');

    fake.releaseSteerGate();
    await it.return?.(undefined);
  });

  it('cancelSteeredMessage reports `unreachable` when no turn is running for the key', async () => {
    const handler = newHandler();

    expect(await handler.cancelSteeredMessage('no-such-key', 'u-1')).toBe('unreachable');
  });

  /**
   * A runtime without `cancelAsyncMessage` never SAW the request, so the caller
   * must not read it as "the model has it" — that would resolve an item nobody
   * delivered.
   */
  it('cancelSteeredMessage reports `unreachable` when the runtime has no cancelAsyncMessage', async () => {
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
      const inputs = (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      const gen = (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-test', tools: [] };
        await inputs.next();
        yield { type: 'assistant', message: { model: 'claude-test', content: [{ type: 'text', text: 'ack' }] } };
        await new Promise<void>(() => {});
      })();
      return Object.assign(gen, { interrupt: vi.fn(async () => undefined) });
    });

    const handler = newHandler();
    const it = handler
      .streamQuery('hello there', undefined, undefined, undefined, undefined, SESSION_KEY)
      [Symbol.asyncIterator]();

    await it.next();
    await it.next();

    expect(await handler.cancelSteeredMessage(SESSION_KEY, 'u-1')).toBe('unreachable');

    await it.return?.(undefined);
  });

  it('steerTurn is false for an unknown session key', () => {
    const handler = newHandler();
    expect(handler.steerTurn('nobody', { uuid: 'u-1', text: 'x' })).toBe(false);
  });

  /**
   * A turn is registered for steering ONLY under the key the host passed. The
   * old `channel:threadTs` fallback minted a key in a format no host caller can
   * address (host keys are `work:<channel>:<thread>`, `src/session-identity.ts`)
   * — it could never be steered, but it did keep an entry alive under a key
   * nobody would ever delete by. No key, no registration.
   */
  it('does not register a turn for steering when the caller passes no session key', async () => {
    const handler = newHandler();
    const slackContext = { channel: 'C123', threadTs: '1700000000.1', user: 'U1' };
    const it = handler
      .streamQuery('hello there', undefined, undefined, undefined, slackContext as never)
      [Symbol.asyncIterator]();

    await it.next();
    await it.next();

    expect(handler.steerTurn('C123:1700000000.1', { uuid: 'u-1', text: 'x' })).toBe(false);
    expect(await handler.interruptTurn('C123:1700000000.1')).toBeUndefined();
    expect(fake.interrupt).not.toHaveBeenCalled();

    fake.releaseSteerGate();
    await it.return?.(undefined);
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

    // Only `started`: nothing was pushed into this turn, so there is no
    // settlement frame — and the result's echoed uuid no longer fabricates a
    // `completed` (it names the send that started the turn, not a steered one).
    expect(events.filter((e) => e.type === 'steer_lifecycle')).toEqual([
      { type: 'steer_lifecycle', uuid: 'u-steer-1', phase: 'started' },
    ]);
  });
});

/**
 * Settlement of steered sends (spec §6 item 6).
 *
 * SDK 0.3.251 reports no per-frame consumption signal for a mid-turn send, so
 * "did the turn actually eat it?" is decided at the `result` frame:
 * `queued_turn_count` (sdk.d.ts:4795/4849) counts pushed sends the CLI has NOT
 * folded into this turn. >0 → interrupt and read the receipt; the survivors
 * (`still_queued` ∪ `cancelled`) are the unconsumed ones. The handler publishes
 * the verdict as ONE synthetic `system/steer_settlement` frame emitted just
 * before the result, so the mapper stays a pure function of the stream.
 */
describe('ClaudeHandler steer settlement (spec §6 item 6)', () => {
  beforeEach(() => {
    queryMock.mockReset();
    releaseMock.mockClear();
  });

  it('interrupts on queued_turn_count > 0 and settles survivors as discarded', async () => {
    // The receipt accounts for the whole backlog here (1 leftover = 1 survivor
    // listed), which is what lets the other pushed send be called consumed. The
    // under-accounted case is its own test below.
    const interrupt = vi.fn(async () => ({ still_queued: ['u2'], cancelled: [] }));
    installSettlementQuery({ queuedTurnCount: 1, interrupt });

    const frames = await runSteeredTurn(['u1', 'u2']);

    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(4); // init, assistant, settlement, result
    expect(frames[2]).toMatchObject({
      type: 'system',
      subtype: 'steer_settlement',
      consumed: ['u1'],
      discarded: ['u2'],
      session_id: 'sess-1',
      uuid: 'result-frame-uuid',
    });
    expect(frames[3]).toMatchObject({ type: 'result', subtype: 'success' });
  });

  it('counts cancelled uuids as unconsumed too', async () => {
    const interrupt = vi.fn(async () => ({ still_queued: [], cancelled: ['u1'] }));
    installSettlementQuery({ queuedTurnCount: 1, interrupt });

    const frames = await runSteeredTurn(['u1', 'u2']);

    expect(frames[2]).toMatchObject({ consumed: ['u2'], discarded: ['u1'] });
  });

  it('cancels every survivor the interrupt did not already cancel, and still discards all of them', async () => {
    // Without the `interrupt_cancel_queued_v1` capability the interrupt cannot
    // sweep the queue, so survivors listed under `still_queued` WILL run as
    // extra turns unless withdrawn one by one. Withdrawal is best-effort: the
    // verdict stays `discarded` either way, because the host requeues a
    // discarded item while a failed cancel only risks a double-run bounded by
    // the process teardown after `result`.
    const interrupt = vi.fn(async () => ({ still_queued: ['u1', 'u2'], cancelled: ['u2'] }));
    installSettlementQuery({ queuedTurnCount: 2, interrupt });

    const frames = await runSteeredTurn(['u1', 'u2']);

    expect(fake.cancelAsyncMessage).toHaveBeenCalledTimes(1);
    expect(fake.cancelAsyncMessage).toHaveBeenCalledWith('u1');
    expect(frames[2]).toMatchObject({ consumed: [], discarded: ['u1', 'u2'] });
  });

  it('keeps a survivor discarded when its cancel attempt throws', async () => {
    const interrupt = vi.fn(async () => ({ still_queued: ['u1'], cancelled: [] }));
    installSettlementQuery({ queuedTurnCount: 1, interrupt });

    const handler = newHandler();
    const it = handler
      .streamQuery('hello there', undefined, undefined, undefined, undefined, SESSION_KEY)
      [Symbol.asyncIterator]();
    await it.next();
    await it.next();
    fake.cancelAsyncMessage.mockImplementation(async () => {
      throw new Error('control request failed');
    });
    handler.steerTurn(SESSION_KEY, { uuid: 'u1', text: 'a' });
    handler.steerTurn(SESSION_KEY, { uuid: 'u2', text: 'b' });
    fake.releaseSteerGate();
    const settlement = await it.next();

    expect(fake.cancelAsyncMessage).toHaveBeenCalledWith('u1');
    expect(settlement.value).toMatchObject({ consumed: ['u2'], discarded: ['u1'] });
    await it.next();
  });

  it('settles every pushed send as consumed without interrupting when queued_turn_count is 0', async () => {
    const interrupt = vi.fn(async () => ({ still_queued: [], cancelled: [] }));
    installSettlementQuery({ queuedTurnCount: 0, interrupt });

    const frames = await runSteeredTurn(['u1', 'u2']);

    expect(interrupt).not.toHaveBeenCalled();
    expect(frames[2]).toMatchObject({ consumed: ['u1', 'u2'], discarded: [] });
  });

  it('treats an absent queued_turn_count on a HEALTHY result as "nothing left queued"', async () => {
    const interrupt = vi.fn(async () => ({ still_queued: [], cancelled: [] }));
    installSettlementQuery({ queuedTurnCount: undefined, interrupt });

    const frames = await runSteeredTurn(['u1']);

    expect(interrupt).not.toHaveBeenCalled();
    expect(frames[2]).toMatchObject({ consumed: ['u1'], discarded: [] });
  });

  /**
   * M3 — `queued_turn_count` 0/absent is only evidence of consumption on a turn
   * that ENDED WELL. sdk.d.ts:4793/4847: 0 also means "the session is ending
   * (end_session or a shutdown latched mid-turn discards the backlog)" and the
   * field is "absent on fatal startup results". Reading either as consumption
   * resolves a user message that never ran — the one loss this feature may not
   * have — so anything but a clean success discards.
   */
  it('discards every pushed send when the result is an error, absent count or not', async () => {
    const interrupt = vi.fn(async () => ({ still_queued: [], cancelled: [] }));
    installSettlementQuery({
      queuedTurnCount: undefined,
      interrupt,
      resultOverrides: { subtype: 'error_during_execution', is_error: true },
    });

    const frames = await runSteeredTurn(['u1', 'u2']);

    expect(frames[2]).toMatchObject({ consumed: [], discarded: ['u1', 'u2'] });
  });

  /**
   * M3 (cont.) — the health gate outranks the count. `queued_turn_count > 0` is
   * a leftover count, NOT a certificate that the rest ran: an errored result can
   * carry one too, and reading it as "backlog minus survivors = consumed" would
   * mark folded sends consumed on a turn that produced nothing. The receipt that
   * would name the survivors is worthless on a dead turn (the interrupt targets
   * a CLI that is already tearing down), so an unhealthy result short-circuits
   * to "discard everything" without spending a control round-trip.
   */
  it('discards every pushed send when an ERRORED result still reports queued_turn_count > 0', async () => {
    const interrupt = vi.fn(async () => ({ still_queued: ['u2'], cancelled: [] }));
    installSettlementQuery({
      queuedTurnCount: 1,
      interrupt,
      resultOverrides: { subtype: 'error_during_execution', is_error: true },
    });

    const frames = await runSteeredTurn(['u1', 'u2']);

    expect(interrupt).not.toHaveBeenCalled();
    expect(frames[2]).toMatchObject({ consumed: [], discarded: ['u1', 'u2'] });
  });

  it('discards every pushed send when a terminated result still reports queued_turn_count > 0', async () => {
    const interrupt = vi.fn(async () => ({ still_queued: ['u2'], cancelled: [] }));
    installSettlementQuery({
      queuedTurnCount: 1,
      interrupt,
      resultOverrides: { terminal_reason: 'api_error' },
    });

    const frames = await runSteeredTurn(['u1', 'u2']);

    expect(interrupt).not.toHaveBeenCalled();
    expect(frames[2]).toMatchObject({ consumed: [], discarded: ['u1', 'u2'] });
  });

  it('discards every pushed send when queued_turn_count is 0 but the session is shutting down', async () => {
    const interrupt = vi.fn(async () => ({ still_queued: [], cancelled: [] }));
    installSettlementQuery({
      queuedTurnCount: 0,
      interrupt,
      resultOverrides: { terminal_reason: 'blocking_limit' },
    });

    const frames = await runSteeredTurn(['u1']);

    expect(frames[2]).toMatchObject({ consumed: [], discarded: ['u1'] });
  });

  /**
   * M1 — after the result, a plain interrupt loses the drain race: a send already
   * promoted to the imminent turn is NOT listed under `still_queued`
   * (sdk.d.ts:3942). `queued_turn_count` counted the backlog at result time, so
   * when the receipt accounts for fewer survivors than that count, the missing
   * ones are unaccounted — not proven consumed.
   */
  it('treats queued_turn_count as the authority when the receipt accounts for fewer survivors', async () => {
    const interrupt = vi.fn(async () => ({ still_queued: [], cancelled: [] }));
    installSettlementQuery({ queuedTurnCount: 1, interrupt });

    const frames = await runSteeredTurn(['u1']);

    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(frames[2]).toMatchObject({ consumed: [], discarded: ['u1'] });
  });

  /**
   * M2 — the "0.3.251 interrupt takes no argument" premise holds for the TYPE
   * only. `sdk.mjs` forwards `cancel_queued:true` when the caller passes
   * `{cancelQueued:true}`, and sdk.d.ts:3932/3946 describe it sweeping every
   * uuid-stamped survivor SYNCHRONOUSLY with the abort (listed under
   * `cancelled`, `still_queued` then empty). A CLI that advertises
   * `interrupt_cancel_queued_v1` on `system`/`init` therefore needs no per-uuid
   * withdrawal loop at all.
   */
  it('sweeps the queue with cancel_queued when the CLI advertises the capability', async () => {
    const interrupt = vi.fn(async () => ({ still_queued: [], cancelled: ['u2'] }));
    installSettlementQuery({
      queuedTurnCount: 1,
      interrupt,
      capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1'],
    });

    const frames = await runSteeredTurn(['u1', 'u2']);

    expect(interrupt).toHaveBeenCalledWith({ cancelQueued: true });
    expect(fake.cancelAsyncMessage).not.toHaveBeenCalled();
    expect(frames[2]).toMatchObject({ consumed: ['u1'], discarded: ['u2'] });
  });

  /**
   * `capabilities` is an announcement, not a level that every later frame
   * re-asserts. A session that re-emits `system`/`init` without the field (the
   * type marks it optional, sdk.d.ts:5000) says nothing about what the CLI can
   * do — overwriting the stored list with the empty read would silently demote a
   * capable CLI back to the per-uuid withdrawal loop mid-turn.
   */
  it('keeps the advertised capabilities when a later init frame omits them', async () => {
    const interrupt = vi.fn(async () => ({ still_queued: [], cancelled: ['u1'] }));
    installSettlementQuery({
      queuedTurnCount: 1,
      interrupt,
      capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1'],
      reinitWithoutCapabilities: true,
    });

    const frames = await runSteeredTurn(['u1']);

    expect(interrupt).toHaveBeenCalledWith({ cancelQueued: true });
    expect(frames.find((f) => (f as { subtype?: string }).subtype === STEER_SETTLEMENT_SUBTYPE)).toMatchObject({
      consumed: [],
      discarded: ['u1'],
    });
  });

  it('keeps the per-uuid withdrawal path when the capability is absent', async () => {
    const interrupt = vi.fn(async () => ({ still_queued: ['u1'], cancelled: [] }));
    installSettlementQuery({ queuedTurnCount: 1, interrupt, capabilities: ['interrupt_receipt_v1'] });

    await runSteeredTurn(['u1']);

    expect(interrupt).toHaveBeenCalledWith();
    expect(fake.cancelAsyncMessage).toHaveBeenCalledWith('u1');
  });

  /**
   * S2 — a streaming-input session can emit more than one `result`. Settling
   * twice would interrupt an already-settled turn and emit a second verdict for
   * uuids the host has already resolved.
   */
  it('settles exactly once even when the turn emits two result frames', async () => {
    const interrupt = vi.fn(async () => ({ still_queued: ['u1'], cancelled: [] }));
    installSettlementQuery({ queuedTurnCount: 1, interrupt, resultCount: 2 });

    const frames = await runSteeredTurn(['u1']);

    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(frames.filter((f) => (f as { subtype?: string }).subtype === STEER_SETTLEMENT_SUBTYPE)).toHaveLength(1);
    expect(frames.filter((f) => (f as { type: string }).type === 'result')).toHaveLength(2);
  });

  /**
   * M4 — the settlement snapshots the pushed uuids and then awaits an interrupt
   * round-trip. A push accepted during that await would be settled by nobody, so
   * the channel is sealed BEFORE the snapshot: the push is refused and the host
   * keeps the item queued.
   */
  it('refuses a steer that arrives while the settlement is in flight', async () => {
    let lateSteer: boolean | undefined;
    const handler = newHandler();
    const interrupt = vi.fn(async () => {
      lateSteer = handler.steerTurn(SESSION_KEY, { uuid: 'u-late', text: 'too late' });
      return { still_queued: ['u1'], cancelled: [] };
    });
    installSettlementQuery({ queuedTurnCount: 1, interrupt });

    const it = handler
      .streamQuery('hello there', undefined, undefined, undefined, undefined, SESSION_KEY)
      [Symbol.asyncIterator]();
    await it.next();
    await it.next();
    handler.steerTurn(SESSION_KEY, { uuid: 'u1', text: 'a' });
    fake.releaseSteerGate();
    const settlement = await it.next();

    expect(lateSteer).toBe(false);
    expect(settlement.value).toMatchObject({ consumed: [], discarded: ['u1'] });
    await it.next();
  });

  /**
   * M5 — the settlement sits on the teardown path of every steered turn. An
   * interrupt that never answers (a wedged CLI) would hang the generator, and
   * with it the channel close and the Slack turn. The bound converts that into
   * the safe verdict (discard everything = requeue) and lets teardown continue.
   */
  it('bounds the settlement and discards everything when the interrupt never answers', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      const interrupt = vi.fn(() => new Promise<never>(() => {}));
      installSettlementQuery({ queuedTurnCount: 1, interrupt });

      const framesPromise = runSteeredTurn(['u1', 'u2']);
      await vi.advanceTimersByTimeAsync(STEER_SETTLEMENT_BOUND_MS);
      const frames = await framesPromise;

      expect(frames[2]).toMatchObject({ consumed: [], discarded: ['u1', 'u2'] });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('timed out'), expect.objectContaining({ pushed: 2 }));
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('discards everything when interrupt() throws (no receipt = no proof of consumption)', async () => {
    const interrupt = vi.fn(async () => {
      throw new Error('control request failed');
    });
    installSettlementQuery({ queuedTurnCount: 1, interrupt });

    const frames = await runSteeredTurn(['u1', 'u2']);

    expect(frames[2]).toMatchObject({ consumed: [], discarded: ['u1', 'u2'] });
  });

  it('discards everything when the CLI answers the interrupt with no receipt', async () => {
    const interrupt = vi.fn(async () => undefined);
    installSettlementQuery({ queuedTurnCount: 1, interrupt });

    const frames = await runSteeredTurn(['u1', 'u2']);

    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(frames[2]).toMatchObject({ consumed: [], discarded: ['u1', 'u2'] });
  });

  it('emits no settlement frame for a turn with nothing pushed', async () => {
    const interrupt = vi.fn(async () => ({ still_queued: [], cancelled: [] }));
    installSettlementQuery({ queuedTurnCount: 3, interrupt });

    const frames = await runSteeredTurn([]);

    expect(interrupt).not.toHaveBeenCalled();
    expect(frames.map((f) => (f as { type: string }).type)).toEqual(['system', 'assistant', 'result']);
  });

  it('warns instead of settling when the consumer abandons the turn before its result', async () => {
    // No result frame ever arrives, so no settlement frame can be yielded —
    // the pushed sends are orphaned and the host has to reconcile them.
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      installSettlementQuery({ queuedTurnCount: 0, interrupt: vi.fn() });
      const handler = newHandler();
      const it = handler
        .streamQuery('hello there', undefined, undefined, undefined, undefined, SESSION_KEY)
        [Symbol.asyncIterator]();

      await it.next();
      await it.next();
      handler.steerTurn(SESSION_KEY, { uuid: 'u1', text: 'a' });
      await it.return?.(undefined);

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('unsettled'),
        expect.objectContaining({ count: 1, sessionKey: SESSION_KEY }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('surfaces settlement through the neutral stream as completed/discarded events', async () => {
    const interrupt = vi.fn(async () => ({ still_queued: ['u2'], cancelled: [] }));
    installSettlementQuery({ queuedTurnCount: 1, interrupt });

    const handler = newHandler();
    const events = [];
    const stream = handler
      .streamAgentEvents('hello', undefined, undefined, undefined, undefined, SESSION_KEY)
      [Symbol.asyncIterator]();

    events.push((await stream.next()).value); // session_start
    events.push((await stream.next()).value); // assistant_delta
    handler.steerTurn(SESSION_KEY, { uuid: 'u1', text: 'a' });
    handler.steerTurn(SESSION_KEY, { uuid: 'u2', text: 'b' });
    fake.releaseSteerGate();
    for (;;) {
      const next = await stream.next();
      if (next.done) break;
      events.push(next.value);
    }

    expect(events.filter((e) => (e as { type: string }).type === 'steer_lifecycle')).toEqual([
      { type: 'steer_lifecycle', uuid: 'u1', phase: 'completed' },
      { type: 'steer_lifecycle', uuid: 'u2', phase: 'discarded' },
    ]);
  });
});
