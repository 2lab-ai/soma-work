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

/**
 * A drained `completed` background-task notification can make the model run a
 * turn of its own. That turn really ran (`num_turns: 1`) but answers no host
 * send, so it echoes no `user_message_uuid`.
 */
const BG_TURN_NOTIFICATION = {
  ...ORPHAN_NOTIFICATION,
  task_id: 'task-bg',
  status: 'completed',
  summary: 'Background agent finished',
  uuid: 'bg-notification-uuid',
};
const BG_TURN_RESULT = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'bg agent finished',
  duration_ms: 400,
  duration_api_ms: 380,
  num_turns: 1,
  stop_reason: 'end_turn',
  session_id: 'sess-1',
  uuid: 'bg-result-uuid',
};

/** A metadata-only frame: proof the CLI is alive, with nothing to render. */
const TASK_PROGRESS = {
  type: 'system',
  subtype: 'task_progress',
  task_id: 'task-bg',
  description: 'still working',
  session_id: 'sess-1',
  uuid: 'progress-uuid',
};

/**
 * A subagent's own message: model output, but stamped with the tool_use that
 * spawned the subagent — progress on that subagent, not on the host's prompt.
 */
const SUBAGENT_ASSISTANT = {
  type: 'assistant',
  parent_tool_use_id: 'toolu_x',
  message: { model: 'claude-test', content: [{ type: 'text', text: 'subagent working' }] },
};

const SKIP_TIMEOUT_LOG = 'No turn progress after a skipped result; closing the input so the CLI can exit';

/**
 * Install a fake `query()` that runs `script` — for streams the canned
 * orphan-drain replay above does not cover. `script` gets the input iterator.
 */
function installScriptedQuery(
  script: (inputs: AsyncIterator<unknown>) => AsyncGenerator<unknown, void, unknown>,
): void {
  queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    const inputs = (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    return Object.assign(script(inputs), {
      interrupt: vi.fn(async () => ({ still_queued: [], cancelled: [] })),
      cancelAsyncMessage: vi.fn(async () => true),
    });
  });
}

/** Read the turn's opening send into `cli.opening`. */
async function readOpening(inputs: AsyncIterator<unknown>, cli: FakeCli): Promise<void> {
  cli.opening = (await inputs.next()).value as Record<string, unknown>;
  cli.received.push(cli.opening);
}

/** Start a read that sets `cli.inputEnded` the moment the input ends. */
function watchInputEnd(inputs: AsyncIterator<unknown>, cli: FakeCli): Promise<unknown> {
  const probe = inputs.next();
  probe.then((r) => {
    cli.inputEnded = r.done === true;
  });
  return probe;
}

