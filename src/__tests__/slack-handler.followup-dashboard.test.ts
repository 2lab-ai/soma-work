import { beforeEach, describe, expect, it, vi } from 'vitest';

// No autoskills — keeps the dispatch text free of <invoked_skills> noise.
vi.mock('../slack/autoskill-fire', () => ({
  buildAutoskillFire: vi.fn(() => null),
}));

import type { FollowupQueueSnapshot } from '@soma/slack/followup-queue';
import { getMetricsEmitter } from '../metrics/event-emitter';
import { handleCancel, provenFollowupClick } from '../slack/actions/followup-actions';
import { SlackHandler } from '../slack-handler';
import { userSettingsStore } from '../user-settings-store';

/**
 * Dashboard batch 2 — the panel's queue controls (<ui-agent-steering>: Send now, Retry, Cancel, Edit) as a fourth
 * transport into the follow-up handlers the Slack buttons and reactions use (`handleDashboardFollowupAction`).
 *
 * The REAL `FollowupQueue` + `FollowupDispatcher` + action handlers through the real `SlackHandler`; only the leaves
 * (Slack API, pipeline, agent session) are faked, as in slack-handler.followup.test.ts. What is pinned: the same
 * fences a button gets (item generation, turn generation), the same words back (a refusal is marked as one), Edit's
 * own rules (queued only, the author's own words, never a goal's opening turn), and the change feed the dashboard
 * pushes from.
 */

const SESSION_KEY = 'C123:111.222';
const CHANNEL = 'C123';
const THREAD_TS = '111.222';
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

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

