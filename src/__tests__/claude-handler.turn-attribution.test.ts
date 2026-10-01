/**
 * `ClaudeHandler` ends a turn on the `result` that answers it (#257).
 *
 * Resuming a session whose previous CLI exited with background agents still
 * running makes the new CLI drain a "previous session's background agents
 * stopped" task-notification first and close that drain with its own `result`
 * — before it reads the host's prompt. Captured with SDK 0.3.284:
 *
 *   system/task_notification(stopped) → system/init →
 *   result{success, num_turns:0, no user_message_uuid} → system/init →
 *   assistant "PONG" → result{success, num_turns:1, user_message_uuid:<opening uuid>}
 *
 * The handler used to treat the FIRST result as the end of the turn: it closed
 * the input channel and the consumer stopped there, so the prompt was recorded
 * but never answered. The fix stamps a uuid on the opening message and only
 * ends the turn on a result attributed to it (`classifyTurnResult`).
 *
 * The SDK is mocked at the module boundary exactly like
 * `claude-handler.steering.test.ts`, so no CLI child process is spawned.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { ClaudeHandler, NON_TURN_RESULT_IDLE_MS } from '../claude-handler';
import { Logger } from '../logger';
import type { McpManager } from '../mcp-manager';

const SESSION_KEY = 'C123:1700000000.1';

const INIT = { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-test', tools: [] };

const ORPHAN_NOTIFICATION = {
  type: 'system',
  subtype: 'task_notification',
  task_id: 'task-orphan',
  status: 'stopped',
  output_file: '',
  summary: "Previous session's background agents stopped",
  session_id: 'sess-1',
  uuid: 'notification-uuid',
};

/** The drain's own result: success, no turn run, no uuid echoed (SDK 0.3.284). */
const ORPHAN_RESULT = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: '',
  duration_ms: 3,
  duration_api_ms: 0,
  num_turns: 0,
  stop_reason: null,
  session_id: 'sess-1',
  uuid: 'orphan-result-uuid',
};

const PONG = { type: 'assistant', message: { model: 'claude-test', content: [{ type: 'text', text: 'PONG' }] } };

function answerResult(openingUuid: unknown): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'PONG',
    duration_ms: 900,
    duration_api_ms: 850,
    num_turns: 1,
    stop_reason: 'end_turn',
    session_id: 'sess-1',
    uuid: 'answer-result-uuid',
    user_message_uuid: openingUuid,
  };
}

/** Observations the fake CLI records about the input channel it was handed. */
interface FakeCli {
  opening?: Record<string, unknown>;
  received: unknown[];
  /** Was the input still open (a read parked) once the handler pulled past the orphan result? */
  inputOpenAfterOrphan?: boolean;
  /** Did the input stream end after the last frame the fake emitted? */
  inputEnded: boolean;
  /** Settles once the handler has pulled past the orphan result. */
  pulledPastOrphan: Promise<void>;
  markPulledPastOrphan(): void;
  /** Lets the fake emit its answer; opened by the test. */
  openGate(): void;
  gate: Promise<void>;
}

function newFakeCli(): FakeCli {
  let markPulledPastOrphan: () => void = () => {};
  const pulledPastOrphan = new Promise<void>((resolve) => {
    markPulledPastOrphan = resolve;
  });
  let openGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  return { received: [], inputEnded: false, pulledPastOrphan, markPulledPastOrphan, openGate, gate };
}

/** `true` when `p` is still pending after one macrotask (real timers only). */
async function isPending(p: Promise<unknown>): Promise<boolean> {
  let settled = false;
  p.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  return !settled;
}

/**
 * Install a fake `query()` that replays the captured orphan-drain stream.
 *
 * `answer: 'never'` stops after the orphan result and only waits for the
 * input to end (the silence case). `steerAfterOrphan` parks on the gate after
 * PONG and reads one steered message before answering.
 */
