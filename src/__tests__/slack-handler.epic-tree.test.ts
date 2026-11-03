/**
 * #854 — a new Slack session's place in an epic tree, and the end of its chain.
 *
 *   T1 the dashboard's epic switch: a new session is made an epic before its first turn runs.
 *   T2 an epic's child (its first message in its own new thread) is bound to the id its epic
 *      reserved, its epic and its node, before its first turn; the title is the card's.
 *   T3 a child that cannot be bound does not run (its epic's spawn hears it did not start), and the
 *      thread says why; an epic that cannot be made goes on as an ordinary session, and says so.
 *   T4 placement is for a new session only: a later message in the thread never re-binds.
 *   T5 a chain that settled with nothing in flight is heard (`setChainSettledListener`) with the
 *      last run's outcome.
 *   T9 the epic switch is leave, not an order: work the dispatcher sizes `small` (one task or less,
 *      about 10 minutes) runs as an ordinary session and the thread says so; `large` or no estimate
 *      makes the epic; an epic's child is bound whatever its size.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SlackHandler } from '../slack-handler';

function harness(
  fullSession: any,
  isNewSession = true,
  registryOver: Record<string, any> = {},
  initOver: Record<string, any> = {},
) {
  const app = { client: {}, assistant: vi.fn() } as any;
  const registry = { makeEpic: vi.fn(), bindEpicChild: vi.fn(), ...registryOver };
  const claudeHandler: any = {
    getSessionByKey: vi.fn().mockReturnValue(fullSession),
    getSession: vi.fn().mockReturnValue(fullSession),
    saveSessions: vi.fn(),
    setActivityStateByKey: vi.fn(),
    getSessionRegistry: () => registry,
  };
  const handler = new SlackHandler(app, claudeHandler, {} as any);
  const h = handler as any;
  h.slackApi = {
    addReaction: vi.fn().mockResolvedValue(undefined),
    removeReaction: vi.fn().mockResolvedValue(undefined),
    postSystemMessage: vi.fn().mockResolvedValue({ ts: 'notice' }),
    postMessage: vi.fn().mockResolvedValue({ ts: 'notice' }),
  };
  h.inputProcessor = {
    processFiles: vi.fn().mockResolvedValue({ files: [], shouldContinue: true }),
    routeCommand: vi.fn().mockResolvedValue({ handled: false }),
  };
  h.sessionInitializer = {
    validateWorkingDirectory: vi.fn().mockResolvedValue({ valid: true, workingDirectory: '/tmp' }),
    initialize: vi.fn().mockResolvedValue({
      session: fullSession,
      sessionKey: 'C1:9.9',
      isNewSession,
      userName: 'Owner',
      workingDirectory: '/tmp',
      abortController: new AbortController(),
      halted: false,
      ...initOver,
    }),
  };
  const execute = vi.fn().mockResolvedValue({ success: true, messageCount: 1 });
  h.streamExecutor = { execute };
  h.threadPanel = { create: vi.fn().mockResolvedValue(undefined) };
  return { handler, registry, execute, slackApi: h.slackApi, claudeHandler };
}

const say = () => vi.fn().mockResolvedValue({ ts: 'msg' });
const child = { taskId: 'c-1', parentTaskId: 'e-1', planNodeId: 'login', title: 'Fix login' };

describe('SlackHandler — a new session’s place in an epic tree (#854)', () => {
  it('T1 — the epic switch makes the new session an epic before its first turn', async () => {
    const session: any = { ownerId: 'U1', systemPrompt: 'cached' };
    const { handler, registry, execute } = harness(session);
    await handler.handleMessage(
      { user: 'U1', channel: 'C1', ts: '9.9', text: '로그인 전부', epicOverride: true } as any,
      say(),
    );
    expect(registry.makeEpic).toHaveBeenCalledWith('C1:9.9');
    expect(registry.makeEpic.mock.invocationCallOrder[0]).toBeLessThan(execute.mock.invocationCallOrder[0]);
    expect(registry.bindEpicChild).not.toHaveBeenCalled();
  });

  it('T2 — an epic’s child is bound (its reserved id, epic, node) and titled before its first turn', async () => {
    const session: any = { ownerId: 'U1', systemPrompt: 'cached' };
    const { handler, registry, execute } = harness(session);
    await handler.handleMessage(
      { user: 'U1', channel: 'C1', ts: '9.9', thread_ts: '9.9', text: '로그인 고쳐', epicChild: child } as any,
      say(),
    );
    expect(registry.bindEpicChild).toHaveBeenCalledWith('C1:9.9', {
      taskId: 'c-1',
      parentTaskId: 'e-1',
      planNodeId: 'login',
    });
    expect(session.title).toBe('Fix login');
    expect(registry.bindEpicChild.mock.invocationCallOrder[0]).toBeLessThan(execute.mock.invocationCallOrder[0]);
  });

  it('T3 — a child that cannot be bound does not run and says why; an epic that cannot be made goes on', async () => {
    const unbound = harness({ ownerId: 'U1', systemPrompt: 'cached' }, true, {
      bindEpicChild: vi.fn(() => {
        throw new Error('not reserved');
      }),
    });
    await unbound.handler.handleMessage(
      { user: 'U1', channel: 'C1', ts: '9.9', thread_ts: '9.9', text: 'go', epicChild: child } as any,
      say(),
    );
    expect(unbound.execute).not.toHaveBeenCalled();
    expect(unbound.slackApi.postSystemMessage).toHaveBeenCalledWith(
      'C1',
      expect.stringContaining('에픽의 자식 작업으로 묶지 못해'),
      expect.anything(),
    );

    const notEpic = harness({ ownerId: 'U1', systemPrompt: 'cached' }, true, {
      makeEpic: vi.fn(() => {
        throw new Error('disk');
      }),
    });
    await notEpic.handler.handleMessage(
      { user: 'U1', channel: 'C1', ts: '9.9', text: 'go', epicOverride: true } as any,
      say(),
    );
    expect(notEpic.execute).toHaveBeenCalledTimes(1);
    expect(notEpic.slackApi.postSystemMessage).toHaveBeenCalledWith(
      'C1',
      expect.stringContaining('에픽으로 만들지 못했습니다'),
      expect.anything(),
    );
  });

  it('T9 — the epic switch on small work: an ordinary session that says why; large or unknown makes the epic', async () => {
    const small = harness({ ownerId: 'U1', systemPrompt: 'cached' }, true, {}, { workSize: 'small' });
    await small.handler.handleMessage(
      { user: 'U1', channel: 'C1', ts: '9.9', text: '버튼 오타 고쳐줘', epicOverride: true } as any,
      say(),
    );
    expect(small.registry.makeEpic).not.toHaveBeenCalled();
    expect(small.execute).toHaveBeenCalledTimes(1);
    expect(small.slackApi.postSystemMessage).toHaveBeenCalledWith(
      'C1',
      expect.stringContaining('에픽 대신 일반 작업으로 진행합니다'),
      expect.objectContaining({ threadTs: expect.any(String) }),
    );
    expect(small.slackApi.postSystemMessage.mock.invocationCallOrder[0]).toBeLessThan(
      small.execute.mock.invocationCallOrder[0],
    );
    // An en user reads it in English: the whole notice is a key of the text catalog.
    const notice = small.slackApi.postSystemMessage.mock.calls[0][1] as string;
    const enText = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'packages', 'common', 'src', 'i18n-catalog', 'en-text.json'), 'utf8'),
    );
    expect(enText[notice]).toMatch(/ordinary task, not an epic/);

    for (const workSize of ['large', undefined]) {
      const big = harness({ ownerId: 'U1', systemPrompt: 'cached' }, true, {}, { workSize });
      await big.handler.handleMessage(
        { user: 'U1', channel: 'C1', ts: '9.9', text: '결제 시스템 전부', epicOverride: true } as any,
        say(),
      );
      expect(big.registry.makeEpic).toHaveBeenCalledWith('C1:9.9');
      expect(big.slackApi.postSystemMessage).not.toHaveBeenCalled();
    }

    // A small instruction without the switch: nothing to say, nothing made.
    const plain = harness({ ownerId: 'U1', systemPrompt: 'cached' }, true, {}, { workSize: 'small' });
    await plain.handler.handleMessage({ user: 'U1', channel: 'C1', ts: '9.9', text: 'hi' } as any, say());
    expect(plain.registry.makeEpic).not.toHaveBeenCalled();
    expect(plain.slackApi.postSystemMessage).not.toHaveBeenCalled();

    // An epic's child is bound whatever its size.
    const kid = harness({ ownerId: 'U1', systemPrompt: 'cached' }, true, {}, { workSize: 'small' });
    await kid.handler.handleMessage(
      { user: 'U1', channel: 'C1', ts: '9.9', thread_ts: '9.9', text: 'go', epicChild: child } as any,
      say(),
    );
    expect(kid.registry.bindEpicChild).toHaveBeenCalledTimes(1);
  });

  it('T4 — a later message in the thread never re-binds or re-makes', async () => {
    const { handler, registry, execute } = harness({ ownerId: 'U1', systemPrompt: 'cached', sessionId: 's' }, false);
    await handler.handleMessage(
      {
        user: 'U1',
        channel: 'C1',
        ts: '9.10',
        thread_ts: '9.9',
        text: 'go',
        epicChild: child,
        epicOverride: true,
      } as any,
      say(),
    );
    expect(registry.bindEpicChild).not.toHaveBeenCalled();
    expect(registry.makeEpic).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('T5 — a chain that settled with nothing in flight is heard with the last run’s outcome', async () => {
    const { handler } = harness({ ownerId: 'U1', systemPrompt: 'cached' });
    const heard: Array<[string, unknown]> = [];
    handler.setChainSettledListener((key, outcome) => heard.push([key, outcome]));
    const h = handler as any;
    h.followupDispatcher = { isBusy: () => false };
    h.noteAutoCompactCut = vi.fn();
    h.sweepSteerBucketsIfIdle = vi.fn();
    h.resumeIfAutoCompactStop = vi.fn();
    h.releaseDeferredGoalDriver = vi.fn();
    await h.drainFollowups('C1:9.9', { outcome: { result: 'error', reason: 'boom' }, canDrain: false });
    expect(heard).toEqual([['C1:9.9', { result: 'error', reason: 'boom' }]]);
    // A `Send now` holding the slot: the chain is not over.
    h.followupDispatcher = { isBusy: () => true };
    await h.drainFollowups('C1:9.9', { outcome: { result: 'safe' }, canDrain: false });
    expect(heard).toHaveLength(1);
  });

  it('T8 — while shutdown is being prepared, a new child’s first instruction is not parked (no session would own it)', async () => {
    const { handler } = harness({ ownerId: 'U1', systemPrompt: 'cached' });
    const h = handler as any;
    h.followupShutdownPreparing = true;
    const enqueue = vi.fn(() => ({ status: 'queued' }));
    h.followupQueue = { enqueue };
    h.isQueueableFollowup = vi.fn(() => true);
    h.captureFollowupContext = vi.fn(() => ({}));
    h.resolveFollowupSessionKey = vi.fn(() => 'C1:9.9');
    const accepted = vi.fn();
    handler.onTurnAccepted('C1', '9.9', accepted);
    await handler.handleMessage(
      {
        user: 'U1',
        channel: 'C1',
        thread_ts: '9.9',
        ts: '9.9',
        text: 'go',
        epicChild: { taskId: 'child-1', parentTaskId: 'e1', planNodeId: 'login' },
      } as any,
      vi.fn() as any,
    );
    expect(enqueue).not.toHaveBeenCalled();
    expect(accepted).not.toHaveBeenCalled();
  });

  it('T7 — a cut turn the restart could not resume (its thread unreachable) ends its chain as interrupted', async () => {
    const { handler } = harness({ ownerId: 'U1', systemPrompt: 'cached' });
    const heard: Array<[string, unknown]> = [];
    handler.setChainSettledListener((key, outcome) => heard.push([key, outcome]));
    const h = handler as any;
    h.followupDispatcher = { isBusy: () => false };
    h.claudeHandler.getCrashRecoveredSessions = vi.fn(() => [
      {
        channelId: 'C1',
        threadTs: '9.9',
        ownerId: 'U1',
        activityState: 'working',
        sessionKey: 'C1:9.9',
        shouldAutoResume: true,
      },
      {
        channelId: 'C1',
        threadTs: '8.8',
        ownerId: 'U1',
        activityState: 'idle',
        sessionKey: 'C1:8.8',
        shouldAutoResume: false,
      },
    ]);
    h.claudeHandler.clearCrashRecoveredSessions = vi.fn();
    h.slackApi.postMessage = vi.fn().mockRejectedValue(new Error('channel_not_found'));
    h.pendingRetryNoticeMinutes = vi.fn(() => undefined);
    vi.useFakeTimers();
    try {
      const done = handler.notifyCrashRecovery();
      await vi.runAllTimersAsync();
      await done;
    } finally {
      vi.useRealTimers();
    }
    expect(heard).toEqual([['C1:9.9', { result: 'interrupted', reason: 'shutdown' }]]);
  });

  it('T6 — a chain a click drained (Send now / Resume / Retry) is heard too (review #872 astra)', async () => {
    const { handler } = harness({ ownerId: 'U1', systemPrompt: 'cached' });
    const heard: Array<[string, unknown]> = [];
    handler.setChainSettledListener((key, outcome) => heard.push([key, outcome]));
    const h = handler as any;
    const dispatcher = { isBusy: () => false };
    h.followupDispatcher = dispatcher;
    h.noteAutoCompactCut = vi.fn();
    h.resumeIfAutoCompactStop = vi.fn();
    h.releaseDeferredGoalDriver = vi.fn();
    h.runFollowupDrainLoop = vi.fn(async () => ({ outcome: { result: 'safe' }, canDrain: true }));
    const deps = h.buildFollowupActionDeps({} as any, dispatcher as any);
    // Resume: the drain ran the child's queued word to a healthy end.
    await deps.runDrain('C1:9.9');
    expect(heard).toEqual([['C1:9.9', { result: 'safe' }]]);
    // Send now with an empty queue: the click's own run is the chain's last.
    h.runFollowupDrainLoop = vi.fn(async () => undefined);
    await deps.runDrain('C1:9.9', { outcome: { result: 'error', reason: 'boom' }, canDrain: true });
    expect(heard[1]).toEqual(['C1:9.9', { result: 'error', reason: 'boom' }]);
  });
});