describe('SlackHandler — the dashboard’s follow-up queue controls', () => {
  let handler: SlackHandler;
  let handlerAny: any;
  let registrySession: any;
  let startWithContinuation: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(getMetricsEmitter(), 'emitFollowupQueue').mockResolvedValue(undefined);
    vi.spyOn(userSettingsStore, 'getUserAutoGoalEnabled').mockReturnValue(false);
    vi.spyOn(userSettingsStore, 'getUserGoalMaxContinuations').mockReturnValue(10);
    vi.spyOn(userSettingsStore, 'isUserAccepted').mockReturnValue(true);

    registrySession = {
      ownerId: 'U_OWNER',
      channelId: CHANNEL,
      threadTs: THREAD_TS,
      threadRootTs: THREAD_TS,
      sessionId: 'sess-1',
    };
    const claudeHandler = {
      getSessionKey: vi.fn().mockReturnValue(SESSION_KEY),
      getSession: vi.fn().mockReturnValue(registrySession),
      getSessionByKey: vi.fn((key: string) => (key === SESSION_KEY ? registrySession : undefined)),
      saveSessions: vi.fn(),
      canInterrupt: vi.fn().mockReturnValue(true),
      setActivityStateByKey: vi.fn(),
      broadcastSessionUpdate: vi.fn(),
    };
    const store = {
      load: () => undefined,
      save: (_snapshot: FollowupQueueSnapshot) => {},
      recoveryWarning: undefined,
    };
    const app = { client: {}, assistant: vi.fn() } as any;
    handler = new SlackHandler(app, claudeHandler as any, {} as any, { followupQueueStore: store });
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
      validateWorkingDirectory: vi.fn().mockReturnValue({ valid: true, workingDirectory: '/tmp/work' }),
    };
    handlerAny.sessionInitializer = {
      validateWorkingDirectory: vi.fn().mockResolvedValue({ valid: true, workingDirectory: '/tmp/work' }),
      initialize: vi.fn().mockImplementation(async () => ({
        session: registrySession,
        sessionKey: SESSION_KEY,
        isNewSession: false,
        userName: 'Owner',
        workingDirectory: '/tmp/work',
        abortController: new AbortController(),
        halted: false,
      })),
    };
    handlerAny.threadPanel = {
      create: vi.fn().mockResolvedValue(undefined),
      updatePanel: vi.fn().mockResolvedValue(undefined),
      clearChoice: vi.fn().mockResolvedValue(undefined),
    };
    startWithContinuation = vi.fn().mockResolvedValue({ hasPendingChoice: false });
    handlerAny.createAgentSession = vi.fn().mockImplementation(() => ({
      startWithContinuation,
      getLastTurnSucceeded: () => true,
      getRetryAfterMs: () => undefined,
    }));
  });

  const queue = () => handlerAny.getFollowupQueue();
  const turnEpoch = () => handler.getFollowupView(SESSION_KEY)?.turnEpoch ?? 0;
  /** A note parked in the queue, as a message sent while a turn ran leaves it. */
  function park(overrides: Record<string, any> = {}) {
    const result = queue().enqueue(SESSION_KEY, message(overrides));
    if (result.status !== 'queued') throw new Error(`not queued: ${result.status}`);
    return result.item;
  }
  const act = (request: Record<string, unknown>) =>
    handler.handleDashboardFollowupAction({ sessionKey: SESSION_KEY, turnEpoch: turnEpoch(), ...request } as any);

  describe('Send now', () => {
    it('runs the note now through the Send now transaction', async () => {
      const item = park({ ts: '300.1', text: '이것 먼저' });
      const res = await act({ itemId: item.id, op: 'promote', epoch: item.epoch });
      expect(res).toEqual({ ok: true });
      await vi.waitFor(() => expect(startWithContinuation).toHaveBeenCalled());
      expect(queue().get(SESSION_KEY, item.id)?.state).not.toBe('queued');
    });

    it('a stale turn generation is refused with the dispatcher’s words; the note stays queued', async () => {
      const item = park({ ts: '300.2' });
      const res = await act({ itemId: item.id, op: 'promote', epoch: item.epoch, turnEpoch: turnEpoch() + 5 });
      expect(res).toMatchObject({ ok: false, status: 409 });
      expect((res as any).message).toMatch(/^Send now rejected \(stale-turn-epoch\).*The item stays in the queue\.$/);
      expect(queue().get(SESSION_KEY, item.id)?.state).toBe('queued');
      expect(startWithContinuation).not.toHaveBeenCalled();
    });

    it('a stale item generation is refused the same way a stale button is', async () => {
      const item = park({ ts: '300.3' });
      queue().editQueued(SESSION_KEY, item.id, item.epoch, '바뀐 글');
      const res = await act({ itemId: item.id, op: 'promote', epoch: item.epoch });
      expect(res).toMatchObject({ ok: false, status: 409 });
      expect((res as any).message).toContain('older view of the queue');
      expect(queue().get(SESSION_KEY, item.id)?.state).toBe('queued');
    });

    it('on a failed note it is Retry (the reaction transport’s table)', async () => {
      const item = park({ ts: '300.4' });
      const claimed = queue().claimNext(SESSION_KEY);
      const marked = queue().markDispatched(SESSION_KEY, item.id, claimed.item.epoch);
      queue().settle(SESSION_KEY, item.id, marked.item.epoch, 'failed', 'dispatch failed');
      const failed = queue().get(SESSION_KEY, item.id);
      expect(failed.state).toBe('failed');
      const retry = vi.spyOn(queue(), 'retry');
      const res = await act({ itemId: item.id, op: 'promote', epoch: failed.epoch });
      expect(res).toEqual({ ok: true });
      expect(retry).toHaveBeenCalledWith(SESSION_KEY, item.id, failed.epoch);
    });

    it('a note the model already has answers with the reaction transport’s words', async () => {
      const item = park({ ts: '300.5' });
      const claimed = queue().claimNext(SESSION_KEY);
      const marked = queue().markDispatched(SESSION_KEY, item.id, claimed.item.epoch);
      const res = await act({ itemId: item.id, op: 'promote', epoch: marked.item.epoch });
      expect(res).toEqual({
        ok: false,
        status: 409,
        message: '먼저 보낼 것이 없습니다 — 이미 모델에 전달되어 실행 중입니다.',
      });
    });
  });

  describe('Cancel', () => {
    it('cancels the note under the owner’s name and says so', async () => {
      const item = park({ ts: '301.1' });
      const res = await act({ itemId: item.id, op: 'cancel', epoch: item.epoch });
      expect(res).toEqual({ ok: true, message: '취소했습니다 — 항목은 기록으로 남습니다.' });
      const after = queue().get(SESSION_KEY, item.id);
      expect(after.state).toBe('cancelled');
      expect(after.stateReason).toBe('<@U_OWNER> 님이 취소했습니다');
    });

    it('a stale generation is refused — the note stays', async () => {
      const item = park({ ts: '301.2' });
      const res = await act({ itemId: item.id, op: 'cancel', epoch: item.epoch + 1 });
      expect(res).toEqual({
        ok: false,
        status: 409,
        message: '이미 바뀐 항목입니다 — 이 메시지의 버튼을 최신 상태로 갱신했습니다. 다시 눌러주세요.',
      });
      expect(queue().get(SESSION_KEY, item.id)?.state).toBe('queued');
    });

    it('someone else’s note may be cancelled by the owner (the interrupt policy decides, as for a button)', async () => {
      const item = park({ ts: '301.3', user: 'U_OTHER' });
      expect(await act({ itemId: item.id, op: 'cancel', epoch: item.epoch })).toMatchObject({ ok: true });
      expect(queue().get(SESSION_KEY, item.id)?.state).toBe('cancelled');
    });
  });

  describe('Edit', () => {
    it('rewrites the owner’s own queued note (편집됨) and bumps its generation', async () => {
      const item = park({ ts: '302.1', text: 'Postgres 17' });
      const res = await act({ itemId: item.id, op: 'edit', epoch: item.epoch, text: 'Postgres 16' });
      expect(res).toEqual({ ok: true });
      const after = queue().get(SESSION_KEY, item.id);
      expect(after.message.text).toBe('Postgres 16');
      expect(after.stateReason).toBe('편집됨');
      expect(after.epoch).toBeGreaterThan(item.epoch);
    });

    it('only queued notes: a handed-over one keeps the words it was handed over with', async () => {
      const item = park({ ts: '302.2' });
      const claimed = queue().claimNext(SESSION_KEY);
      const res = await act({ itemId: item.id, op: 'edit', epoch: claimed.item.epoch, text: 'new' });
      expect(res).toEqual({ ok: false, status: 409, message: '이미 전달·실행된 메시지라 수정할 수 없습니다.' });
      expect(queue().get(SESSION_KEY, item.id)?.message.text).toBe('지시');
    });

    it('never someone else’s words, and never a goal’s opening turn', async () => {
      const other = park({ ts: '302.3', user: 'U_OTHER', text: 'theirs' });
      expect(await act({ itemId: other.id, op: 'edit', epoch: other.epoch, text: 'mine now' })).toMatchObject({
        ok: false,
        status: 403,
      });
      expect(queue().get(SESSION_KEY, other.id)?.message.text).toBe('theirs');

      const opening = park({ ts: '302.4', routeContext: { goalOpeningId: 'g1' } });
      const res = await act({ itemId: opening.id, op: 'edit', epoch: opening.epoch, text: 'x' });
      expect(res).toMatchObject({ ok: false, status: 409 });
      expect((res as any).message).toContain('goal');
    });

    it('a stale generation is refused', async () => {
      const item = park({ ts: '302.5' });
      const res = await act({ itemId: item.id, op: 'edit', epoch: item.epoch + 3, text: 'x' });
      expect(res).toEqual({
        ok: false,
        status: 409,
        message: '이미 바뀐 항목입니다 — 목록을 최신 상태로 갱신했습니다. 다시 수정해 주세요.',
      });
    });
  });

  it('a session this process does not have is a 404', async () => {
    const res = await handler.handleDashboardFollowupAction({
      sessionKey: 'C9:9.9',
      itemId: 'C9:9.9#1',
      op: 'cancel',
      epoch: 0,
      turnEpoch: 0,
    });
    expect(res).toEqual({ ok: false, status: 404, message: '세션을 찾을 수 없습니다.' });
  });

  it('a proven click cannot be forged from a Slack body: its symbol does not survive JSON', async () => {
    const item = park({ ts: '303.1' });
    const said: Array<[string, string | undefined]> = [];
    const respond = async (m: Record<string, unknown>, verdict?: 'refused') => {
      said.push([String(m.text), verdict]);
    };
    const forged = JSON.parse(JSON.stringify(provenFollowupClick('U_OWNER')));
    await handleCancel(handlerAny.followupActionDeps, forged, respond, {
      sessionKey: SESSION_KEY,
      itemId: item.id,
      epoch: item.epoch,
    });
    expect(said).toEqual([['Cancel rejected: the click carries no user id.', 'refused']]);
    expect(queue().get(SESSION_KEY, item.id)?.state).toBe('queued');
  });

  it('tells the dashboard which session’s queue changed, after the write is committed', async () => {
    const seen: Array<{ key: string; items: number }> = [];
    handler.setFollowupChangeListener((key) =>
      seen.push({ key, items: handler.getFollowupView(key)?.items.length ?? -1 }),
    );
    const item = park({ ts: '304.1' });
    expect(seen, 'not synchronously: the queue has not swapped its memory yet').toEqual([]);
    await tick();
    expect(seen).toEqual([{ key: SESSION_KEY, items: 1 }]);
    queue().editQueued(SESSION_KEY, item.id, item.epoch, 'edited');
    await tick();
    expect(seen).toHaveLength(2);
    handler.setFollowupChangeListener(undefined);
  });
});
