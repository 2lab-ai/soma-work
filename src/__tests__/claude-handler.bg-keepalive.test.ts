/**
 * `ClaudeHandler` keeps a turn open while its background agents run (#257).
 *
 * A turn that launches a `run_in_background` agent answers its opening prompt
 * before the agent finishes. Captured with SDK 0.3.284:
 *
 *   system/init → assistant <tool_use Agent> →
 *   system/background_tasks_changed{tasks:[local_agent]} → system/task_started →
 *   user <tool_result> → assistant "WAITING" →
 *   result{success, num_turns:2, user_message_uuid:<opening uuid>}
 *
 * The handler used to end the turn on that result: it closed the input, the
 * CLI exited, and the agent died with it — the next turn's fresh CLI reports it
 * `stopped`. With the input kept open, the same CLI goes on:
 *
 *   <the subagent's frames, parent_tool_use_id set> →
 *   system/background_tasks_changed{tasks:[]} → system/task_updated →
 *   system/task_notification(completed) → system/init → assistant "NOTIFIED" →
 *   result{success, num_turns:1, no user_message_uuid}
 *
 * So the handler holds the answering result while a background agent is live
 * and ends the turn on the result that follows the agent's report.
 *
 * The SDK is mocked at the module boundary exactly like
 * `claude-handler.turn-attribution.test.ts`, so no CLI child process is spawned.
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
import {
  BG_FOLLOWUP_GRACE_MS,
  BG_KEEPALIVE_HARD_CEILING_FACTOR,
  ClaudeHandler,
  KEEPALIVE_BACKSTOP_IDLE_MS,
  KEEPALIVE_REPORT_TURN_MAX_MS,
  NON_TURN_RESULT_IDLE_MS,
} from '../claude-handler';
import { Logger } from '../logger';
import type { McpManager } from '../mcp-manager';

const SESSION_KEY = 'C123:1700000000.1';
// A turn runs only under an execution context (#597): these turns are Slack turns.
const TEST_SLACK_CONTEXT = { user: 'U_TEST', channel: 'C123', threadTs: '1700000000.1' } as never;
const KEEPALIVE_ENV = 'SOMA_BG_KEEPALIVE_MAX_MS';
/** A cap set through the env, so the cases also prove the knob is read. */
const CAP_MS = 5 * 60_000;

const CAP_LOG = 'Background agents outlived the keepalive cap; stopping them';
const DEFER_LOG = 'Deferring the turn end while background agents run';
const SHELL_DEFER_LOG = 'Deferring the turn end for a follow-up turn of a background task';

const AGENT_ID = 'a2822c53d8b286bbf';
const SECOND_AGENT_ID = 'b7d1e0c4a9f35e210';

const INIT = { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-test', tools: [] };

const assistantText = (text: string) => ({
  type: 'assistant',
  message: { model: 'claude-test', content: [{ type: 'text', text }] },
});

const TOOL_USE_AGENT = {
  type: 'assistant',
  message: {
    model: 'claude-test',
    content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { run_in_background: true } }],
  },
};

const TOOL_RESULT = {
  type: 'user',
  parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_agent', content: 'launched' }] },
};

const WAITING = assistantText('WAITING');
const NOTIFIED = assistantText('NOTIFIED');

/** The live background set after a membership change (REPLACE semantics). */
function level(tasks: Array<Record<string, unknown>>): Record<string, unknown> {
  return { type: 'system', subtype: 'background_tasks_changed', tasks, session_id: 'sess-1', uuid: 'level-uuid' };
}

const agentTask = (taskId: string) => ({ task_id: taskId, task_type: 'local_agent', description: 'sleeper' });

const taskStarted = (taskId: string) => ({
  type: 'system',
  subtype: 'task_started',
  task_id: taskId,
  description: 'sleeper',
  session_id: 'sess-1',
  uuid: `started-${taskId}`,
});

const taskUpdated = (taskId: string) => ({
  type: 'system',
  subtype: 'task_updated',
  task_id: taskId,
  session_id: 'sess-1',
  uuid: `updated-${taskId}`,
});

const taskNotification = (taskId: string, status: string) => ({
  type: 'system',
  subtype: 'task_notification',
  task_id: taskId,
  status,
  output_file: '',
  summary: `agent ${status}`,
  session_id: 'sess-1',
  uuid: `notification-${taskId}-${status}`,
});

/** A background subagent's own message: stamped with the tool_use that spawned it. */
const SUBAGENT_ASSISTANT = {
  type: 'assistant',
  parent_tool_use_id: 'toolu_agent',
  message: { model: 'claude-test', content: [{ type: 'text', text: 'subagent working' }] },
};

function successResult(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 900,
    duration_api_ms: 850,
    stop_reason: 'end_turn',
    terminal_reason: 'completed',
    session_id: 'sess-1',
    ...overrides,
  };
}

/** The result that answers the opening prompt (the turn ran the Agent tool, then said WAITING). */
const openingResult = (openingUuid: unknown) =>
  successResult({ result: 'WAITING', num_turns: 2, uuid: 'opening-result-uuid', user_message_uuid: openingUuid });

/** The turn the agent's completion notification drives: it answers no host send, so no uuid echo. */
const notifiedResult = (overrides: Record<string, unknown> = {}) =>
  successResult({ result: 'NOTIFIED', num_turns: 1, uuid: 'notified-result-uuid', ...overrides });

/** Every frame the opening turn emits before its result, with the given live set. */
function openingTurnHead(tasks: Array<Record<string, unknown>>): Record<string, unknown>[] {
  const started = tasks.map((task) => taskStarted(String(task.task_id)));
  return [INIT, TOOL_USE_AGENT, level(tasks), ...started, TOOL_RESULT, WAITING];
}

/** A drain's own result: success, no turn run, no uuid echoed (SDK 0.3.284). */
const ORPHAN_RESULT = successResult({ result: '', num_turns: 0, uuid: 'orphan-result-uuid', stop_reason: null });

/** Per-process cumulative billing, the shape the CLI reports on every result. */
const modelUsage = (outputTokens: number, cacheReadInputTokens: number, costUSD: number) => ({
  'claude-test': { inputTokens: 12, outputTokens, cacheReadInputTokens, cacheCreationInputTokens: 0, costUSD },
});

const SKIP_LOG = 'Skipping a result that does not answer this turn';
const SETTLED_SILENCE_LOG =
  'No turn progress after the background agents settled; closing the input so the CLI can exit';
const BACKSTOP_LOG = 'The deferred turn did not end after the keepalive cap; closing the query';
const GRACE_LOG = 'No follow-up turn after a background agent settled mid-turn; ending the held turn';

const callsOf = (spy: { mock: { calls: unknown[][] } }, message: string) =>
  spy.mock.calls.filter(([logged]) => logged === message);

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Observations the fake CLI records, plus the control methods the handler may call. */
interface FakeCli {
  opening?: Record<string, unknown>;
  received: unknown[];
  inputEnded: boolean;
  stopTask: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  /** Settles when the handler calls `close()` on the query. */
  closed: Promise<void>;
}

function newFakeCli(): FakeCli {
  const closed = deferred();
  return {
    received: [],
    inputEnded: false,
    stopTask: vi.fn(async (_taskId: string) => {}),
    close: vi.fn(() => closed.resolve()),
    closed: closed.promise,
  };
}

