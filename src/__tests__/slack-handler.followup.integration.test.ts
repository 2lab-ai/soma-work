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
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../slack/autoskill-fire', () => ({
  buildAutoskillFire: vi.fn(() => null),
}));

import type { FollowupQueueSnapshot } from '@soma/slack/followup-queue';
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

function message(overrides: Record<string, any> = {}): any {
  return {
    user: 'U_OWNER',
    channel: CHANNEL,
    team: 'T1',
    ts: '222.333',
    thread_ts: THREAD_TS,
    text: '지시',
    ...overrides,
  };
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
  const mark = (what: string) => timeline.push({ at: Date.now() - t0, what });
  const at = (what: string | RegExp) =>
    timeline.find((e) => (typeof what === 'string' ? e.what === what : what.test(e.what)))?.at;
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
    };
    const store = { load: () => undefined, save: (_s: FollowupQueueSnapshot) => {}, recoveryWarning: undefined };
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
        let reached = false;
        mark(`turn dispatched (generation ${turnEpoch})`);
        const events = real.streamAgentEvents(text, registrySession, new AbortController(), cwd, SLACK, SESSION_KEY);
        for await (const event of events as AsyncIterable<any>) {
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
    handler.setFollowupChangeListener(() => {
      for (const item of queue().list(SESSION_KEY)) {
        const seen = `row#${item.seq} ${item.state}${item.stateReason ? ` (${item.stateReason})` : ''}`;
        if (timeline[timeline.length - 1]?.what !== seen && !timeline.some((e) => e.what === seen)) mark(seen);
      }
    });
    t0 = Date.now();
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

    await handler.handleMessage(
      message({ ts: '222.333', text: OPENING }),
      vi.fn().mockResolvedValue({ ts: 'm' }) as any,
    );
    await sent;

    const [row] = queue().list(SESSION_KEY);
    expect(row).toMatchObject({ state: 'resolved', stateReason: 'consumed' });
    const steered = at('row#1 steered (steered)');
    const consumed = at('row#1 resolved (consumed)');
    const result = at('result');
    expect(steered).toBeDefined();
    expect(consumed).toBeDefined();
    expect(result).toBeDefined();
    // Closed while the turn still worked — not at its result.
    expect(consumed as number).toBeLessThan(result as number);
    expect(timeline.map((e) => e.what)).toContain('frame steer_lifecycle read');
    // Whether the model acts on what it read is the model's call, not the queue's: reported, not asserted.
    mark(`model acted on the follow-up: ${/파일 수\s*:\s*4/.test(answer)}`);
    // It ran once: nothing went back in line, and no second turn was started for it.
    expect(timeline.some((e) => /row#1 queued/.test(e.what) && e.at > (steered as number))).toBe(false);
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
    onEvent = (type) => {
      if (type === 'tool_call' && !retried) {
        const row = queue().get(SESSION_KEY, parked.item.id);
        mark('user presses Retry on the dashboard mid-turn');
        retried = handler.handleDashboardFollowupAction({
          sessionKey: SESSION_KEY,
          itemId: row.id,
          op: 'promote',
          epoch: row.epoch,
          turnEpoch: handler.getFollowupView(SESSION_KEY)?.turnEpoch ?? 0,
        } as any);
      }
    };

    await handler.handleMessage(
      message({ ts: '222.334', text: OPENING }),
      vi.fn().mockResolvedValue({ ts: 'm' }) as any,
    );
    const outcome = await retried;

    expect(outcome).toEqual({ ok: true });
    expect(queue().get(SESSION_KEY, parked.item.id)).toMatchObject({ state: 'resolved', stateReason: 'consumed' });
    const consumed = at('row#1 resolved (consumed)');
    const result = at('result');
    expect(consumed as number).toBeLessThan(result as number);
    mark(`model acted on the follow-up: ${/파일 수\s*:\s*4/.test(answer)}`);
    // Into the running turn — not a turn of its own after it.
    expect(handlerAny.createAgentSession).toHaveBeenCalledTimes(1);
    printTimeline('Retry mid-turn');
  }, 180_000);
});