function installOrphanDrainQuery(
  cli: FakeCli,
  opts: { answer: 'immediate' | 'gated' | 'never'; steerAfterOrphan?: boolean } = { answer: 'immediate' },
): void {
  queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    const inputs = (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();

    const gen = (async function* () {
      cli.opening = (await inputs.next()).value as Record<string, unknown>;
      cli.received.push(cli.opening);
      yield ORPHAN_NOTIFICATION;
      yield INIT;
      yield ORPHAN_RESULT;
      // Resumed only once the handler asked for the next frame, i.e. after it
      // finished with the orphan result.
      cli.markPulledPastOrphan();

      if (opts.answer === 'never') {
        cli.inputEnded = (await inputs.next()).done === true;
        return;
      }

      if (opts.steerAfterOrphan) {
        yield INIT;
        yield PONG;
        await cli.gate;
        cli.received.push((await inputs.next()).value);
        yield answerResult(cli.opening?.uuid);
        cli.inputEnded = (await inputs.next()).done === true;
        return;
      }

      // A read started now must park: the channel is still open. Its
      // settlement is recorded the moment it happens, so `inputEnded` also
      // catches a close that comes too early (before the answer).
      const probe = inputs.next();
      probe.then((r) => {
        cli.inputEnded = r.done === true;
      });
      if (opts.answer === 'immediate') cli.inputOpenAfterOrphan = await isPending(probe);
      yield INIT;
      yield PONG;
      if (opts.answer === 'gated') await cli.gate;
      yield answerResult(cli.opening?.uuid);
      await probe;
    })();

    return Object.assign(gen, {
      interrupt: vi.fn(async () => ({ still_queued: [], cancelled: [] })),
      cancelAsyncMessage: vi.fn(async () => true),
    });
  });
}

function newHandler(): ClaudeHandler {
  return new ClaudeHandler({ getPluginManager: () => null } as unknown as McpManager);
}

async function collect<T>(it: AsyncIterator<T>): Promise<T[]> {
  const out: T[] = [];
  for (;;) {
    const next = await it.next();
    if (next.done) return out;
    out.push(next.value);
  }
}

function startTurn(handler: ClaudeHandler): AsyncIterator<unknown> {
  return handler
    .streamQuery('ping', undefined, undefined, undefined, undefined, SESSION_KEY)
    [Symbol.asyncIterator]() as AsyncIterator<unknown>;
}

const typeOf = (f: unknown) => (f as { type: string }).type;