/** Install a fake `query()` that runs `script` against the input iterator. */
function installScriptedQuery(
  cli: FakeCli,
  script: (inputs: AsyncIterator<unknown>) => AsyncGenerator<unknown, void, unknown>,
  interruptReceipt: () => { still_queued: unknown[]; cancelled: unknown[] } = () => ({
    still_queued: [],
    cancelled: [],
  }),
): void {
  queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    const inputs = (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    return Object.assign(script(inputs), {
      interrupt: vi.fn(async () => interruptReceipt()),
      cancelAsyncMessage: vi.fn(async () => true),
      stopTask: cli.stopTask,
      close: cli.close,
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

/** Read every input until it ends, recording each message; resolves when the input ends. */
async function drainInputs(inputs: AsyncIterator<unknown>, cli: FakeCli): Promise<void> {
  for (;;) {
    const next = await inputs.next();
    if (next.done) {
      cli.inputEnded = true;
      return;
    }
    cli.received.push(next.value);
  }
}

/** The text of a user message the host sent into the CLI. */
const textOf = (message: unknown): string => {
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map((c) => (c as { text?: string }).text ?? '').join('') : '';
};

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
    .streamQuery('ping', undefined, undefined, undefined, TEST_SLACK_CONTEXT, SESSION_KEY)
    [Symbol.asyncIterator]() as AsyncIterator<unknown>;
}

const typeOf = (f: unknown) => (f as { type: string }).type;
const resultsOf = (frames: unknown[]) => frames.filter((f) => typeOf(f) === 'result');

describe('ClaudeHandler background-agent keepalive (#257)', () => {
  beforeEach(() => {
    queryMock.mockReset();
    releaseMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('holds the answering result while a background agent runs and ends the turn on the result after its report', async () => {
    const cli = newFakeCli();
    let inputOpenAfterOpening: boolean | undefined;
    installScriptedQuery(cli, async function* (inputs) {
      await readOpening(inputs, cli);
      yield* openingTurnHead([agentTask(AGENT_ID)]);
      yield openingResult(cli.opening?.uuid);
      // Resumed only once the handler asked for the next frame, i.e. after it
      // finished with the answering result.
      const probe = watchInputEnd(inputs, cli);
      inputOpenAfterOpening = await isPending(probe);
      yield SUBAGENT_ASSISTANT;
      yield level([]);
      yield taskUpdated(AGENT_ID);
      yield taskNotification(AGENT_ID, 'completed');
      yield INIT;
      yield NOTIFIED;
      yield notifiedResult();
      await probe;
    });

    const frames = await collect(startTurn(newHandler()));

    // The input survived the answering result ...
    expect(inputOpenAfterOpening).toBe(true);
    // ... and ended after the result that followed the agent's report.
    expect(cli.inputEnded).toBe(true);
    const results = resultsOf(frames);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ result: 'NOTIFIED', num_turns: 1 });
    expect(results[0]).not.toHaveProperty('user_message_uuid');
    // The notification turn's output reaches the consumer before the result.
    expect(frames).toContainEqual(NOTIFIED);
    expect(frames.indexOf(NOTIFIED)).toBeLessThan(frames.indexOf(results[0]));
    // Everything else still flows.
    expect(frames).toContainEqual(WAITING);
    expect(frames).toContainEqual(SUBAGENT_ASSISTANT);
    expect(frames).toContainEqual(taskNotification(AGENT_ID, 'completed'));
  });

  it('keeps the turn deferred across a steer answered while the agent runs, and settles the steer as consumed', async () => {
    const cli = newFakeCli();
    const pulledPastOpening = deferred();
    const steerGate = deferred();
    let inputOpenAfterSteerResult: boolean | undefined;
    installScriptedQuery(cli, async function* (inputs) {
      await readOpening(inputs, cli);
      yield* openingTurnHead([agentTask(AGENT_ID)]);
      yield openingResult(cli.opening?.uuid);
      pulledPastOpening.resolve();
      await steerGate.promise;
      // The steer starts a turn of its own: the CLI is idle between turns.
      cli.received.push((await inputs.next()).value);
      yield INIT;
      yield assistantText('ACK');
      yield successResult({
        result: 'ACK',
        num_turns: 1,
        uuid: 'steer-result-uuid',
        user_message_uuid: 'u-steer',
        queued_turn_count: 0,
      });
      const probe = watchInputEnd(inputs, cli);
      inputOpenAfterSteerResult = await isPending(probe);
      yield level([]);
      yield taskNotification(AGENT_ID, 'completed');
      yield INIT;
      yield NOTIFIED;
      yield notifiedResult({ queued_turn_count: 0 });
      await probe;
    });
    const handler = newHandler();

    const framesPromise = collect(startTurn(handler));
    await pulledPastOpening.promise;
    // Deferred, not settled: the channel is neither sealed nor closed.
    expect(handler.steerTurn(SESSION_KEY, { uuid: 'u-steer', text: 'and also' })).toBe(true);
    steerGate.resolve();
    const frames = await framesPromise;

    expect(cli.received[1]).toMatchObject({ uuid: 'u-steer' });
    // The steer's own result neither ended the turn nor reached the consumer.
    expect(inputOpenAfterSteerResult).toBe(true);
    expect(frames.some((f) => (f as { user_message_uuid?: unknown }).user_message_uuid === 'u-steer')).toBe(false);
    const results = resultsOf(frames);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ result: 'NOTIFIED' });
    const settlement = frames.find((f) => (f as { subtype?: unknown }).subtype === STEER_SETTLEMENT_SUBTYPE);
    expect(settlement).toMatchObject({ consumed: ['u-steer'], discarded: [] });
    expect(frames.indexOf(settlement)).toBeLessThan(frames.indexOf(results[0]));
    expect(cli.inputEnded).toBe(true);
  });

  it('stops every live agent at the keepalive cap, ends the input, and ends the turn on the result that follows', async () => {
    vi.useFakeTimers();
    vi.stubEnv(KEEPALIVE_ENV, String(CAP_MS));
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      const cli = newFakeCli();
      const pulledPastOpening = deferred();
      installScriptedQuery(cli, async function* (inputs) {
        await readOpening(inputs, cli);
        yield* openingTurnHead([agentTask(AGENT_ID), agentTask(SECOND_AGENT_ID)]);
        yield openingResult(cli.opening?.uuid);
        const drained = drainInputs(inputs, cli);
        pulledPastOpening.resolve();
        // Silent until the input ends.
        await drained;
        yield taskNotification(AGENT_ID, 'stopped');
        yield taskNotification(SECOND_AGENT_ID, 'stopped');
        yield level([]);
        yield INIT;
        yield assistantText('STOPPED');
        yield notifiedResult({ result: 'STOPPED', uuid: 'stopped-result-uuid' });
      });

      const framesPromise = collect(startTurn(newHandler()));
      await pulledPastOpening.promise;

      await vi.advanceTimersByTimeAsync(CAP_MS - 1);
      expect(cli.stopTask).not.toHaveBeenCalled();
      expect(cli.inputEnded).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      const frames = await framesPromise;

      expect(cli.stopTask).toHaveBeenCalledTimes(2);
      expect(cli.stopTask).toHaveBeenCalledWith(AGENT_ID);
      expect(cli.stopTask).toHaveBeenCalledWith(SECOND_AGENT_ID);
      expect(cli.inputEnded).toBe(true);
      // #1039: before the input closed, the host told the model that it — not the
      // user — stopped them (the CLI words every stopTask "was stopped by user").
      const note = cli.received.slice(1).map(textOf).join('\n');
      expect(note).toContain('[host: keepalive cap]');
      expect(note).toContain(AGENT_ID);
      expect(note).toContain(SECOND_AGENT_ID);
      expect(note).toMatch(/The user did not stop/);
      expect(note).toMatch(/"was stopped by user"/);
      expect(warn).toHaveBeenCalledWith(
        CAP_LOG,
        expect.objectContaining({ live: 2, maxMs: CAP_MS, sessionKey: SESSION_KEY }),
      );
      const results = resultsOf(frames);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ result: 'STOPPED' });
      // #1010 review (astra P2) — the host stopped these on purpose: not "stopped with the turn".
      const capStops = (frames as Array<Record<string, unknown>>).filter((f) => f.subtype === 'task_notification');
      expect(capStops.length).toBeGreaterThan(0);
      for (const f of capStops) expect(f.soma_ended_with_turn).toBeUndefined();

      // The turn ended: the backstop never fires into it.
      await vi.advanceTimersByTimeAsync(NON_TURN_RESULT_IDLE_MS * 2);
      expect(cli.close).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * The CLI reports `modelUsage` and `total_cost_usd` cumulatively per process
   * (the subagent's spend included) and `usage` per turn — measured on the real
   * CLI: output 354 then 83 per turn, while cache reads went 163938 → 435235
   * and cost 0.196 → 0.227. The mapper bills from `modelUsage` first, so the
   * one result a held turn yields must be the LATEST: it already carries the
   * whole turn's spend, and yielding the earlier one too would double-count.
   */
  it('yields only the latest result of a held turn, carrying the cumulative modelUsage', async () => {
    const install = (cli: FakeCli, emitted: Record<string, unknown>[]) =>
      installScriptedQuery(cli, async function* (inputs) {
        await readOpening(inputs, cli);
        yield* openingTurnHead([agentTask(AGENT_ID)]);
        const answered = {
          ...openingResult(cli.opening?.uuid),
          usage: { input_tokens: 6, output_tokens: 354 },
          modelUsage: modelUsage(354, 163_938, 0.196),
          total_cost_usd: 0.196,
        };
        emitted.push(answered);
        yield answered;
        const probe = watchInputEnd(inputs, cli);
        yield level([]);
        yield taskNotification(AGENT_ID, 'completed');
        yield INIT;
        yield NOTIFIED;
        const latest = notifiedResult({
          usage: { input_tokens: 6, output_tokens: 83 },
          modelUsage: modelUsage(437, 435_235, 0.227),
          total_cost_usd: 0.227,
        });
        emitted.push(latest);
        yield latest;
        await probe;
      });

    // The raw stream: exactly one result, and it is the latest frame itself.
    const emitted: Record<string, unknown>[] = [];
    install(newFakeCli(), emitted);
    const frames = await collect(startTurn(newHandler()));
    expect(emitted).toHaveLength(2);
    const results = resultsOf(frames);
    expect(results).toHaveLength(1);
    expect(results[0]).toBe(emitted[1]);
    expect(results[0]).toMatchObject({
      total_cost_usd: 0.227,
      modelUsage: { 'claude-test': { outputTokens: 437, cacheReadInputTokens: 435_235, costUSD: 0.227 } },
    });

    // The neutral stream bills that one result's cumulative modelUsage, once.
    install(newFakeCli(), []);
    const events = await collect(
      newHandler()
        .streamAgentEvents('ping', undefined, undefined, undefined, TEST_SLACK_CONTEXT, SESSION_KEY)
        [Symbol.asyncIterator](),
    );
    const usageEvents = events.filter((e) => typeOf(e) === 'usage');
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      usage: { outputTokens: 437, cacheReadInputTokens: 435_235, totalCostUsd: 0.227 },
    });
    const resultEvents = events.filter((e) => typeOf(e) === 'result');
    expect(resultEvents).toHaveLength(1);
    expect(resultEvents[0]).toMatchObject({ finalText: 'NOTIFIED' });
  });

  /** Install a turn that answers with `tasks` live and then only waits for its input to end. */
  function installAnswerThenWait(cli: FakeCli, tasks: Array<Record<string, unknown>>): void {
    installScriptedQuery(cli, async function* (inputs) {
      await readOpening(inputs, cli);
      yield* openingTurnHead(tasks);
      yield openingResult(cli.opening?.uuid);
      cli.inputEnded = (await inputs.next()).done === true;
    });
  }

  it('does not hold the turn for ambient agents', async () => {
    const info = vi.spyOn(Logger.prototype, 'info').mockImplementation(() => {});
    try {
      const cli = newFakeCli();
      installAnswerThenWait(cli, [
        { task_id: 'watch-1', task_type: 'local_agent', description: 'watcher', ambient: true },
      ]);

      const frames = await collect(startTurn(newHandler()));

      expect(cli.inputEnded).toBe(true);
      const results = resultsOf(frames);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ result: 'WAITING', user_message_uuid: cli.opening?.uuid });
      expect(callsOf(info, DEFER_LOG)).toHaveLength(0);
      expect(callsOf(info, SHELL_DEFER_LOG)).toHaveLength(0);
    } finally {
      info.mockRestore();
    }
  });

  // #997: a live shell or workflow never holds a turn for its lifetime — only for
  // the follow-up grace, long enough to read a notification turn the CLI already
  // started. Then the input closes as before, though the shell is still live.
  it('holds the answer of a turn with live shells or workflows only for the follow-up grace (#997)', async () => {
    vi.useFakeTimers();
    vi.stubEnv(KEEPALIVE_ENV, String(CAP_MS));
    const info = vi.spyOn(Logger.prototype, 'info').mockImplementation(() => {});
    try {
      const cli = newFakeCli();
      const pulledPastOpening = deferred();
      installScriptedQuery(cli, async function* (inputs) {
        await readOpening(inputs, cli);
        yield* openingTurnHead([
          { task_id: 'bash-1', task_type: 'local_bash', description: 'dev server' },
          { task_id: 'flow-1', task_type: 'local_workflow', description: 'workflow' },
        ]);
        yield openingResult(cli.opening?.uuid);
        const probe = watchInputEnd(inputs, cli);
        pulledPastOpening.resolve();
        await probe;
      });

      const framesPromise = collect(startTurn(newHandler()));
      await pulledPastOpening.promise;

      await vi.advanceTimersByTimeAsync(BG_FOLLOWUP_GRACE_MS - 1);
      expect(cli.inputEnded).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      const frames = await framesPromise;

      expect(cli.inputEnded).toBe(true);
      const results = resultsOf(frames);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ result: 'WAITING', user_message_uuid: cli.opening?.uuid });
      // Not the agent hold: no keepalive cap fires for a shell.
      expect(callsOf(info, DEFER_LOG)).toHaveLength(0);
      expect(callsOf(info, SHELL_DEFER_LOG)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(CAP_MS + NON_TURN_RESULT_IDLE_MS * 2);
      expect(cli.stopTask).not.toHaveBeenCalled();
      expect(cli.close).not.toHaveBeenCalled();
    } finally {
      info.mockRestore();
    }
  });

  it('does not hold the turn when SOMA_BG_KEEPALIVE_MAX_MS is 0', async () => {
    vi.stubEnv(KEEPALIVE_ENV, '0');
    const info = vi.spyOn(Logger.prototype, 'info').mockImplementation(() => {});
    try {
      const cli = newFakeCli();
      installAnswerThenWait(cli, [agentTask(AGENT_ID)]);

      const frames = await collect(startTurn(newHandler()));

      expect(cli.inputEnded).toBe(true);
      const results = resultsOf(frames);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ result: 'WAITING', user_message_uuid: cli.opening?.uuid });
      expect(callsOf(info, DEFER_LOG)).toHaveLength(0);
      expect(cli.stopTask).not.toHaveBeenCalled();
    } finally {
      info.mockRestore();
    }
  });

  it('ends a held turn at once on an error result, with that result', async () => {
    const cli = newFakeCli();
    const errorResult = {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      num_turns: 1,
      errors: ['boom'],
      session_id: 'sess-1',
      uuid: 'error-result-uuid',
    };
    installScriptedQuery(cli, async function* (inputs) {
      await readOpening(inputs, cli);
      yield* openingTurnHead([agentTask(AGENT_ID)]);
      yield openingResult(cli.opening?.uuid);
      const probe = watchInputEnd(inputs, cli);
      yield INIT;
      // The agent is still live: only the error ends the turn.
      yield errorResult;
      await probe;
    });

    const frames = await collect(startTurn(newHandler()));

    expect(cli.inputEnded).toBe(true);
    const results = resultsOf(frames);
    expect(results).toEqual([errorResult]);
    expect(cli.stopTask).not.toHaveBeenCalled();
  });

  /**
   * Zero parent turns is not zero spend: while the parent waited, the
   * subagent's work kept accumulating in the per-process `modelUsage` and
   * `total_cost_usd`. A `num_turns: 0` result answers nothing, so the text of
   * the turn stays the held answer's — but its accounting is the freshest.
   */
  it('finalizes on a zero-turn result with its cumulative accounting and the held answer text', async () => {
    const install = (cli: FakeCli) =>
      installScriptedQuery(cli, async function* (inputs) {
        await readOpening(inputs, cli);
        yield* openingTurnHead([agentTask(AGENT_ID)]);
        yield {
          ...openingResult(cli.opening?.uuid),
          modelUsage: modelUsage(354, 163_938, 0.196),
          total_cost_usd: 0.196,
        };
        const probe = watchInputEnd(inputs, cli);
        yield level([]);
        yield taskNotification(AGENT_ID, 'completed');
        yield INIT;
        // Ran no parent turn, but the subagent's spend accumulated.
        yield {
          ...ORPHAN_RESULT,
          uuid: 'zero-turn-result-uuid',
          modelUsage: modelUsage(500, 435_235, 0.227),
          total_cost_usd: 0.227,
        };
        await probe;
      });

    // The raw stream: one result — the latest accounting, the answer's text.
    const cli = newFakeCli();
    install(cli);
    const frames = await collect(startTurn(newHandler()));
    expect(cli.inputEnded).toBe(true);
    const results = resultsOf(frames);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      result: 'WAITING',
      stop_reason: 'end_turn',
      uuid: 'zero-turn-result-uuid',
      total_cost_usd: 0.227,
      modelUsage: { 'claude-test': { outputTokens: 500, cacheReadInputTokens: 435_235, costUSD: 0.227 } },
    });

    // The neutral stream bills the latest cumulative values once, and shows the answer.
    install(newFakeCli());
    const events = await collect(
      newHandler()
        .streamAgentEvents('ping', undefined, undefined, undefined, TEST_SLACK_CONTEXT, SESSION_KEY)
        [Symbol.asyncIterator](),
    );
    const usageEvents = events.filter((e) => typeOf(e) === 'usage');
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      usage: { outputTokens: 500, cacheReadInputTokens: 435_235, totalCostUsd: 0.227 },
    });
    const resultEvents = events.filter((e) => typeOf(e) === 'result');
    expect(resultEvents).toHaveLength(1);
    expect(resultEvents[0]).toMatchObject({ finalText: 'WAITING' });
  });

  /**
   * The settlement reads `queued_turn_count`, so it must read the freshest
   * result: here the steer is still queued when a zero-turn result ends the
   * held turn, while the held answer (captured before the steer) says nothing
   * is queued. Settling against the answer would claim the steer ran.
   */
  it('settles a held turn against the latest result, whose queue state is the freshest', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      const cli = newFakeCli();
      const pulledPastOpening = deferred();
      const steerGate = deferred();
      installScriptedQuery(cli, async function* (inputs) {
        await readOpening(inputs, cli);
        yield* openingTurnHead([agentTask(AGENT_ID)]);
        yield openingResult(cli.opening?.uuid);
        pulledPastOpening.resolve();
        await steerGate.promise;
        // The steer sits in the CLI's queue, unread, when the zero-turn result comes.
        yield level([]);
        yield taskNotification(AGENT_ID, 'completed');
        yield INIT;
        yield { ...ORPHAN_RESULT, uuid: 'zero-turn-result-uuid', queued_turn_count: 1 };
      });
      const handler = newHandler();

      const framesPromise = collect(startTurn(handler));
      await pulledPastOpening.promise;
      expect(handler.steerTurn(SESSION_KEY, { uuid: 'u-queued', text: 'and this' })).toBe(true);
      steerGate.resolve();
      const frames = await framesPromise;

      const settlement = frames.find((f) => (f as { subtype?: unknown }).subtype === STEER_SETTLEMENT_SUBTYPE);
      expect(settlement).toMatchObject({ consumed: [], discarded: ['u-queued'] });
      const results = resultsOf(frames);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ result: 'WAITING', queued_turn_count: 1 });
    } finally {
      warn.mockRestore();
    }
  });

  it('closes the query when the CLI stays silent past the cap backstop, then yields the held result and discards a later steer', async () => {
    vi.useFakeTimers();
    vi.stubEnv(KEEPALIVE_ENV, String(CAP_MS));
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      const cli = newFakeCli();
      const pulledPastOpening = deferred();
      installScriptedQuery(cli, async function* (inputs) {
        await readOpening(inputs, cli);
        yield* openingTurnHead([agentTask(AGENT_ID)]);
        yield openingResult(cli.opening?.uuid);
        pulledPastOpening.resolve();
        // Wedged: reads nothing more and answers nothing; the stream ends only
        // when the query is closed.
        await cli.closed;
      });
      const handler = newHandler();

      const framesPromise = collect(startTurn(handler));
      await pulledPastOpening.promise;
      // Pushed after the held result was captured: that result cannot account for it.
      expect(handler.steerTurn(SESSION_KEY, { uuid: 'u-late', text: 'still there?' })).toBe(true);

      await vi.advanceTimersByTimeAsync(CAP_MS);
      expect(cli.stopTask).toHaveBeenCalledTimes(1);
      expect(cli.stopTask).toHaveBeenCalledWith(AGENT_ID);
      expect(cli.close).not.toHaveBeenCalled();

      // #1041 review: a report's long model call is not cut at 60 s.
      await vi.advanceTimersByTimeAsync(KEEPALIVE_BACKSTOP_IDLE_MS - 1);
      expect(cli.close).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(cli.close).toHaveBeenCalledTimes(1);
      const frames = await framesPromise;

      expect(callsOf(warn, BACKSTOP_LOG)).toHaveLength(1);
      const results = resultsOf(frames);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ result: 'WAITING', user_message_uuid: cli.opening?.uuid });
      const settlement = frames.find((f) => (f as { subtype?: unknown }).subtype === STEER_SETTLEMENT_SUBTYPE);
      expect(settlement).toMatchObject({ consumed: [], discarded: ['u-late'] });
      expect(frames.indexOf(settlement)).toBeLessThan(frames.indexOf(results[0]));
    } finally {
      warn.mockRestore();
    }
  });

  it('closes the input when no turn follows the live set emptying, then yields the held result', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      const cli = newFakeCli();
      const pulledPastMetadata = deferred();
      installScriptedQuery(cli, async function* (inputs) {
        await readOpening(inputs, cli);
        yield* openingTurnHead([agentTask(AGENT_ID)]);
        yield openingResult(cli.opening?.uuid);
        const probe = watchInputEnd(inputs, cli);
        yield SUBAGENT_ASSISTANT;
        yield level([]);
        // Metadata only: none of these shows a turn running.
        yield taskUpdated(AGENT_ID);
        yield taskNotification(AGENT_ID, 'completed');
        pulledPastMetadata.resolve();
        // No notification turn ever starts; the CLI exits once its input ends.
        await probe;
      });

      const framesPromise = collect(startTurn(newHandler()));
      await pulledPastMetadata.promise;

      await vi.advanceTimersByTimeAsync(NON_TURN_RESULT_IDLE_MS - 1);
      expect(cli.inputEnded).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      const frames = await framesPromise;

      expect(cli.inputEnded).toBe(true);
      expect(callsOf(warn, SETTLED_SILENCE_LOG)).toHaveLength(1);
      expect(callsOf(warn, CAP_LOG)).toHaveLength(0);
      const results = resultsOf(frames);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ result: 'WAITING', user_message_uuid: cli.opening?.uuid });
      expect(cli.stopTask).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  // #966 live probe (dev 2026-11-06 04:13Z): a held turn closes the input and reads on until the CLI
  // exits — and the CLI stops its background shells as it does, reporting them `stopped`. Those reports
  // are the turn's end, not a stop the model asked for: mark them so the host can say so.
  it('marks a stop that arrives after the host closed the input as ended with the turn', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      const cli = newFakeCli();
      const pulledPastMetadata = deferred();
      installScriptedQuery(cli, async function* (inputs) {
        await readOpening(inputs, cli);
        yield* openingTurnHead([agentTask(AGENT_ID)]);
        yield openingResult(cli.opening?.uuid);
        const probe = watchInputEnd(inputs, cli);
        yield level([]);
        yield taskNotification(AGENT_ID, 'completed');
        pulledPastMetadata.resolve();
        await probe;
        // The CLI exits: it stops the shell it still ran.
        yield taskNotification('shell-1', 'stopped');
      });

      const framesPromise = collect(startTurn(newHandler()));
      await pulledPastMetadata.promise;
      await vi.advanceTimersByTimeAsync(NON_TURN_RESULT_IDLE_MS);
      const frames = (await framesPromise) as Array<Record<string, unknown>>;

      const notice = (id: string) => frames.find((f) => f.subtype === 'task_notification' && f.task_id === id);
      expect(notice('shell-1')).toMatchObject({ status: 'stopped', soma_ended_with_turn: true });
      expect(notice(AGENT_ID)?.soma_ended_with_turn).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  // #1010 review (astra P1) — the input can be closed while the CLI still runs a turn; a stop the MODEL
  // asked for (TaskStop / KillShell) in that turn is no stop "with the turn" and must not be marked.
  it('does not mark a stop the model asked for, even when it arrives after the input closed', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      const cli = newFakeCli();
      const pulledPastMetadata = deferred();
      installScriptedQuery(cli, async function* (inputs) {
        await readOpening(inputs, cli);
        yield* openingTurnHead([agentTask(AGENT_ID)]);
        yield openingResult(cli.opening?.uuid);
        const probe = watchInputEnd(inputs, cli);
        yield level([]);
        yield taskNotification(AGENT_ID, 'completed');
        pulledPastMetadata.resolve();
        await probe;
        // A turn still runs after the input closed: the model stops its own shells.
        yield {
          type: 'assistant',
          message: {
            model: 'claude-test',
            content: [
              { type: 'tool_use', id: 'toolu_stop', name: 'TaskStop', input: { task_id: 'shell-asked' } },
              { type: 'tool_use', id: 'toolu_kill', name: 'KillShell', input: { shell_id: 'shell-killed' } },
            ],
          },
        };
        yield {
          type: 'user',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_stop', content: '{"task_id":"shell-asked"}' },
              { type: 'tool_result', tool_use_id: 'toolu_kill', content: 'Successfully killed shell: shell-killed' },
            ],
          },
        };
        yield taskNotification('shell-asked', 'stopped');
        yield taskNotification('shell-killed', 'stopped');
        // And the CLI's exit still stops one it never asked about.
        yield taskNotification('shell-exit', 'stopped');
      });

      const framesPromise = collect(startTurn(newHandler()));
      await pulledPastMetadata.promise;
      await vi.advanceTimersByTimeAsync(NON_TURN_RESULT_IDLE_MS);
      const frames = (await framesPromise) as Array<Record<string, unknown>>;

      const notice = (id: string) => frames.find((f) => f.subtype === 'task_notification' && f.task_id === id);
      expect(notice('shell-asked')?.soma_ended_with_turn).toBeUndefined();
      expect(notice('shell-killed')?.soma_ended_with_turn).toBeUndefined();
      expect(notice('shell-exit')).toMatchObject({ soma_ended_with_turn: true });
    } finally {
      warn.mockRestore();
    }
  });

  // #1010 review (astra r4) — TaskStop takes a NAME too ("named background agents are also accepted by
  // agent ID or name"); its result names the task it stopped. Tie the stop to that id, and while a stop
  // is still unanswered, mark nothing (its settle can come before its result).
  describe('a TaskStop by name', () => {
    const stopByName = {
      type: 'assistant',
      message: {
        model: 'claude-test',
        content: [{ type: 'tool_use', id: 'toolu_stop_named', name: 'TaskStop', input: { task_id: 'reviewer' } }],
      },
    };
    const stopResult = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_stop_named',
            content:
              '{"message":"Successfully stopped task: a123 (reviewer)","task_id":"a123","task_type":"local_agent"}',
          },
        ],
      },
    };

    async function framesOf(afterClose: Array<Record<string, unknown>>) {
      vi.useFakeTimers();
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      try {
        const cli = newFakeCli();
        const pulledPastMetadata = deferred();
        installScriptedQuery(cli, async function* (inputs) {
          await readOpening(inputs, cli);
          yield* openingTurnHead([agentTask(AGENT_ID)]);
          yield openingResult(cli.opening?.uuid);
          const probe = watchInputEnd(inputs, cli);
          yield level([]);
          yield taskNotification(AGENT_ID, 'completed');
          pulledPastMetadata.resolve();
          await probe;
          for (const frame of afterClose) yield frame;
        });
        const framesPromise = collect(startTurn(newHandler()));
        await pulledPastMetadata.promise;
        await vi.advanceTimersByTimeAsync(NON_TURN_RESULT_IDLE_MS);
        return (await framesPromise) as Array<Record<string, unknown>>;
      } finally {
        warn.mockRestore();
      }
    }
    const notice = (frames: Array<Record<string, unknown>>, id: string) =>
      frames.find((f) => f.subtype === 'task_notification' && f.task_id === id);

    it('the stop its result names is not marked (result before the settle)', async () => {
      const frames = await framesOf([stopByName, stopResult, taskNotification('a123', 'stopped')]);
      expect(notice(frames, 'a123')?.soma_ended_with_turn).toBeUndefined();
    });

    it('a settle that comes while the stop is unanswered is not marked (settle before the result)', async () => {
      const frames = await framesOf([stopByName, taskNotification('a123', 'stopped'), stopResult]);
      expect(notice(frames, 'a123')?.soma_ended_with_turn).toBeUndefined();
    });

    it('once answered, the exit stop of another task is still marked', async () => {
      const frames = await framesOf([
        stopByName,
        stopResult,
        taskNotification('a123', 'stopped'),
        taskNotification('shell-exit', 'stopped'),
      ]);
      expect(notice(frames, 'shell-exit')).toMatchObject({ soma_ended_with_turn: true });
    });
  });

  it('still skips an orphan drain result while an agent is live, and holds the turn only from its answer', async () => {
    const info = vi.spyOn(Logger.prototype, 'info').mockImplementation(() => {});
    try {
      const cli = newFakeCli();
      let inputOpenAfterOrphan: boolean | undefined;
      let deferralsAfterOrphan: number | undefined;
      installScriptedQuery(cli, async function* (inputs) {
        await readOpening(inputs, cli);
        // A live agent before any answer: a deferral would be possible here.
        yield level([agentTask(AGENT_ID)]);
        yield ORPHAN_RESULT;
        const probe = watchInputEnd(inputs, cli);
        inputOpenAfterOrphan = await isPending(probe);
        deferralsAfterOrphan = callsOf(info, DEFER_LOG).length;
        yield* openingTurnHead([agentTask(AGENT_ID)]);
        yield openingResult(cli.opening?.uuid);
        yield level([]);
        yield INIT;
        yield NOTIFIED;
        yield notifiedResult();
        await probe;
      });

      const frames = await collect(startTurn(newHandler()));

      // The orphan result was skipped (PR1) — the input stayed open — and did
      // not start a deferral.
      expect(inputOpenAfterOrphan).toBe(true);
      expect(deferralsAfterOrphan).toBe(0);
      expect(callsOf(info, SKIP_LOG)).toHaveLength(1);
      // The answer did.
      expect(callsOf(info, DEFER_LOG)).toHaveLength(1);
      expect(cli.inputEnded).toBe(true);
      const results = resultsOf(frames);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ result: 'NOTIFIED' });
    } finally {
      info.mockRestore();
    }
  });

  /**
   * A closed input already ends the CLI, agents included: holding the answer
   * then would only delay it. Here the skip bound closed the input before the
   * (still running) CLI answered.
   */
  it('does not hold an answer that arrives after the input was already closed', async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(Logger.prototype, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      const cli = newFakeCli();
      const pulledPastOrphan = deferred();
      installScriptedQuery(cli, async function* (inputs) {
        await readOpening(inputs, cli);
        yield ORPHAN_RESULT;
        const probe = watchInputEnd(inputs, cli);
        pulledPastOrphan.resolve();
        // Silent until the skip bound closes the input; the turn then still runs.
        await probe;
        yield* openingTurnHead([agentTask(AGENT_ID)]);
        yield openingResult(cli.opening?.uuid);
      });

      const framesPromise = collect(startTurn(newHandler()));
      await pulledPastOrphan.promise;
      await vi.advanceTimersByTimeAsync(NON_TURN_RESULT_IDLE_MS);
      const frames = await framesPromise;

      expect(cli.inputEnded).toBe(true);
      const results = resultsOf(frames);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ result: 'WAITING', user_message_uuid: cli.opening?.uuid });
      expect(callsOf(info, DEFER_LOG)).toHaveLength(0);
      expect(cli.stopTask).not.toHaveBeenCalled();
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });

  /**
   * An agent can settle DURING a later turn (real CLI, SDK 0.3.284). If that
   * turn then crosses a tool boundary, the CLI folds the notification into it
   * and runs no follow-up turn. If it only generates text, the CLI runs a
   * separate notification turn right after that turn's result (9 ms later) —
   * and the result says `queued_turn_count: 0` either way. So a result that
   * comes after the agent settled within its own turn does not end the held
   * turn: the handler gives the follow-up turn a short grace.
   */
  const STEER_RESULT = successResult({
    result: 'one two three',
    num_turns: 1,
    uuid: 'steer-result-uuid',
    user_message_uuid: 'u-steer',
    queued_turn_count: 0,
  });

  interface SettleGates {
    pulledPastOpening: Deferred;
    steerGate: Deferred;
    pulledPastLastResult: Deferred;
    inputOpenAfterLastResult?: boolean;
  }

  const newGates = (): SettleGates => ({
    pulledPastOpening: deferred(),
    steerGate: deferred(),
    pulledPastLastResult: deferred(),
  });

  /**
   * A held turn whose agent settles inside the steered turn; `followUp` = the
   * CLI then runs a notification turn. `afterSettle` frames come between the
   * settle and the steered result.
   */
  function installSettleDuringSteer(
    cli: FakeCli,
    gates: SettleGates,
    followUp: boolean,
    afterSettle: Record<string, unknown>[] = [],
  ): void {
    installScriptedQuery(cli, async function* (inputs) {
      await readOpening(inputs, cli);
      yield* openingTurnHead([agentTask(AGENT_ID)]);
      yield openingResult(cli.opening?.uuid);
      gates.pulledPastOpening.resolve();
      await gates.steerGate.promise;
      cli.received.push((await inputs.next()).value);
      // The steer's turn starts; the agent settles while it runs.
      yield INIT;
      yield SUBAGENT_ASSISTANT;
      yield level([]);
      yield taskUpdated(AGENT_ID);
      yield taskNotification(AGENT_ID, 'completed');
      yield* afterSettle;
      yield assistantText('one two three');
      yield STEER_RESULT;
      const probe = watchInputEnd(inputs, cli);
      gates.pulledPastLastResult.resolve();
      if (followUp) {
        gates.inputOpenAfterLastResult = await isPending(probe);
        yield INIT;
        yield NOTIFIED;
        yield notifiedResult({ queued_turn_count: 0 });
      }
      await probe;
    });
  }

  /** The agent starts AND settles inside the opening turn, before its answer. */
  function installSettleInsideOpening(cli: FakeCli, gates: SettleGates, followUp: boolean): void {
    installScriptedQuery(cli, async function* (inputs) {
      await readOpening(inputs, cli);
      yield INIT;
      yield TOOL_USE_AGENT;
      yield level([agentTask(AGENT_ID)]);
      yield taskStarted(AGENT_ID);
      yield TOOL_RESULT;
      yield SUBAGENT_ASSISTANT;
      yield level([]);
      yield taskUpdated(AGENT_ID);
      yield taskNotification(AGENT_ID, 'completed');
      yield WAITING;
      yield openingResult(cli.opening?.uuid);
      const probe = watchInputEnd(inputs, cli);
      gates.pulledPastLastResult.resolve();
      if (followUp) {
        gates.inputOpenAfterLastResult = await isPending(probe);
        yield INIT;
        yield NOTIFIED;
        yield notifiedResult();
      }
      await probe;
    });
  }

  it('waits for the follow-up turn of an agent that settled during a steered turn, and ends on its result', async () => {
    const cli = newFakeCli();
    const gates = newGates();
    installSettleDuringSteer(cli, gates, true);
    const handler = newHandler();

    const framesPromise = collect(startTurn(handler));
    await gates.pulledPastOpening.promise;
    expect(handler.steerTurn(SESSION_KEY, { uuid: 'u-steer', text: 'count to ten' })).toBe(true);
    gates.steerGate.resolve();
    const frames = await framesPromise;

    // The steered result did not end the turn ...
    expect(gates.inputOpenAfterLastResult).toBe(true);
    // ... the follow-up turn's did.
    const results = resultsOf(frames);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ result: 'NOTIFIED' });
    const settlement = frames.find((f) => (f as { subtype?: unknown }).subtype === STEER_SETTLEMENT_SUBTYPE);
    expect(settlement).toMatchObject({ consumed: ['u-steer'], discarded: [] });
    expect(cli.inputEnded).toBe(true);
  });

  it("does not count a subagent's system/init as the start of a turn", async () => {
    const cli = newFakeCli();
    const gates = newGates();
    installSettleDuringSteer(cli, gates, true, [{ ...INIT, parent_tool_use_id: 'toolu_agent' }]);
    const handler = newHandler();

    const framesPromise = collect(startTurn(handler));
    await gates.pulledPastOpening.promise;
    expect(handler.steerTurn(SESSION_KEY, { uuid: 'u-steer', text: 'count to ten' })).toBe(true);
    gates.steerGate.resolve();
    const frames = await framesPromise;

    expect(gates.inputOpenAfterLastResult).toBe(true);
    const results = resultsOf(frames);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ result: 'NOTIFIED' });
  });

  it('ends on the steered result when no follow-up turn starts within the grace (the CLI folded the report in)', async () => {
    vi.useFakeTimers();
    const cli = newFakeCli();
    const gates = newGates();
    installSettleDuringSteer(cli, gates, false);
    const handler = newHandler();

    const framesPromise = collect(startTurn(handler));
    await gates.pulledPastOpening.promise;
    expect(handler.steerTurn(SESSION_KEY, { uuid: 'u-steer', text: 'count to ten' })).toBe(true);
    gates.steerGate.resolve();
    await gates.pulledPastLastResult.promise;

    await vi.advanceTimersByTimeAsync(BG_FOLLOWUP_GRACE_MS - 1);
    expect(cli.inputEnded).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const frames = await framesPromise;

    expect(cli.inputEnded).toBe(true);
    const results = resultsOf(frames);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ result: 'one two three', user_message_uuid: 'u-steer' });
    const settlement = frames.find((f) => (f as { subtype?: unknown }).subtype === STEER_SETTLEMENT_SUBTYPE);
    expect(settlement).toMatchObject({ consumed: ['u-steer'], discarded: [] });
  });

  /**
   * The silence bound is for an idle CLI. While a turn runs, its own result
   * bounds the wait: here the steered turn generates text for longer than
   * NON_TURN_RESULT_IDLE_MS after the agent settled inside it, and closing the
   * input then would make the CLI exit after that turn — before the agent's
   * notification turn could run.
   */
  it('does not arm the silence bound when the live set empties while a turn is running', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      const cli = newFakeCli();
      const pulledPastOpening = deferred();
      const steerGate = deferred();
      const pulledPastSettle = deferred();
      const longGeneration = deferred();
      const pulledPastSteerResult = deferred();
      const followUpGate = deferred();
      installScriptedQuery(cli, async function* (inputs) {
        await readOpening(inputs, cli);
        yield* openingTurnHead([agentTask(AGENT_ID)]);
        yield openingResult(cli.opening?.uuid);
        pulledPastOpening.resolve();
        await steerGate.promise;
        cli.received.push((await inputs.next()).value);
        yield INIT;
        // The agent settles inside the steered turn ...
        yield level([]);
        const probe = watchInputEnd(inputs, cli);
        pulledPastSettle.resolve();
        // ... which then generates for a long time with no main-thread frame.
        await longGeneration.promise;
        yield assistantText('one two three');
        yield STEER_RESULT;
        pulledPastSteerResult.resolve();
        await followUpGate.promise;
        yield INIT;
        yield NOTIFIED;
        yield notifiedResult();
        await probe;
      });
      const handler = newHandler();

      const framesPromise = collect(startTurn(handler));
      await pulledPastOpening.promise;
      expect(handler.steerTurn(SESSION_KEY, { uuid: 'u-steer', text: 'count to a thousand' })).toBe(true);
      steerGate.resolve();
      await pulledPastSettle.promise;

      await vi.advanceTimersByTimeAsync(NON_TURN_RESULT_IDLE_MS * 2);
      expect(cli.inputEnded).toBe(false);

      const timersBeforeSteerResult = vi.getTimerCount();
      longGeneration.resolve();
      await pulledPastSteerResult.promise;
      // Not ended by the steered result: the follow-up grace is armed instead.
      expect(cli.inputEnded).toBe(false);
      expect(vi.getTimerCount()).toBe(timersBeforeSteerResult + 1);

      followUpGate.resolve();
      const frames = await framesPromise;

      const results = resultsOf(frames);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ result: 'NOTIFIED' });
      expect(cli.inputEnded).toBe(true);
      expect(callsOf(warn, SETTLED_SILENCE_LOG)).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it("disarms the follow-up grace on the follow-up turn's system/init, however long that turn then runs", async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(Logger.prototype, 'info').mockImplementation(() => {});
    try {
      const cli = newFakeCli();
      const pulledPastOpening = deferred();
      const steerGate = deferred();
      const pulledPastSteerResult = deferred();
      const followUpGate = deferred();
      const pulledPastFollowUpInit = deferred();
      const finishGate = deferred();
      installScriptedQuery(cli, async function* (inputs) {
        await readOpening(inputs, cli);
        yield* openingTurnHead([agentTask(AGENT_ID)]);
        yield openingResult(cli.opening?.uuid);
        pulledPastOpening.resolve();
        await steerGate.promise;
        cli.received.push((await inputs.next()).value);
        yield INIT;
        yield level([]);
        yield taskNotification(AGENT_ID, 'completed');
        yield assistantText('one two three');
        yield STEER_RESULT;
        const probe = watchInputEnd(inputs, cli);
        pulledPastSteerResult.resolve();
        await followUpGate.promise;
        yield INIT;
        pulledPastFollowUpInit.resolve();
        // The follow-up turn outlasts the grace.
        await finishGate.promise;
        yield NOTIFIED;
        yield notifiedResult();
        await probe;
      });
      const handler = newHandler();

      const framesPromise = collect(startTurn(handler));
      await pulledPastOpening.promise;
      expect(handler.steerTurn(SESSION_KEY, { uuid: 'u-steer', text: 'count to ten' })).toBe(true);
      steerGate.resolve();
      await pulledPastSteerResult.promise; // the grace is armed now

      await vi.advanceTimersByTimeAsync(BG_FOLLOWUP_GRACE_MS - 1);
      followUpGate.resolve();
      await pulledPastFollowUpInit.promise;

      await vi.advanceTimersByTimeAsync(BG_FOLLOWUP_GRACE_MS * 2);
      expect(cli.inputEnded).toBe(false);
      expect(callsOf(info, GRACE_LOG)).toHaveLength(0);

      finishGate.resolve();
      const frames = await framesPromise;

      const results = resultsOf(frames);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ result: 'NOTIFIED' });
      expect(cli.inputEnded).toBe(true);
    } finally {
      info.mockRestore();
    }
  });

  it('holds the answer of a turn whose agent started and settled inside it, and ends on the follow-up turn', async () => {
    const cli = newFakeCli();
    const gates = newGates();
    installSettleInsideOpening(cli, gates, true);

    const frames = await collect(startTurn(newHandler()));

    expect(gates.inputOpenAfterLastResult).toBe(true);
    expect(cli.inputEnded).toBe(true);
    const results = resultsOf(frames);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ result: 'NOTIFIED' });
  });

  it('ends on the answer of a turn whose agent settled inside it when no follow-up turn starts within the grace', async () => {
    vi.useFakeTimers();
    const cli = newFakeCli();
    const gates = newGates();
    installSettleInsideOpening(cli, gates, false);

    const framesPromise = collect(startTurn(newHandler()));
    await gates.pulledPastLastResult.promise;

    await vi.advanceTimersByTimeAsync(BG_FOLLOWUP_GRACE_MS - 1);
    expect(cli.inputEnded).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const frames = await framesPromise;

    expect(cli.inputEnded).toBe(true);
    const results = resultsOf(frames);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ result: 'WAITING', user_message_uuid: cli.opening?.uuid });
  });

  it('clears every timer and warns nothing when the consumer returns while the turn is held', async () => {
    vi.useFakeTimers();
    vi.stubEnv(KEEPALIVE_ENV, String(CAP_MS));
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      const cli = newFakeCli();
      let inputEnd: Promise<unknown> | undefined;
      installScriptedQuery(cli, async function* (inputs) {
        await readOpening(inputs, cli);
        yield* openingTurnHead([agentTask(AGENT_ID)]);
        yield openingResult(cli.opening?.uuid);
        inputEnd = watchInputEnd(inputs, cli);
        yield SUBAGENT_ASSISTANT;
        // Never resumed: the consumer returns at the yield of the frame above.
        await cli.closed;
      });
      const timersBeforeTurn = vi.getTimerCount();
      // The generator itself: `return()` is the consumer action under test.
      const it = newHandler().streamQuery('ping', undefined, undefined, undefined, TEST_SLACK_CONTEXT, SESSION_KEY);

      // Pull until the handler sits at the subagent frame's yield, turn held.
      for (;;) {
        const next = await it.next();
        if (next.done || next.value === (SUBAGENT_ASSISTANT as unknown)) break;
      }
      expect((await it.return(undefined)).done).toBe(true);

      await inputEnd;
      expect(cli.inputEnded).toBe(true);
      expect(vi.getTimerCount()).toBe(timersBeforeTurn);

      await vi.advanceTimersByTimeAsync(CAP_MS + NON_TURN_RESULT_IDLE_MS * 2);
      expect(warn).not.toHaveBeenCalled();
      expect(cli.stopTask).not.toHaveBeenCalled();
      expect(cli.close).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('clears every timer and warns nothing when the stream throws while the turn is held', async () => {
    vi.useFakeTimers();
    vi.stubEnv(KEEPALIVE_ENV, String(CAP_MS));
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    try {
      const cli = newFakeCli();
      const pulledPastOpening = deferred();
      const gate = deferred();
      installScriptedQuery(cli, async function* (inputs) {
        await readOpening(inputs, cli);
        yield* openingTurnHead([agentTask(AGENT_ID)]);
        yield openingResult(cli.opening?.uuid);
        pulledPastOpening.resolve();
        await gate.promise;
        throw new Error('aborted by the host');
      });
      const timersBeforeTurn = vi.getTimerCount();

      const framesPromise = collect(startTurn(newHandler()));
      await pulledPastOpening.promise; // held, cap armed
      gate.resolve();

      await expect(framesPromise).rejects.toThrow('aborted by the host');
      expect(vi.getTimerCount()).toBe(timersBeforeTurn);

      await vi.advanceTimersByTimeAsync(CAP_MS + NON_TURN_RESULT_IDLE_MS * 2);
      expect(warn).not.toHaveBeenCalled();
      expect(cli.stopTask).not.toHaveBeenCalled();
      expect(cli.close).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});

/**
 * #997 — a late result must not cut a turn the CLI already started.
 *
 * Dev, 6 November 2026: a turn ended with a `run_in_background` Bash (a CI
 * watcher) still live. The Slack consumer was 46–92 s behind the CLI (Slack
 * rate limiter), so the CLI's input stayed open; the watcher finished, and the
 * CLI ran the notification turn on its own. The host then read the PREVIOUS
 * turn's result, closed the input and returned the iterator — mid-way through
 * that notification turn, as its `gh pr merge` was being called. The CLI filled
 * the call with the SDK's fixed text "The user doesn't want to take this action
 * right now", and the model told the user they had stopped the merge.
 *
 * The CLI's frames after that result were already buffered when the host read
 * it. The handler now holds the answer of a turn whose shell is live, or settled
 * during it, for the follow-up grace: buffered frames are read at once, and a
 * running notification turn ends the turn on its own result.
 */
describe('ClaudeHandler: a late result does not cut a notification turn of a background shell (#997)', () => {
  beforeEach(() => {
    queryMock.mockReset();
    releaseMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  const BASH_ID = 'b0ot1bdpv';
  const bashTask = { task_id: BASH_ID, task_type: 'local_bash', description: 'CI watcher' };

  const TOOL_USE_BG_BASH = {
    type: 'assistant',
    message: {
      model: 'claude-test',
      content: [{ type: 'tool_use', id: 'toolu_watch', name: 'Bash', input: { run_in_background: true } }],
    },
  };
  const BG_BASH_RESULT = {
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_watch', content: 'running' }] },
  };
  const TOOL_USE_MERGE = {
    type: 'assistant',
    message: {
      model: 'claude-test',
      content: [{ type: 'tool_use', id: 'toolu_merge', name: 'Bash', input: { command: 'gh pr merge 982' } }],
    },
  };
  const MERGE_RESULT = {
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_merge', content: 'merged' }] },
  };
  const MERGED = assistantText('MERGED');
  const mergedResult = () => successResult({ result: 'MERGED', num_turns: 2, uuid: 'merged-result-uuid' });

  /** What the processor does: read up to the first result, then return the iterator. */
  async function readLikeTheProcessor(it: AsyncIterator<unknown>): Promise<unknown[]> {
    const out: unknown[] = [];
    for (;;) {
      const next = await it.next();
      if (next.done) return out;
      out.push(next.value);
      if (typeOf(next.value) === 'result') {
        await it.return?.();
        return out;
      }
    }
  }

  it('reads past a stale answer into the notification turn the CLI already ran, and ends on its result', async () => {
    const cli = newFakeCli();
    let inputOpenAfterOpening: boolean | undefined;
    installScriptedQuery(cli, async function* (inputs) {
      await readOpening(inputs, cli);
      yield INIT;
      yield TOOL_USE_BG_BASH;
      yield level([bashTask]);
      yield taskStarted(BASH_ID);
      yield BG_BASH_RESULT;
      yield WAITING;
      yield openingResult(cli.opening?.uuid);
      const probe = watchInputEnd(inputs, cli);
      inputOpenAfterOpening = await isPending(probe);
      // Already emitted by the time the host reads the answer above: the watcher
      // finished and the CLI started the notification turn on its own.
      yield level([]);
      yield taskNotification(BASH_ID, 'completed');
      yield INIT;
      yield TOOL_USE_MERGE;
      yield MERGE_RESULT;
      yield MERGED;
      yield mergedResult();
      await probe;
    });

    const frames = await readLikeTheProcessor(startTurn(newHandler()));

    expect(inputOpenAfterOpening).toBe(true);
    // The consumer saw the whole notification turn — the merge call included —
    // before the turn ended, so returning the iterator cuts nothing.
    expect(frames).toContainEqual(TOOL_USE_MERGE);
    expect(frames).toContainEqual(MERGE_RESULT);
    const results = resultsOf(frames);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ result: 'MERGED' });
    expect(frames.indexOf(MERGED)).toBeLessThan(frames.indexOf(results[0]));
    expect(cli.inputEnded).toBe(true);
  });

  it('holds the answer of a turn whose shell settled inside it, and ends on the follow-up turn', async () => {
    const cli = newFakeCli();
    let inputOpenAfterOpening: boolean | undefined;
    installScriptedQuery(cli, async function* (inputs) {
      await readOpening(inputs, cli);
      yield INIT;
      yield TOOL_USE_BG_BASH;
      yield level([bashTask]);
      yield BG_BASH_RESULT;
      // The shell finishes while the turn generates its last text.
      yield level([]);
      yield WAITING;
      yield openingResult(cli.opening?.uuid);
      const probe = watchInputEnd(inputs, cli);
      inputOpenAfterOpening = await isPending(probe);
      yield taskNotification(BASH_ID, 'completed');
      yield INIT;
      yield NOTIFIED;
      yield notifiedResult();
      await probe;
    });

    const frames = await readLikeTheProcessor(startTurn(newHandler()));

    expect(inputOpenAfterOpening).toBe(true);
    const results = resultsOf(frames);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ result: 'NOTIFIED' });
    expect(cli.inputEnded).toBe(true);
  });

  it("reads into a second shell's notification turn that started after the first one's result", async () => {
    const cli = newFakeCli();
    const second = { task_id: 'b-second', task_type: 'local_bash', description: 'second CI watcher' };
    installScriptedQuery(cli, async function* (inputs) {
      await readOpening(inputs, cli);
      yield INIT;
      yield level([bashTask, second]);
      yield WAITING;
      yield openingResult(cli.opening?.uuid);
      // All buffered by the time the lagging host reads the answer: the first
      // watcher's turn, then the second watcher finishing after that turn's result.
      yield level([second]);
      yield taskNotification(BASH_ID, 'completed');
      yield INIT;
      yield NOTIFIED;
      yield notifiedResult();
      yield level([]);
      yield taskNotification('b-second', 'completed');
      yield INIT;
      yield TOOL_USE_MERGE;
      yield MERGE_RESULT;
      yield MERGED;
      yield mergedResult();
      cli.inputEnded = (await inputs.next()).done === true;
    });

    const frames = await readLikeTheProcessor(startTurn(newHandler()));

    expect(frames).toContainEqual(TOOL_USE_MERGE);
    const results = resultsOf(frames);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ result: 'MERGED' });
  });

  // #997 review (astra): a subagent's own system/init used to disarm the grace,
  // and nothing re-armed it — the held answer then waited out the 30-min cap.
  it("ends the held turn at the grace even when a subagent's system/init arrives meanwhile", async () => {
    vi.useFakeTimers();
    vi.stubEnv(KEEPALIVE_ENV, String(CAP_MS));
    const cli = newFakeCli();
    const pulledPastSubagentInit = deferred();
    installScriptedQuery(cli, async function* (inputs) {
      await readOpening(inputs, cli);
      yield INIT;
      yield level([bashTask, { task_id: 'amb-1', task_type: 'local_agent', description: 'ambient', ambient: true }]);
      yield WAITING;
      yield openingResult(cli.opening?.uuid);
      yield { ...INIT, parent_tool_use_id: 'toolu_ambient' };
      const probe = watchInputEnd(inputs, cli);
      pulledPastSubagentInit.resolve();
      await probe;
    });

    const framesPromise = collect(startTurn(newHandler()));
    await pulledPastSubagentInit.promise;

    await vi.advanceTimersByTimeAsync(BG_FOLLOWUP_GRACE_MS);
    const frames = await framesPromise;

    expect(cli.inputEnded).toBe(true);
    expect(resultsOf(frames)[0]).toMatchObject({ result: 'WAITING', user_message_uuid: cli.opening?.uuid });
  });

  // #997 review (astra): a long-lived shell (dev server) stays live, so "a task
  // is live" alone would re-wait after every result and chain any stream of
  // notification turns (here an ambient watcher's events) onto the held turn.
  it('does not chain notification turns onto a held turn just because a dev server stays live', async () => {
    const cli = newFakeCli();
    const devServer = { task_id: 'dev-1', task_type: 'local_bash', description: 'dev server' };
    const watcher = { task_id: 'mon-1', task_type: 'monitor', description: 'log tail', ambient: true };
    installScriptedQuery(cli, async function* (inputs) {
      await readOpening(inputs, cli);
      yield INIT;
      yield level([devServer, watcher]);
      yield WAITING;
      yield openingResult(cli.opening?.uuid);
      yield INIT;
      yield assistantText('EVENT 1');
      yield successResult({ result: 'EVENT 1', num_turns: 1, uuid: 'event-1-uuid' });
      yield INIT;
      yield assistantText('EVENT 2');
      yield successResult({ result: 'EVENT 2', num_turns: 1, uuid: 'event-2-uuid' });
      cli.inputEnded = (await inputs.next()).done === true;
    });

    const frames = await readLikeTheProcessor(startTurn(newHandler()));

    const results = resultsOf(frames);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ result: 'EVENT 1' });
    expect(frames).not.toContainEqual(assistantText('EVENT 2'));
  });

  // #997 review round 2 (astra): a steer answered while the shell is still live
  // is an answer too — the shell's notification turn may be buffered behind it.
  it("reads past a steer's answer into the shell's notification turn buffered behind it", async () => {
    const cli = newFakeCli();
    const pulledPastOpening = deferred();
    const steerGate = deferred();
    installScriptedQuery(cli, async function* (inputs) {
      await readOpening(inputs, cli);
      yield INIT;
      yield TOOL_USE_BG_BASH;
      yield level([bashTask]);
      yield BG_BASH_RESULT;
      yield WAITING;
      yield openingResult(cli.opening?.uuid);
      pulledPastOpening.resolve();
      await steerGate.promise;
      cli.received.push((await inputs.next()).value);
      yield INIT;
      yield assistantText('ACK');
      yield successResult({ result: 'ACK', num_turns: 1, uuid: 'steer-result-uuid', user_message_uuid: 'u-steer' });
      // Buffered behind the steer's answer: the watcher finished and the CLI ran its turn.
      yield level([]);
      yield taskNotification(BASH_ID, 'completed');
      yield INIT;
      yield TOOL_USE_MERGE;
      yield MERGE_RESULT;
      yield MERGED;
      yield mergedResult();
      cli.inputEnded = (await inputs.next()).done === true;
    });
    const handler = newHandler();

    const framesPromise = readLikeTheProcessor(startTurn(handler));
    await pulledPastOpening.promise;
    expect(handler.steerTurn(SESSION_KEY, { uuid: 'u-steer', text: 'and also' })).toBe(true);
    steerGate.resolve();
    const frames = await framesPromise;

    expect(frames).toContainEqual(TOOL_USE_MERGE);
    const results = resultsOf(frames);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ result: 'MERGED' });
  });

  it('does not wait for a live-update watcher (ambient): its events never hold the turn', async () => {
    const info = vi.spyOn(Logger.prototype, 'info').mockImplementation(() => {});
    try {
      const cli = newFakeCli();
      const watcher = { task_id: 'mon-1', task_type: 'monitor', description: 'log tail', ambient: true };
      installScriptedQuery(cli, async function* (inputs) {
        await readOpening(inputs, cli);
        yield INIT;
        yield level([watcher]);
        yield WAITING;
        yield openingResult(cli.opening?.uuid);
        cli.inputEnded = (await inputs.next()).done === true;
      });

      const frames = await collect(startTurn(newHandler()));

      expect(cli.inputEnded).toBe(true);
      expect(resultsOf(frames)[0]).toMatchObject({ result: 'WAITING' });
      expect(callsOf(info, SHELL_DEFER_LOG)).toHaveLength(0);
    } finally {
      info.mockRestore();
    }
  });

  it('does not hold for a shell when SOMA_BG_KEEPALIVE_MAX_MS is 0', async () => {
    vi.stubEnv(KEEPALIVE_ENV, '0');
    const cli = newFakeCli();
    installScriptedQuery(cli, async function* (inputs) {
      await readOpening(inputs, cli);
      yield INIT;
      yield TOOL_USE_BG_BASH;
      yield level([bashTask]);
      yield BG_BASH_RESULT;
      yield WAITING;
      yield openingResult(cli.opening?.uuid);
      cli.inputEnded = (await inputs.next()).done === true;
    });

    const frames = await collect(startTurn(newHandler()));

    expect(cli.inputEnded).toBe(true);
    const results = resultsOf(frames);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ result: 'WAITING', user_message_uuid: cli.opening?.uuid });
  });
});

