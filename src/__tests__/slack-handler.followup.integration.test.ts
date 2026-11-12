/**
 * The follow-up queue against a REAL Claude Code CLI turn (opt-in, like claude-handler.integration.test.ts).
 *
 * Real: the CLI, `ClaudeHandler` (input channel, steer push, turn-end settlement), the SDK→event mapper, and the
 * host's queue — `SlackHandler`, `FollowupQueue`, `FollowupDispatcher`, the action handlers. Faked: the Slack API and
 * the stream executor, replaced by the one thing it does for this path — hand every `steer_lifecycle` event of the
 * turn to the host's hook with the turn's generation.
 *
 * What the unit suites cannot show: that the frames a real CLI sends, in the order and at the moments it sends
 * them, close a steered row while the turn still works (incident 2026-11-10).
 *
 * Run alone, through llmux (prints each scenario's timeline):
 *   SOMA_TEST_REAL_SDK=1 AUTH_MODE=llmux ANTHROPIC_BASE_URL=http://localhost:3456 \
 *     npx vitest run src/__tests__/slack-handler.followup.integration.test.ts
 * `VITEST_FOLLOWUP_MODEL=<model id>` picks the model (default: a small one). The queue's behaviour is asserted;
 * whether the model acts on the message it read is printed, not asserted — measured 2026-11-10: Fable 5.2 did
 * (its answer carried the line the follow-up asked for), Haiku 4.5 read it as text embedded in the tool result
 * and declined.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../slack/autoskill-fire', () => ({
  buildAutoskillFire: vi.fn(() => null),
}));

import type { FollowupQueueSnapshot } from '@soma/slack/followup-queue';
import type { SteerSignals } from '../agent-runtime/turn-input-channel';
import { ClaudeHandler } from '../claude-handler';
import type { SlackContext } from '../mcp-config-builder';
import { McpManager } from '../mcp-manager';
import { getMetricsEmitter } from '../metrics/event-emitter';
import { SlackHandler } from '../slack-handler';
import { userSettingsStore } from '../user-settings-store';

const optedIn = process.env.SOMA_TEST_REAL_SDK === '1';
const canRun = optedIn && !process.env.CLAUDECODE && !process.env.CI;
const describeReal = canRun ? describe : describe.skip;

const SESSION_KEY = 'C123:111.222';
const CHANNEL = 'C123';
const THREAD_TS = '111.222';
const SLACK: SlackContext = { user: 'U_OWNER', channel: CHANNEL, threadTs: THREAD_TS } as SlackContext;
// A VITEST_-prefixed name: the test-env isolation drops any other variable before this file loads.
const MODEL = process.env.VITEST_FOLLOWUP_MODEL || 'claude-haiku-4-5';

function message(overrides: { ts: string; text: string }): any {
  return { user: 'U_OWNER', channel: CHANNEL, team: 'T1', thread_ts: THREAD_TS, ...overrides };
}

describeReal('follow-up queue × a real CLI turn', () => {
  let handler: SlackHandler;
  let handlerAny: any;
  let real: ClaudeHandler;
  let registrySession: any;
  let cwd: string;
  /** What happened, in order, with ms since the turn was dispatched. */
  let timeline: Array<{ at: number; what: string }>;
  let t0: number;
  let answer: string;
  let onEvent: (type: string, event: any) => void;
  /** After the host handled a signal of the running turn (`read`). */
  let onSignal: (signal: string) => void;
  /** How long the executor's part takes per tool frame (ms) — the Slack round-trips of the real one. 0: none. */
  let lagMs: number;
  /** Held by a scenario: the executor's part does not take its first event until this resolves. */
  let consumerGate: Promise<void> | undefined;
  const mark = (what: string) => timeline.push({ at: Date.now() - t0, what });
  /** Where an entry sits in the ORDER of what happened (-1: it did not). Times are for the printout only. */
  const position = (what: string) => timeline.findIndex((e) => e.what === what);
  /**
   * The row was closed by the CLI's mid-turn read receipt, with the turn still working after it: the host handled
   * a `read` frame, the row resolved inside that handling, the model went on to another tool call, and only then
   * did the turn's settlement (`completed`) and its result arrive. Order, not clock: frames drained together can
   * share a millisecond.
   */
  function expectClosedMidTurn(after: string) {
    const what = timeline.map((e) => e.what);
    const sent = position(after);
    const resolved = what.indexOf('row#1 resolved (consumed)', sent);
    expect(sent, `"${after}" happened`).toBeGreaterThanOrEqual(0);
    expect(resolved, 'the row resolved after it').toBeGreaterThan(sent);
    // By the CLI's read receipt, at the frame's arrival (the turn's own signal) — not at the turn-end
    // `completed`. The same receipt comes down the stream afterwards and moves nothing.
    expect(what.lastIndexOf('signal read (frame arrival)', resolved)).toBeGreaterThan(sent);
    expect(what.indexOf('host handled read', resolved)).toBeGreaterThan(resolved);
    expect(what.slice(sent, resolved)).not.toContain('frame steer_lifecycle completed');
    // The turn was not over: the model called another tool after the row closed, before the result.
    const result = what.indexOf('result', resolved);
    expect(result, 'the result came after the row resolved').toBeGreaterThan(resolved);
    expect(what.slice(resolved, result), 'the turn still worked after the row closed').toContain('tool_call');
  }
  /** Bumped per scenario: a turn of an earlier scenario that is still running stops at its next event. */
  let scenario = 0;
  /** Every state the queue's rows went through, in order — a row that went back in line shows twice. */
  let rowStates: string[];
  let lastRowState: Map<string, string>;
  /** The real turn's abort handle and its end: a test that failed or timed out must not leave a CLI running. */
  let turnAbort: AbortController | undefined;
  let turnDone: Promise<unknown> | undefined;
  const queue = () => handlerAny.getFollowupQueue();

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(getMetricsEmitter(), 'emitFollowupQueue').mockResolvedValue(undefined);
    vi.spyOn(userSettingsStore, 'getUserAutoGoalEnabled').mockReturnValue(false);
    vi.spyOn(userSettingsStore, 'getUserGoalMaxContinuations').mockReturnValue(10);
    vi.spyOn(userSettingsStore, 'isUserAccepted').mockReturnValue(true);

    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'followup-real-'));
    for (const name of ['a', 'b', 'c', 'd']) fs.writeFileSync(path.join(cwd, `${name}.txt`), `contents of ${name}\n`);
    timeline = [];
    answer = '';
    onEvent = () => {};
    onSignal = () => {};
    lagMs = 0;
    consumerGate = undefined;
    real = new ClaudeHandler(new McpManager(''));
    registrySession = {
      ownerId: 'U_OWNER',
      ownerName: 'Owner',
      userId: 'U_OWNER',
      channelId: CHANNEL,
      threadTs: THREAD_TS,
      threadRootTs: THREAD_TS,
      isActive: true,
      lastActivity: new Date(),
      state: 'MAIN',
      workflow: 'default',
      activityState: 'idle',
      model: MODEL,
    };
    const claudeHandler = {
      getSessionKey: vi.fn().mockReturnValue(SESSION_KEY),
      getSession: vi.fn().mockReturnValue(registrySession),
      getSessionByKey: vi.fn((key: string) => (key === SESSION_KEY ? registrySession : undefined)),
      saveSessions: vi.fn(),
      canInterrupt: vi.fn().mockReturnValue(true),
      setActivityStateByKey: vi.fn(),
      broadcastSessionUpdate: vi.fn(),
      // The real push into the real turn's input channel.
      steerTurn: (key: string, input: { uuid: string; text: string }) => {
        const pushed = real.steerTurn(key, input);
        mark(`steerTurn pushed=${pushed}`);
        return pushed;
      },
      // What the real turn says the moment the CLI's frame arrives — ahead of the stream the executor reads.
      setSteerSignals: (signals: SteerSignals) =>
        real.setSteerSignals({
          read: (key, uuid) => {
            mark('signal read (frame arrival)');
            signals.read(key, uuid);
            onSignal('read');
          },
          inputReopened: (key) => {
            mark('signal input reopened');
            signals.inputReopened(key);
          },
        }),
    };
    // The queue's save sink sees EVERY commit, in order — a listener only samples the state a tick later
    // and would miss a row that moved twice within one tick.
    rowStates = [];
    lastRowState = new Map();
    t0 = Date.now();
    const recordRows = (snapshot: FollowupQueueSnapshot) => {
      for (const item of snapshot.sessions.find((session) => session.sessionKey === SESSION_KEY)?.items ?? []) {
        const now = `${item.state}@${item.epoch}`;
        if (lastRowState.get(item.id) === now) continue;
        lastRowState.set(item.id, now);
        rowStates.push(`row#${item.seq} ${item.state}`);
        mark(`row#${item.seq} ${item.state}${item.stateReason ? ` (${item.stateReason})` : ''}`);
      }
    };
    const store = { load: () => undefined, save: recordRows, recoveryWarning: undefined };
    handler = new SlackHandler({ client: {}, assistant: vi.fn() } as any, claudeHandler as any, {} as any, {
      followupQueueStore: store,
    });
    handlerAny = handler as any;
    handlerAny.slackApi = {
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      postMessage: vi.fn().mockResolvedValue({ ts: 'm' }),
      postSystemMessage: vi.fn().mockResolvedValue({ ts: 'm' }),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
      postEphemeral: vi.fn().mockResolvedValue({ ts: 'eph' }),
    };
    handlerAny.assistantStatusManager = {
      bumpEpoch: vi.fn().mockReturnValue(1),
      setStatus: vi.fn().mockResolvedValue(undefined),
      clearStatus: vi.fn().mockResolvedValue(undefined),
    };
    handlerAny.inputProcessor = {
      processFiles: vi.fn().mockResolvedValue({ files: [], shouldContinue: true }),
      routeCommand: vi.fn().mockResolvedValue({ handled: false }),
    };
    handlerAny.messageValidator = {
      validateWorkingDirectory: vi.fn().mockReturnValue({ valid: true, workingDirectory: cwd }),
    };
    handlerAny.sessionInitializer = {
      validateWorkingDirectory: vi.fn().mockResolvedValue({ valid: true, workingDirectory: cwd }),
      initialize: vi.fn().mockImplementation(async () => ({
        session: registrySession,
        sessionKey: SESSION_KEY,
        isNewSession: false,
        userName: 'Owner',
        workingDirectory: cwd,
        abortController: new AbortController(),
        halted: false,
      })),
    };
    handlerAny.threadPanel = {
      create: vi.fn().mockResolvedValue(undefined),
      updatePanel: vi.fn().mockResolvedValue(undefined),
      clearChoice: vi.fn().mockResolvedValue(undefined),
    };
    // The stream executor's part for this path: run the turn, hand its steer frames to the host.
    handlerAny.createAgentSession = vi.fn().mockImplementation(() => ({
      startWithContinuation: async (text: string) => {
        const turnEpoch = handlerAny.followupDispatcher.liveTurnEpoch(SESSION_KEY);
        const deps = handlerAny.streamExecutor.deps;
        const mine = scenario;
        let reached = false;
        mark(`turn dispatched (generation ${turnEpoch})`);
        turnAbort = new AbortController();
        const events = real.streamAgentEvents(text, registrySession, turnAbort, cwd, SLACK, SESSION_KEY);
        for await (const event of events as AsyncIterable<any>) {
          // Another scenario owns the shared timeline now: leave (the generator's cleanup closes the CLI's input).
          if (mine !== scenario) break;
          // The executor renders before it asks for the next frame: it runs behind the CLI.
          if (consumerGate) {
            await consumerGate;
            consumerGate = undefined;
          }
          if (lagMs > 0 && (event.type === 'tool_call' || event.type === 'tool_result')) {
            await new Promise((resolve) => setTimeout(resolve, lagMs));
          }
          if (mine !== scenario) break;
          if (!reached) {
            reached = true;
            deps.onTurnReachedModel?.({ sessionKey: SESSION_KEY, turnEpoch });
            mark('turn reached the model');
          }
          if (event.type === 'steer_lifecycle') {
            mark(`frame steer_lifecycle ${event.phase}`);
            await deps.onSteerLifecycle({ sessionKey: SESSION_KEY, uuid: event.uuid, phase: event.phase, turnEpoch });
            mark(`host handled ${event.phase}`);
          } else if (event.type === 'tool_call') mark('tool_call');
          else if (event.type === 'tool_result') mark('tool_result');
          else if (event.type === 'assistant_delta') answer += event.text;
          else if (event.type === 'result') mark('result');
          onEvent(event.type, event);
        }
        mark('turn over');
        return { hasPendingChoice: false };
      },
      getLastTurnSucceeded: () => true,
      getRetryAfterMs: () => undefined,
    }));
  });

  afterEach(async () => {
    // A passed test's turn is over and this is a no-op. After a failure or a timeout the CLI may still run:
    // stop it and wait, so its late events cannot reach the next scenario.
    scenario += 1;
    onEvent = () => {};
    turnAbort?.abort();
    const stopped = await Promise.race([
      (turnDone ?? Promise.resolve()).then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000)),
    ]);
    turnAbort = undefined;
    turnDone = undefined;
    // Its events can no longer reach the next scenario (`scenario` moved on), but a CLI that will not stop is
    // a leak worth failing for.
    if (!stopped) throw new Error('the real CLI turn did not stop within 10 s of its abort');
  });

  const OPENING =
    'Read the files a.txt, b.txt, c.txt and d.txt in the current directory with the Read tool, ONE tool call per ' +
    'message, in that order, never two in one message. Then tell me in one short line what you did.';
  /** What the user adds while the turn works — an ordinary follow-up, answerable only by acting on it. */
  const FOLLOW_UP = "아 그리고 읽은 파일이 몇 개였는지도 마지막 줄에 '파일 수: N' 형식으로 적어줘";

  function printTimeline(title: string) {
    const lines = timeline.map((e) => `${(e.at / 1000).toFixed(1).padStart(6)}s  ${e.what}`);
    console.log(`\n=== ${title}\n${lines.join('\n')}\nanswer: ${JSON.stringify(answer.trim().slice(0, 200))}\n`);
  }

  it('a message sent while the turn works is read mid-turn and leaves the queue before the turn ends', async () => {
    let sent: Promise<void> | undefined;
    onEvent = (type) => {
      // The user presses Enter while the first tool call is out.
      if (type === 'tool_call' && !sent) {
        mark('user sends a message mid-turn');
        sent = handler.handleMessage(
          message({ ts: '333.444', text: FOLLOW_UP }),
          vi.fn().mockResolvedValue({ ts: 'm' }) as any,
        );
      }
    };

    turnDone = handler.handleMessage(
      message({ ts: '222.333', text: OPENING }),
      vi.fn().mockResolvedValue({ ts: 'm' }) as any,
    );
    await turnDone;
    await sent;

    const [row] = queue().list(SESSION_KEY);
    expect(row).toMatchObject({ state: 'resolved', stateReason: 'consumed' });
    // Closed while the turn still worked — not at its result.
    expectClosedMidTurn('user sends a message mid-turn');
    // Whether the model acts on what it read is the model's call, not the queue's: reported, not asserted.
    mark(`model acted on the follow-up: ${/파일 수\s*:\s*4/.test(answer)}`);
    // It ran once: nothing went back in line, and no second turn was started for it.
    expect(rowStates).toEqual(['row#1 queued', 'row#1 steered', 'row#1 resolved']);
    expect(handlerAny.createAgentSession).toHaveBeenCalledTimes(1);
    mark(`model: ${registrySession.model}`);
    printTimeline('mid-turn message');
  }, 180_000);

  it('a cut row retried from the dashboard while a turn works is handed to that turn', async () => {
    // A row whose own turn was cut (`uncertain`), as an interrupt leaves it.
    const parked = queue().enqueue(SESSION_KEY, message({ ts: '300.1', text: FOLLOW_UP }), { workingDirectory: cwd });
    const claimed = queue().claimNext(SESSION_KEY);
    const dispatched = queue().markDispatched(SESSION_KEY, parked.item.id, claimed.item.epoch);
    queue().markInterrupted(SESSION_KEY, parked.item.id, dispatched.item.epoch, '턴이 중단되었습니다');
    expect(queue().get(SESSION_KEY, parked.item.id).state).toBe('uncertain');

    let retried: Promise<unknown> | undefined;
    let statesAtRetry = -1;
    onEvent = (type) => {
      if (type === 'tool_call' && !retried) {
        const row = queue().get(SESSION_KEY, parked.item.id);
        mark('user presses Retry on the dashboard mid-turn');
        statesAtRetry = rowStates.length;
        retried = handler.handleDashboardFollowupAction({
          sessionKey: SESSION_KEY,
          itemId: row.id,
          op: 'promote',
          epoch: row.epoch,
          turnEpoch: handler.getFollowupView(SESSION_KEY)?.turnEpoch ?? 0,
        } as any);
      }
    };

    turnDone = handler.handleMessage(
      message({ ts: '222.334', text: OPENING }),
      vi.fn().mockResolvedValue({ ts: 'm' }) as any,
    );
    await turnDone;
    const outcome = await retried;

    expect(outcome).toEqual({ ok: true });
    expect(queue().get(SESSION_KEY, parked.item.id)).toMatchObject({ state: 'resolved', stateReason: 'consumed' });
    expectClosedMidTurn('user presses Retry on the dashboard mid-turn');
    // From the press on: put back in line, handed to the running turn, read — and never back in line after that.
    expect(rowStates.slice(0, statesAtRetry).pop()).toBe('row#1 uncertain');
    expect(rowStates.slice(statesAtRetry)).toEqual(['row#1 queued', 'row#1 steered', 'row#1 resolved']);
    mark(`model acted on the follow-up: ${/파일 수\s*:\s*4/.test(answer)}`);
    // Into the running turn — not a turn of its own after it.
    expect(handlerAny.createAgentSession).toHaveBeenCalledTimes(1);
    printTimeline('Retry mid-turn');
  }, 180_000);

  /**
   * Incident 2026-11-12 (dev). The executor ran 12 s behind the CLI (Slack round-trips behind a rate limit all
   * sessions share). The model was already answering a steered message while its row still said "waiting";
   * `Send now` pressed then killed the turn that was running that very message — first reaction 90 s later.
   */
  it('behind a slow executor the row still closes when the CLI reads it — and Send now cannot cut that turn', async () => {
    lagMs = 2_500;
    let sent: Promise<void> | undefined;
    let steered: { id: string; epoch: number } | undefined;
    let pressed: Promise<unknown> | undefined;
    onEvent = (type) => {
      if (type === 'tool_call' && !sent) {
        mark('user sends a message mid-turn');
        sent = handler
          .handleMessage(message({ ts: '333.445', text: FOLLOW_UP }), vi.fn().mockResolvedValue({ ts: 'm' }) as any)
          .then(() => {
            const row = queue().list(SESSION_KEY)[0];
            // What the panel rendered its `Send now` against: the steered row.
            if (row?.state === 'steered') steered = { id: row.id, epoch: row.epoch };
          });
      }
    };
    onSignal = (signal) => {
      // The user presses Send now on the button the panel still shows, right after the CLI read the message.
      if (signal !== 'read' || pressed) return;
      const row = queue().list(SESSION_KEY)[0];
      mark('user presses Send now');
      pressed = handler.handleDashboardFollowupAction({
        sessionKey: SESSION_KEY,
        itemId: row.id,
        op: 'promote',
        epoch: steered?.epoch ?? row.epoch,
        turnEpoch: handler.getFollowupView(SESSION_KEY)?.turnEpoch ?? 0,
      } as any);
    };

    turnDone = handler.handleMessage(
      message({ ts: '222.335', text: OPENING }),
      vi.fn().mockResolvedValue({ ts: 'm' }) as any,
    );
    await turnDone;
    await sent;
    const outcome = (await pressed) as { ok: boolean; error?: string } | undefined;

    const what = timeline.map((e) => e.what);
    const arrived = what.indexOf('signal read (frame arrival)');
    const closed = what.indexOf('row#1 resolved (consumed)');
    // (The opening message's own receipt comes first: the one after the row closed is the steer's.)
    const streamed = what.indexOf('frame steer_lifecycle read', closed);
    printTimeline('slow executor: read at arrival, Send now refused');
    // Closed at the frame's arrival; the executor got to that frame later.
    expect(arrived).toBeGreaterThanOrEqual(0);
    expect(closed).toBeGreaterThan(arrived);
    expect(streamed, 'the stream delivered the same receipt after the row had closed').toBeGreaterThan(closed);
    mark(
      `the row closed ${((timeline[streamed].at - timeline[closed].at) / 1000).toFixed(1)} s before the executor reached the receipt`,
    );
    // Send now on the closed row: refused, nothing was cut — one turn, ended by its own result.
    expect(pressed, 'Send now was pressed').toBeDefined();
    expect(outcome?.ok).toBe(false);
    expect(handlerAny.createAgentSession).toHaveBeenCalledTimes(1);
    expect(what).toContain('result');
    expect(rowStates).toEqual(['row#1 queued', 'row#1 steered', 'row#1 resolved']);
    mark(`Send now answered: ${JSON.stringify(outcome)}`);
    printTimeline('slow executor: verdict');
  }, 240_000);

  /**
   * The other half of the same lag. The CLI has ended the turn (its `result` is sent) and the executor has not
   * got to it. A message pushed now is not folded into anything: the CLI starts a turn of its own for it, and the
   * host — settling the result it finally reads against a `queued_turn_count` written before the push — records
   * the message as consumed, ends the turn and closes the input on the CLI mid-answer. The answer is lost.
   */
  it('a message sent after the CLI ended the turn, before the executor read that, runs as the next turn', async () => {
    let release: () => void = () => {};
    consumerGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const QUICK = 'Reply with exactly the single word READY and nothing else. Do not use any tool.';
    const SECOND = 'Now reply with exactly the single word SECOND and nothing else. Do not use any tool.';

    turnDone = handler.handleMessage(
      message({ ts: '222.336', text: QUICK }),
      vi.fn().mockResolvedValue({ ts: 'm' }) as any,
    );
    // Wait until the CLI's result is in while the executor is held: the real turn's input stops taking steers
    // the moment it arrives. A build without that hold never says so — there the wait is the whole 15 s, by
    // which a one-word answer is long over, and the message below goes into the ended turn (the old behaviour).
    const inputOf = () =>
      (real as any).activeQueries.get(SESSION_KEY)?.channel as { acceptsPushes: boolean } | undefined;
    const waitUntil = Date.now() + 15_000;
    while (inputOf()?.acceptsPushes !== false && Date.now() < waitUntil) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    mark('the CLI ended the turn (result arrived); the executor has not read it');
    mark('user sends a message');
    const sent = handler.handleMessage(
      message({ ts: '333.446', text: SECOND }),
      vi.fn().mockResolvedValue({ ts: 'm' }) as any,
    );
    await sent;
    release();
    await turnDone;
    // The drain runs the queued message as the session's next turn.
    const settleBy = Date.now() + 120_000;
    while (queue().list(SESSION_KEY)[0]?.state !== 'resolved') {
      if (Date.now() > settleBy) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    printTimeline('message in the gap after the CLI ended the turn');
    mark(`row states: ${rowStates.join(' → ')}`);
    // Never pushed into a turn the CLI had already ended: offered when it was sent, and once more when the
    // executor took its first event — the result was still unread both times.
    const pushes = timeline.filter((e) => e.what.startsWith('steerTurn pushed=')).map((e) => e.what);
    expect(pushes.length).toBeGreaterThanOrEqual(1);
    expect(new Set(pushes)).toEqual(new Set(['steerTurn pushed=false']));
    // It ran as its own turn, to its result, and its answer was read.
    expect(handlerAny.createAgentSession).toHaveBeenCalledTimes(2);
    expect(timeline.filter((e) => e.what === 'result')).toHaveLength(2);
    expect(queue().list(SESSION_KEY)[0]).toMatchObject({ state: 'resolved' });
    // Each refused offer was rolled back to `queued`; then the drain ran it: claimed, dispatched, resolved.
    expect(rowStates.filter((state) => state === 'row#1 steered')).toHaveLength(pushes.length);
    expect(rowStates.slice(-4)).toEqual(['row#1 queued', 'row#1 claimed', 'row#1 dispatched', 'row#1 resolved']);
    expect(timeline.map((e) => e.what)).not.toContain('row#1 resolved (consumed)');
    expect(answer).toMatch(/READY/);
    expect(answer).toMatch(/SECOND/);
  }, 300_000);
});