const skipTimeoutWarnings = (warn: { mock: { calls: unknown[][] } }) =>
  warn.mock.calls.filter(([message]) => message === SKIP_TIMEOUT_LOG);

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

  it("disarms the bound on turn-progress frames (the answering turn's init and assistant) and ends normally when the answer arrives later", async () => {
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

  /**
   * Ran a turn, echoes no uuid: a `num_turns > 0` exemption for uuid-less
   * results would end the turn here — the same failure as the orphan drain,
   * one notification later.
   */
  it('skips a notification-driven turn result (num_turns 1, no uuid) and ends on the answer', async () => {
    const cli = newFakeCli();
    installScriptedQuery(async function* (inputs) {
      await readOpening(inputs, cli);
      yield INIT;
      yield BG_TURN_NOTIFICATION;
      yield BG_TURN_RESULT;
      const probe = watchInputEnd(inputs, cli);
      cli.inputOpenAfterOrphan = await isPending(probe);
      yield INIT;
      yield PONG;
      yield answerResult(cli.opening?.uuid);
      await probe;
    });

    const frames = await collect(startTurn(newHandler()));

    expect(cli.inputOpenAfterOrphan).toBe(true);
    expect(cli.inputEnded).toBe(true);
    const results = frames.filter((f) => typeOf(f) === 'result');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ result: 'PONG', user_message_uuid: cli.opening?.uuid });
    expect(frames).toContainEqual(PONG);
  });

  /**
   * A side-band frame proves the CLI is alive, not that the prompt is being
   * answered: a background agent keeps reporting progress whether or not the
   * host's turn ever starts. If such a frame disarmed the bound, "skipped result
   * → task_progress → silence" would leave the channel open forever.
   */
  it('keeps the bound armed across a metadata-only frame and closes the input after NON_TURN_RESULT_IDLE_MS', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      const cli = newFakeCli();
      installScriptedQuery(async function* (inputs) {
        await readOpening(inputs, cli);
        yield ORPHAN_RESULT;
        const probe = watchInputEnd(inputs, cli);
        yield TASK_PROGRESS;
        cli.markPulledPastOrphan();
        // No turn ever starts. The CLI exits once its input ends, and never
        // yields a result that answers the prompt.
        await probe;
      });

      const framesPromise = collect(startTurn(newHandler()));
      // The handler has yielded the metadata frame and waits on the SDK again.
      await cli.pulledPastOrphan;

      await vi.advanceTimersByTimeAsync(NON_TURN_RESULT_IDLE_MS - 1);
      expect(cli.inputEnded).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(cli.inputEnded).toBe(true);
      expect(skipTimeoutWarnings(warn)).toHaveLength(1);

      const frames = await framesPromise;
      expect(frames.filter((f) => typeOf(f) === 'result')).toHaveLength(0);
      // The metadata frame itself still flows to the consumer.
      expect(frames).toContainEqual(TASK_PROGRESS);
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * The CLI opens every turn with `system`/`init` in streaming input mode, the
   * one right after an orphan drain included: the prompt's turn has started,
   * so the bound is off however long the model then takes.
   */
  it('disarms the bound on a system/init frame after a skipped result', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      const cli = newFakeCli();
      installScriptedQuery(async function* (inputs) {
        await readOpening(inputs, cli);
        yield ORPHAN_RESULT;
        const probe = watchInputEnd(inputs, cli);
        yield INIT;
        cli.markPulledPastOrphan();
        await cli.gate;
        yield answerResult(cli.opening?.uuid);
        await probe;
      });
      const it = startTurn(newHandler());

      expect((await it.next()).value).toEqual(INIT);
      const pending = it.next();
      // The handler is now waiting on the SDK again, with the turn opened.
      await cli.pulledPastOrphan;
      await vi.advanceTimersByTimeAsync(NON_TURN_RESULT_IDLE_MS * 2);

      expect(cli.inputEnded).toBe(false);
      expect(skipTimeoutWarnings(warn)).toHaveLength(0);

      cli.openGate();
      expect((await pending).value).toMatchObject({ type: 'result', user_message_uuid: cli.opening?.uuid });
      expect((await it.next()).done).toBe(true);
      expect(cli.inputEnded).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * A background subagent's own messages flow through the main stream, stamped
   * with its `parent_tool_use_id`. They are model output, but not the host's
   * turn: they must not hold the channel open after a skipped result.
   */
  it('keeps the bound armed across a subagent assistant frame and closes the input after NON_TURN_RESULT_IDLE_MS', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      const cli = newFakeCli();
      installScriptedQuery(async function* (inputs) {
        await readOpening(inputs, cli);
        yield ORPHAN_RESULT;
        const probe = watchInputEnd(inputs, cli);
        yield SUBAGENT_ASSISTANT;
        cli.markPulledPastOrphan();
        // No turn ever starts. The CLI exits once its input ends, and never
        // yields a result that answers the prompt.
        await probe;
      });

      const framesPromise = collect(startTurn(newHandler()));
      // The handler has yielded the subagent frame and waits on the SDK again.
      await cli.pulledPastOrphan;

      await vi.advanceTimersByTimeAsync(NON_TURN_RESULT_IDLE_MS - 1);
      expect(cli.inputEnded).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(cli.inputEnded).toBe(true);
      expect(skipTimeoutWarnings(warn)).toHaveLength(1);

      const frames = await framesPromise;
      expect(frames.filter((f) => typeOf(f) === 'result')).toHaveLength(0);
      // The subagent frame itself still flows to the consumer.
      expect(frames).toContainEqual(SUBAGENT_ASSISTANT);
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * Here the bound is armed while the generator waits on the SDK, so a
   * consumer's `return()` queues behind the pending pull and takes effect when
   * the stream ends. The timer must die with the turn, not fire into a finished
   * one.
   */
  it('clears the bound when the consumer returns while it is armed and the stream then ends', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      const cli = newFakeCli();
      installScriptedQuery(async function* (inputs) {
        await readOpening(inputs, cli);
        yield ORPHAN_RESULT;
        cli.markPulledPastOrphan();
        // The CLI exits on its own: no further frame.
        await cli.gate;
      });
      // The generator itself (not a bare AsyncIterator): `return()` is the
      // consumer action under test.
      const it = newHandler().streamQuery('ping', undefined, undefined, undefined, undefined, SESSION_KEY);

      const pending = it.next();
      await cli.pulledPastOrphan; // the bound is armed now
      const returned = it.return(undefined);
      cli.openGate();

      expect((await pending).done).toBe(true);
      expect((await returned).done).toBe(true);
      await vi.advanceTimersByTimeAsync(NON_TURN_RESULT_IDLE_MS * 2);
      expect(skipTimeoutWarnings(warn)).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * A metadata frame leaves the bound armed, so the generator can sit at that
   * frame's `yield` with the timer running. A consumer's `return()` there runs
   * the handler's cleanup at once: the input ends because the turn ended, and
   * the timer dies with it instead of firing into a finished turn.
   */
  it('clears the bound when the consumer returns at the yield of a metadata frame while it is armed', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      const cli = newFakeCli();
      let inputEnd: Promise<unknown> | undefined;
      installScriptedQuery(async function* (inputs) {
        await readOpening(inputs, cli);
        yield ORPHAN_RESULT;
        inputEnd = watchInputEnd(inputs, cli);
        yield TASK_PROGRESS;
        // Never resumed: the consumer returns while the handler sits at the
        // yield of the frame above.
        await cli.gate;
      });
      const timersBeforeTurn = vi.getTimerCount();
      // The generator itself (not a bare AsyncIterator): `return()` is the
      // consumer action under test.
      const it = newHandler().streamQuery('ping', undefined, undefined, undefined, undefined, SESSION_KEY);

      // The handler is suspended at the metadata frame's yield, bound armed.
      expect((await it.next()).value).toEqual(TASK_PROGRESS);
      expect((await it.return(undefined)).done).toBe(true);

      // Ended by the cleanup before any fake time passed — not by the bound —
      // and no timer of the turn survives it.
      await inputEnd;
      expect(cli.inputEnded).toBe(true);
      expect(vi.getTimerCount()).toBe(timersBeforeTurn);

      await vi.advanceTimersByTimeAsync(NON_TURN_RESULT_IDLE_MS * 2);
      expect(warn).not.toHaveBeenCalled();
      expect((await it.next()).done).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('clears the bound when the stream throws while it is armed', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    try {
      const cli = newFakeCli();
      installScriptedQuery(async function* (inputs) {
        await readOpening(inputs, cli);
        yield ORPHAN_RESULT;
        cli.markPulledPastOrphan();
        await cli.gate;
        throw new Error('aborted by the host');
      });
      const it = startTurn(newHandler());

      const pending = it.next();
      await cli.pulledPastOrphan; // the bound is armed now
      cli.openGate();

      await expect(pending).rejects.toThrow('aborted by the host');
      await vi.advanceTimersByTimeAsync(NON_TURN_RESULT_IDLE_MS * 2);
      expect(skipTimeoutWarnings(warn)).toHaveLength(0);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('re-arms the bound on a second skipped result and fires once, timed from the second', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      const cli = newFakeCli();
      let markSecondPulled: () => void = () => {};
      const secondPulled = new Promise<void>((resolve) => {
        markSecondPulled = resolve;
      });
      installScriptedQuery(async function* (inputs) {
        await readOpening(inputs, cli);
        yield ORPHAN_RESULT;
        cli.markPulledPastOrphan();
        await cli.gate;
        yield { ...ORPHAN_RESULT, uuid: 'orphan-result-uuid-2' };
        markSecondPulled();
        cli.inputEnded = (await inputs.next()).done === true;
      });

      const framesPromise = collect(startTurn(newHandler()));
      await cli.pulledPastOrphan;
      await vi.advanceTimersByTimeAsync(NON_TURN_RESULT_IDLE_MS / 2);
      cli.openGate();
      await secondPulled;

      // The first result's deadline is half a bound away now; it must be gone.
      await vi.advanceTimersByTimeAsync(NON_TURN_RESULT_IDLE_MS - 1);
      expect(cli.inputEnded).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      const frames = await framesPromise;

      expect(cli.inputEnded).toBe(true);
      expect(frames.filter((f) => typeOf(f) === 'result')).toHaveLength(0);
      expect(skipTimeoutWarnings(warn)).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});