/**
 * #1039 — the keepalive cap measures silence, not age.
 *
 * Dev, 7 November 2026: a background opus coder was still running Bash when the
 * cap fired exactly 30 minutes after the hold began, and `stopTask` killed it.
 * The CLI reported it as "was stopped by user"; the model told the user they had
 * stopped it. The cap now re-arms on every activity frame while the turn is held
 * and fires only after SOMA_BG_KEEPALIVE_MAX_MS of silence, under a hard ceiling
 * of BG_KEEPALIVE_HARD_CEILING_FACTOR times that.
 */
describe('ClaudeHandler keepalive cap measures silence, not age (#1039)', () => {
  beforeEach(() => {
    queryMock.mockReset();
    releaseMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  /** A held turn whose agent emits one frame per `pulse()`, until `finish()`. */
  function installWorkingAgent(cli: FakeCli, frame: Record<string, unknown> = SUBAGENT_ASSISTANT) {
    const pulledPastOpening = deferred();
    let pulse = deferred();
    let pulled = deferred();
    let finished = false;
    const finish = deferred();
    installScriptedQuery(cli, async function* (inputs) {
      await readOpening(inputs, cli);
      yield* openingTurnHead([agentTask(AGENT_ID)]);
      yield openingResult(cli.opening?.uuid);
      const drained = drainInputs(inputs, cli);
      pulledPastOpening.resolve();
      for (;;) {
        const which = await Promise.race([
          pulse.promise.then(() => 'pulse' as const),
          finish.promise.then(() => 'finish' as const),
          drained.then(() => 'ended' as const),
        ]);
        if (which === 'pulse') {
          pulse = deferred();
          yield frame;
          const p = pulled;
          pulled = deferred();
          p.resolve();
          continue;
        }
        finished = which === 'finish';
        break;
      }
      if (finished) {
        yield level([]);
        yield taskNotification(AGENT_ID, 'completed');
      } else {
        yield taskNotification(AGENT_ID, 'stopped');
        yield level([]);
      }
      yield INIT;
      yield NOTIFIED;
      yield notifiedResult();
      await drained;
    });
    return {
      pulledPastOpening: pulledPastOpening.promise,
      /** Emit one subagent frame and wait until the handler pulled it. */
      async beat() {
        const p = pulled.promise;
        pulse.resolve();
        await p;
      },
      finish: () => finish.resolve(),
    };
  }

  it('does not stop an agent that keeps working past the cap, and ends on its report', async () => {
    vi.useFakeTimers();
    vi.stubEnv(KEEPALIVE_ENV, String(CAP_MS));
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      const cli = newFakeCli();
      const agent = installWorkingAgent(cli);
      const framesPromise = collect(startTurn(newHandler()));
      await agent.pulledPastOpening;

      // Activity every CAP_MS - 1 for three caps' worth of time.
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(CAP_MS - 1);
        await agent.beat();
      }
      expect(cli.stopTask).not.toHaveBeenCalled();
      expect(cli.inputEnded).toBe(false);
      expect(callsOf(warn, CAP_LOG)).toHaveLength(0);

      agent.finish();
      const frames = await framesPromise;
      expect(cli.stopTask).not.toHaveBeenCalled();
      expect(resultsOf(frames)[0]).toMatchObject({ result: 'NOTIFIED' });
    } finally {
      warn.mockRestore();
    }
  });

  it('stops an agent once it has been silent for the cap, counted from its last frame', async () => {
    vi.useFakeTimers();
    vi.stubEnv(KEEPALIVE_ENV, String(CAP_MS));
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      const cli = newFakeCli();
      const agent = installWorkingAgent(cli);
      const framesPromise = collect(startTurn(newHandler()));
      await agent.pulledPastOpening;

      await vi.advanceTimersByTimeAsync(CAP_MS - 1);
      await agent.beat();
      // Silent from here: the cap counts from the last frame.
      await vi.advanceTimersByTimeAsync(CAP_MS - 1);
      expect(cli.stopTask).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      const frames = await framesPromise;

      expect(cli.stopTask).toHaveBeenCalledWith(AGENT_ID);
      expect(cli.inputEnded).toBe(true);
      expect(callsOf(warn, CAP_LOG)).toHaveLength(1);
      const note = cli.received.slice(1).map(textOf).join('\n');
      expect(note).toContain('[host: keepalive cap]');
      expect(note).toMatch(/no output for 5 minutes/);
      expect(resultsOf(frames)).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not count CLI chatter (status, rate limits) as the agent working', async () => {
    vi.useFakeTimers();
    vi.stubEnv(KEEPALIVE_ENV, String(CAP_MS));
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      const cli = newFakeCli();
      const agent = installWorkingAgent(cli, { type: 'rate_limit_event', rate_limit_info: {} });
      const framesPromise = collect(startTurn(newHandler()));
      await agent.pulledPastOpening;

      await vi.advanceTimersByTimeAsync(CAP_MS - 1);
      await agent.beat();
      await vi.advanceTimersByTimeAsync(1);
      await framesPromise;

      expect(cli.stopTask).toHaveBeenCalledWith(AGENT_ID);
    } finally {
      warn.mockRestore();
    }
  });

  // #1041 review (grok P2, fable P2): a heartbeat says a tool is still running,
  // not that anything moved; another task's report is not this agent working.
  it.each([
    [
      "a subagent tool's heartbeat",
      { type: 'tool_progress', parent_tool_use_id: 'toolu_agent', tool_name: 'Bash', heartbeat: true },
    ],
    [
      'a main-thread tool heartbeat',
      { type: 'tool_progress', parent_tool_use_id: null, tool_name: 'Bash', heartbeat: true },
    ],
    ["another task's progress", { type: 'system', subtype: 'task_progress', task_id: 'bash-1' }],
  ])('does not count %s as the held agent working', async (_kind, frame) => {
    vi.useFakeTimers();
    vi.stubEnv(KEEPALIVE_ENV, String(CAP_MS));
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      const cli = newFakeCli();
      const agent = installWorkingAgent(cli, frame);
      const framesPromise = collect(startTurn(newHandler()));
      await agent.pulledPastOpening;

      await vi.advanceTimersByTimeAsync(CAP_MS - 1);
      await agent.beat();
      await vi.advanceTimersByTimeAsync(1);
      await framesPromise;

      expect(cli.stopTask).toHaveBeenCalledWith(AGENT_ID);
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    ["the held agent's own task progress", { type: 'system', subtype: 'task_progress', task_id: AGENT_ID }],
    [
      "a subagent tool's real progress tick (not a heartbeat)",
      { type: 'tool_progress', parent_tool_use_id: 'toolu_agent', tool_name: 'Bash', heartbeat: false },
    ],
  ])('counts %s as work', async (_kind, frame) => {
    vi.useFakeTimers();
    vi.stubEnv(KEEPALIVE_ENV, String(CAP_MS));
    const cli = newFakeCli();
    const agent = installWorkingAgent(cli, frame);
    const framesPromise = collect(startTurn(newHandler()));
    await agent.pulledPastOpening;

    await vi.advanceTimersByTimeAsync(CAP_MS - 1);
    await agent.beat();
    await vi.advanceTimersByTimeAsync(CAP_MS - 1);
    expect(cli.stopTask).not.toHaveBeenCalled();

    agent.finish();
    await framesPromise;
    expect(cli.stopTask).not.toHaveBeenCalled();
  });

  // #1041 review round 2 (grok P2): the backstop's re-arms are bounded — a
  // report turn that never ends cannot hold the query open forever.
  it('closes the query at the report-turn ceiling even while that turn keeps sending frames', async () => {
    vi.useFakeTimers();
    vi.stubEnv(KEEPALIVE_ENV, String(CAP_MS));
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      const cli = newFakeCli();
      const inputEnded = deferred();
      let gate = deferred();
      let pulled = deferred();
      installScriptedQuery(cli, async function* (inputs) {
        await readOpening(inputs, cli);
        yield* openingTurnHead([agentTask(AGENT_ID)]);
        yield openingResult(cli.opening?.uuid);
        await drainInputs(inputs, cli);
        inputEnded.resolve();
        yield taskNotification(AGENT_ID, 'stopped');
        yield level([]);
        yield INIT;
        for (;;) {
          const closed = await Promise.race([gate.promise.then(() => false), cli.closed.then(() => true)]);
          if (closed) return;
          gate = deferred();
          yield assistantText('still going');
          const p = pulled;
          pulled = deferred();
          p.resolve();
        }
      });

      const framesPromise = collect(startTurn(newHandler()));
      await vi.advanceTimersByTimeAsync(CAP_MS);
      await inputEnded.promise;
      const step = NON_TURN_RESULT_IDLE_MS - 1;
      let elapsed = 0;
      while (cli.close.mock.calls.length === 0 && elapsed < KEEPALIVE_REPORT_TURN_MAX_MS + 3 * step) {
        await vi.advanceTimersByTimeAsync(step);
        elapsed += step;
        if (cli.close.mock.calls.length > 0) break;
        const p = pulled.promise;
        gate.resolve();
        await p;
      }
      // Frames kept coming the whole time; the bound still closed it, near the ceiling.
      expect(cli.close).toHaveBeenCalled();
      expect(elapsed).toBeGreaterThan(KEEPALIVE_REPORT_TURN_MAX_MS - 2 * step);
      expect(elapsed).toBeLessThanOrEqual(KEEPALIVE_REPORT_TURN_MAX_MS + step);
      await framesPromise;
    } finally {
      warn.mockRestore();
    }
  });

  // #1041 review (fable P2): the note asks the model to report; a report turn
  // that runs tools past the 60 s backstop must not be closed mid-way.
  it('does not close the query on the backstop while the report turn after the cap is running', async () => {
    vi.useFakeTimers();
    vi.stubEnv(KEEPALIVE_ENV, String(CAP_MS));
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      const cli = newFakeCli();
      const inputEnded = deferred();
      const step1 = deferred();
      const step2 = deferred();
      const pulled1 = deferred();
      const pulled2 = deferred();
      installScriptedQuery(cli, async function* (inputs) {
        await readOpening(inputs, cli);
        yield* openingTurnHead([agentTask(AGENT_ID)]);
        yield openingResult(cli.opening?.uuid);
        await drainInputs(inputs, cli);
        inputEnded.resolve();
        yield taskNotification(AGENT_ID, 'stopped');
        yield level([]);
        yield INIT;
        await step1.promise;
        yield assistantText('checking what the coder left');
        pulled1.resolve();
        await step2.promise;
        yield assistantText('REPORT');
        pulled2.resolve();
        yield notifiedResult({ result: 'REPORT', uuid: 'report-result-uuid' });
      });

      const framesPromise = collect(startTurn(newHandler()));
      await vi.advanceTimersByTimeAsync(CAP_MS);
      await inputEnded.promise;

      await vi.advanceTimersByTimeAsync(NON_TURN_RESULT_IDLE_MS - 1);
      step1.resolve();
      await pulled1.promise;
      await vi.advanceTimersByTimeAsync(NON_TURN_RESULT_IDLE_MS - 1);
      expect(cli.close).not.toHaveBeenCalled();
      step2.resolve();
      await pulled2.promise;
      const frames = await framesPromise;

      expect(cli.close).not.toHaveBeenCalled();
      expect(resultsOf(frames)[0]).toMatchObject({ result: 'REPORT' });
    } finally {
      warn.mockRestore();
    }
  });

  // #1041 review round 2 (fable P2): a report turn inside one long main-thread
  // tool sends only heartbeats; the backstop must not close it mid-tool.
  it('does not close the query on the backstop while the report turn runs a long tool', async () => {
    vi.useFakeTimers();
    vi.stubEnv(KEEPALIVE_ENV, String(CAP_MS));
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      const cli = newFakeCli();
      const inputEnded = deferred();
      const beats = Array.from({ length: 3 }, () => ({ gate: deferred(), pulled: deferred() }));
      const done = deferred();
      installScriptedQuery(cli, async function* (inputs) {
        await readOpening(inputs, cli);
        yield* openingTurnHead([agentTask(AGENT_ID)]);
        yield openingResult(cli.opening?.uuid);
        await drainInputs(inputs, cli);
        inputEnded.resolve();
        yield taskNotification(AGENT_ID, 'stopped');
        yield level([]);
        yield INIT;
        for (const beat of beats) {
          await beat.gate.promise;
          yield { type: 'tool_progress', parent_tool_use_id: null, tool_name: 'Bash', heartbeat: true };
          beat.pulled.resolve();
        }
        await done.promise;
        yield assistantText('REPORT');
        yield notifiedResult({ result: 'REPORT', uuid: 'report-result-uuid' });
      });

      const framesPromise = collect(startTurn(newHandler()));
      await vi.advanceTimersByTimeAsync(CAP_MS);
      await inputEnded.promise;
      for (const beat of beats) {
        await vi.advanceTimersByTimeAsync(NON_TURN_RESULT_IDLE_MS - 1);
        beat.gate.resolve();
        await beat.pulled.promise;
      }
      expect(cli.close).not.toHaveBeenCalled();
      done.resolve();
      const frames = await framesPromise;

      expect(cli.close).not.toHaveBeenCalled();
      expect(resultsOf(frames)[0]).toMatchObject({ result: 'REPORT' });
    } finally {
      warn.mockRestore();
    }
  });

  // #1041 review round 3 (astra): the cap note must not be left queued when
  // the held turn ends — settlement would read it as an unconsumed steer and
  // discard (re-run) a steer the model already answered.
  it("waits for the cap note's own turn, so a steer answered during the hold settles as consumed", async () => {
    vi.useFakeTimers();
    vi.stubEnv(KEEPALIVE_ENV, String(CAP_MS));
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      const cli = newFakeCli();
      const pulledPastOpening = deferred();
      const steerGate = deferred();
      const pulledPastSteer = deferred();
      installScriptedQuery(cli, async function* (inputs) {
        await readOpening(inputs, cli);
        yield* openingTurnHead([agentTask(AGENT_ID)]);
        yield openingResult(cli.opening?.uuid);
        pulledPastOpening.resolve();
        await steerGate.promise;
        cli.received.push((await inputs.next()).value);
        yield INIT;
        yield assistantText('ACK');
        yield successResult({
          result: 'ACK',
          num_turns: 1,
          uuid: 'steer-result-uuid',
          user_message_uuid: 'u-steer',
          queued_turn_count: 0,
        });
        pulledPastSteer.resolve();
        // Silent until the cap fires and the input ends.
        await drainInputs(inputs, cli);
        const note = cli.received.find((m) => textOf(m).includes('[host: keepalive cap]')) as
          | { uuid?: string }
          | undefined;
        yield taskNotification(AGENT_ID, 'stopped');
        yield level([]);
        // The stop's notification turn runs first; the note is still queued.
        yield INIT;
        yield assistantText('STOP SEEN');
        yield successResult({ result: 'STOP SEEN', num_turns: 1, uuid: 'stop-result-uuid', queued_turn_count: 1 });
        yield INIT;
        yield assistantText('NOTE ANSWERED');
        yield successResult({
          result: 'NOTE ANSWERED',
          num_turns: 1,
          uuid: 'note-result-uuid',
          user_message_uuid: note?.uuid,
          queued_turn_count: 0,
        });
      });
      const handler = newHandler();

      const framesPromise = collect(startTurn(handler));
      await pulledPastOpening.promise;
      expect(handler.steerTurn(SESSION_KEY, { uuid: 'u-steer', text: 'and also' })).toBe(true);
      steerGate.resolve();
      await pulledPastSteer.promise;
      await vi.advanceTimersByTimeAsync(CAP_MS);
      const frames = await framesPromise;

      const note = cli.received.find((m) => textOf(m).includes('[host: keepalive cap]')) as { uuid?: string };
      expect(typeof note?.uuid).toBe('string');
      const settlement = frames.find((f) => (f as { subtype?: unknown }).subtype === STEER_SETTLEMENT_SUBTYPE);
      expect(settlement).toMatchObject({ consumed: ['u-steer'], discarded: [] });
      expect(resultsOf(frames)[0]).toMatchObject({ result: 'NOTE ANSWERED' });
    } finally {
      warn.mockRestore();
    }
  });

  it('does not count a still-queued cap note against the steers when the stream ends first', async () => {
    vi.useFakeTimers();
    vi.stubEnv(KEEPALIVE_ENV, String(CAP_MS));
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      const cli = newFakeCli();
      const pulledPastOpening = deferred();
      const steerGate = deferred();
      const pulledPastSteer = deferred();
      installScriptedQuery(
        cli,
        async function* (inputs) {
          await readOpening(inputs, cli);
          yield* openingTurnHead([agentTask(AGENT_ID)]);
          yield openingResult(cli.opening?.uuid);
          pulledPastOpening.resolve();
          await steerGate.promise;
          cli.received.push((await inputs.next()).value);
          yield INIT;
          yield assistantText('ACK');
          yield successResult({
            result: 'ACK',
            num_turns: 1,
            uuid: 'steer-result-uuid',
            user_message_uuid: 'u-steer',
            queued_turn_count: 0,
          });
          pulledPastSteer.resolve();
          await drainInputs(inputs, cli);
          yield taskNotification(AGENT_ID, 'stopped');
          yield level([]);
          yield INIT;
          yield assistantText('STOP SEEN');
          // The note is still queued (counted), and then the CLI is gone.
          yield successResult({ result: 'STOP SEEN', num_turns: 1, uuid: 'stop-result-uuid', queued_turn_count: 1 });
        },
        () => {
          // The CLI's receipt names what is still queued: the note.
          const note = cli.received.find((m) => textOf(m).includes('[host: keepalive cap]')) as { uuid?: string };
          return { still_queued: [note?.uuid], cancelled: [] };
        },
      );
      const handler = newHandler();

      const framesPromise = collect(startTurn(handler));
      await pulledPastOpening.promise;
      expect(handler.steerTurn(SESSION_KEY, { uuid: 'u-steer', text: 'and also' })).toBe(true);
      steerGate.resolve();
      await pulledPastSteer.promise;
      await vi.advanceTimersByTimeAsync(CAP_MS);
      const frames = await framesPromise;

      const settlement = frames.find((f) => (f as { subtype?: unknown }).subtype === STEER_SETTLEMENT_SUBTYPE);
      expect(settlement).toMatchObject({ consumed: ['u-steer'], discarded: [] });
      expect(resultsOf(frames)[0]).toMatchObject({ result: 'STOP SEEN' });
    } finally {
      warn.mockRestore();
    }
  });

  // #1041 review round 3 (astra P2): a TaskStop the model only attempted (its
  // result an error) must not hide a still-live agent from the cap.
  it('still stops and names an agent whose TaskStop by the model failed', async () => {
    vi.useFakeTimers();
    vi.stubEnv(KEEPALIVE_ENV, String(CAP_MS));
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      const cli = newFakeCli();
      installScriptedQuery(cli, async function* (inputs) {
        await readOpening(inputs, cli);
        yield INIT;
        yield TOOL_USE_AGENT;
        yield level([agentTask(AGENT_ID)]);
        yield TOOL_RESULT;
        yield {
          type: 'assistant',
          message: {
            model: 'claude-test',
            content: [{ type: 'tool_use', id: 'toolu_stop', name: 'TaskStop', input: { task_id: AGENT_ID } }],
          },
        };
        yield {
          type: 'user',
          parent_tool_use_id: null,
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_stop', is_error: true, content: 'denied' }],
          },
        };
        yield WAITING;
        yield openingResult(cli.opening?.uuid);
        await drainInputs(inputs, cli);
        yield taskNotification(AGENT_ID, 'stopped');
        yield level([]);
        yield INIT;
        yield NOTIFIED;
        yield notifiedResult();
      });

      const framesPromise = collect(startTurn(newHandler()));
      await vi.advanceTimersByTimeAsync(CAP_MS);
      await framesPromise;

      expect(cli.stopTask).toHaveBeenCalledWith(AGENT_ID);
      const note = cli.received.slice(1).map(textOf).join('\n');
      expect(note).toContain(AGENT_ID);
    } finally {
      warn.mockRestore();
    }
  });

  // #1041 review round 4 (astra P1, fable P2): a missing echo does not prove the
  // note is in a result's backlog. A result buffered from before the note,
  // counting a real pending steer, must not have that steer read as consumed.
  it('never reads a pending steer as consumed because the cap note had not echoed', async () => {
    vi.useFakeTimers();
    vi.stubEnv(KEEPALIVE_ENV, String(CAP_MS));
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      const cli = newFakeCli();
      const pulledPastOpening = deferred();
      const steerGate = deferred();
      installScriptedQuery(cli, async function* (inputs) {
        await readOpening(inputs, cli);
        yield* openingTurnHead([agentTask(AGENT_ID)]);
        yield openingResult(cli.opening?.uuid);
        pulledPastOpening.resolve();
        await steerGate.promise;
        // The steer is read but its turn never runs; the cap fires meanwhile.
        await drainInputs(inputs, cli);
        // Buffered from before the note: counts the real steer as still queued.
        yield successResult({ result: 'BEFORE NOTE', num_turns: 0, uuid: 'pre-note-uuid', queued_turn_count: 1 });
      });
      const handler = newHandler();

      const framesPromise = collect(startTurn(handler));
      await pulledPastOpening.promise;
      expect(handler.steerTurn(SESSION_KEY, { uuid: 'u-real', text: 'do this too' })).toBe(true);
      steerGate.resolve();
      await vi.advanceTimersByTimeAsync(CAP_MS);
      const frames = await framesPromise;

      const settlement = frames.find((f) => (f as { subtype?: unknown }).subtype === STEER_SETTLEMENT_SUBTYPE);
      // Re-run, never lost.
      expect(settlement).toMatchObject({ consumed: [], discarded: ['u-real'] });
    } finally {
      warn.mockRestore();
    }
  });

  it('stops an agent that never goes silent at the hard ceiling', async () => {
    vi.useFakeTimers();
    vi.stubEnv(KEEPALIVE_ENV, String(CAP_MS));
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      const cli = newFakeCli();
      const agent = installWorkingAgent(cli);
      const framesPromise = collect(startTurn(newHandler()));
      await agent.pulledPastOpening;

      const ceiling = CAP_MS * BG_KEEPALIVE_HARD_CEILING_FACTOR;
      const step = CAP_MS / 2;
      let elapsed = 0;
      while (elapsed + step < ceiling) {
        await vi.advanceTimersByTimeAsync(step);
        elapsed += step;
        await agent.beat();
      }
      expect(cli.stopTask).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(ceiling - elapsed);
      const frames = await framesPromise;

      expect(cli.stopTask).toHaveBeenCalledWith(AGENT_ID);
      const note = cli.received.slice(1).map(textOf).join('\n');
      expect(note).toContain('[host: keepalive cap]');
      expect(note).toMatch(/ran past the 40-minute ceiling/);
      expect(resultsOf(frames)).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});