describe('ClaudeHandler turn-result attribution (#257)', () => {
  beforeEach(() => {
    queryMock.mockReset();
    releaseMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stamps a fresh uuid on the opening message of every turn', async () => {
    const first = newFakeCli();
    installOrphanDrainQuery(first);
    await collect(startTurn(newHandler()));
    const second = newFakeCli();
    installOrphanDrainQuery(second);
    await collect(startTurn(newHandler()));

    expect(first.opening).toMatchObject({
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'ping' },
    });
    expect(typeof first.opening?.uuid).toBe('string');
    expect((first.opening?.uuid as string).length).toBeGreaterThan(0);
    expect(second.opening?.uuid).not.toBe(first.opening?.uuid);
  });

  it('skips the orphan drain result and ends the turn on the result that answers the prompt', async () => {
    const cli = newFakeCli();
    installOrphanDrainQuery(cli);

    const frames = await collect(startTurn(newHandler()));

    expect(typeof cli.opening?.uuid).toBe('string');
    // The channel survived the orphan result (a read parked) ...
    expect(cli.inputOpenAfterOrphan).toBe(true);
    // ... and was closed by the answering result.
    expect(cli.inputEnded).toBe(true);

    const results = frames.filter((f) => typeOf(f) === 'result');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ result: 'PONG', num_turns: 1, user_message_uuid: cli.opening?.uuid });
    expect(frames).toContainEqual(PONG);
    expect(frames.indexOf(PONG)).toBeLessThan(frames.indexOf(results[0]));
    // Nothing else of the orphan drain is hidden: the notification still flows.
    expect(frames).toContainEqual(ORPHAN_NOTIFICATION);
  });

  it('logs the skipped result with its attribution', async () => {
    const info = vi.spyOn(Logger.prototype, 'info').mockImplementation(() => {});
    try {
      const cli = newFakeCli();
      installOrphanDrainQuery(cli);
      await collect(startTurn(newHandler()));

      expect(info).toHaveBeenCalledWith(
        'Skipping a result that does not answer this turn',
        expect.objectContaining({
          subtype: 'success',
          num_turns: 0,
          user_message_uuid: undefined,
          reason: expect.any(String),
          sessionKey: SESSION_KEY,
        }),
      );
    } finally {
      info.mockRestore();
    }
  });

  it('delivers exactly one terminal result through the neutral event stream', async () => {
    const cli = newFakeCli();
    installOrphanDrainQuery(cli);

    const events = await collect(
      newHandler()
        .streamAgentEvents('ping', undefined, undefined, undefined, undefined, SESSION_KEY)
        [Symbol.asyncIterator](),
    );

    const results = events.filter((e) => (e as { type: string }).type === 'result');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ finalText: 'PONG' });
  });

  it('does not seal the channel on a skipped result: a later steer is accepted and settled', async () => {
    const cli = newFakeCli();
    installOrphanDrainQuery(cli, { answer: 'gated', steerAfterOrphan: true });
    const handler = newHandler();
    const it = startTurn(handler);

    const head: unknown[] = [];
    while (!head.includes(PONG)) head.push((await it.next()).value);
    expect(handler.steerTurn(SESSION_KEY, { uuid: 'u-after-orphan', text: 'and also' })).toBe(true);
    cli.openGate();
    const tail = await collect(it);

    expect(cli.received[1]).toMatchObject({ uuid: 'u-after-orphan' });
    expect(tail.map(typeOf)).toEqual(['system', 'result']);
    expect(tail[0]).toMatchObject({ subtype: STEER_SETTLEMENT_SUBTYPE, consumed: ['u-after-orphan'], discarded: [] });
    expect(cli.inputEnded).toBe(true);
  });

  it('closes the input after NON_TURN_RESULT_IDLE_MS of silence following a skipped result', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      const cli = newFakeCli();
      installOrphanDrainQuery(cli, { answer: 'never' });

      const framesPromise = collect(startTurn(newHandler()));
      await cli.pulledPastOrphan;

      await vi.advanceTimersByTimeAsync(NON_TURN_RESULT_IDLE_MS - 1);
      expect(cli.inputEnded).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      const frames = await framesPromise;

      expect(cli.inputEnded).toBe(true);
      expect(frames.filter((f) => typeOf(f) === 'result')).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('closing the input'),
        expect.objectContaining({ sessionKey: SESSION_KEY, idleMs: NON_TURN_RESULT_IDLE_MS }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('disarms the bound on the next frame and ends normally when the answer arrives later', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      const cli = newFakeCli();
      installOrphanDrainQuery(cli, { answer: 'gated' });
      const it = startTurn(newHandler());

      const head: unknown[] = [];
      while (!head.includes(PONG)) head.push((await it.next()).value);
      // Well past the bound while the turn is visibly alive: no close.
      await vi.advanceTimersByTimeAsync(NON_TURN_RESULT_IDLE_MS * 2);
      expect(cli.inputEnded).toBe(false);

      cli.openGate();
      const tail = await collect(it);

      expect(tail.map(typeOf)).toEqual(['result']);
      expect(tail[0]).toMatchObject({ result: 'PONG', user_message_uuid: cli.opening?.uuid });
      expect(cli.inputEnded).toBe(true);
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('closing the input'), expect.anything());
    } finally {
      warn.mockRestore();
    }
  });
});
