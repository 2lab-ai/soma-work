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

  /**
   * Incident 2026-11-10 (dev): "T4부터 진행 지금 당장" was cut 16 s into its turn by another row's
   * Send now, its Retry put it back in line — and it waited 25 minutes behind the turn that was
   * running, with 지금 보내기 as the only way in. A message sent while a turn works is handed to that
   * turn (06 §3.2 D1); a row a person puts back in line while a turn works is the same message.
   */
  describe('a row put back in line while a turn runs', () => {
    async function busyTurn() {
      let finish: (value: { hasPendingChoice: boolean }) => void = () => {};
      startWithContinuation.mockImplementationOnce(
        () => new Promise<{ hasPendingChoice: boolean }>((resolve) => (finish = resolve)),
      );
      const turn = handler.handleMessage(message({ ts: '310.1', text: '시작' }), vi.fn() as any);
      await vi.waitFor(() => expect(startWithContinuation).toHaveBeenCalled());
      return async () => {
        finish({ hasPendingChoice: false });
        await turn;
      };
    }
    /** A row whose own turn was cut (`uncertain`), as an interrupt leaves it. */
    function cutRow(overrides: Record<string, any>, context: Record<string, unknown> = {}) {
      const result = queue().enqueue(SESSION_KEY, message(overrides), context);
      if (result.status !== 'queued') throw new Error(`not queued: ${result.status}`);
      const item = result.item;
      const claimed = queue().claimNext(SESSION_KEY);
      const marked = queue().markDispatched(SESSION_KEY, item.id, claimed.item.epoch);
      queue().markInterrupted(SESSION_KEY, item.id, marked.item.epoch, '턴이 중단되었습니다');
      return queue().get(SESSION_KEY, item.id);
    }

    it('Retry hands it to the running turn', async () => {
      const cut = cutRow({ ts: '310.2', text: 'T4부터 진행 지금 당장' });
      expect(cut.state).toBe('uncertain');
      const steerTurn = vi.fn().mockReturnValue(true);
      handlerAny.claudeHandler.steerTurn = steerTurn;
      const settle = await busyTurn();

      const res = await act({ itemId: cut.id, op: 'promote', epoch: cut.epoch });

      expect(res).toEqual({ ok: true });
      await vi.waitFor(() => expect(steerTurn).toHaveBeenCalledTimes(1));
      expect(steerTurn.mock.calls[0][1].text).toContain('T4부터 진행 지금 당장');
      expect(queue().get(SESSION_KEY, cut.id)?.state).toBe('steered');
      await settle();
    });

    // The stored row is replayed work: what the drain checks before it runs one, the hand-over checks
    // too (`authorizeFollowupDispatch` — the author still accepted, the directory it was stored for
    // still theirs). A refused row stays in line; the drain says why (review #1178).
    it('a row whose stored working directory is no longer the author’s is not handed over', async () => {
      const cut = cutRow({ ts: '310.4', text: '다른 디렉토리에서 저장된 지시' }, { workingDirectory: '/tmp/work' });
      const steerTurn = vi.fn().mockReturnValue(true);
      handlerAny.claudeHandler.steerTurn = steerTurn;
      const settle = await busyTurn();
      handlerAny.messageValidator.validateWorkingDirectory.mockReturnValue({
        valid: true,
        workingDirectory: '/tmp/moved-elsewhere',
      });
      expect(queue().get(SESSION_KEY, cut.id).context?.workingDirectory).toBe('/tmp/work');

      await act({ itemId: cut.id, op: 'promote', epoch: cut.epoch });
      await tick();
      await tick();

      expect(steerTurn).not.toHaveBeenCalled();
      expect(queue().get(SESSION_KEY, cut.id)?.state).toBe('queued');
      handlerAny.messageValidator.validateWorkingDirectory.mockReturnValue({
        valid: true,
        workingDirectory: '/tmp/work',
      });
      await settle();
    });

    // FIFO holds: an older row put back in line goes in ahead of a newer one already waiting for the
    // turn to open its input (review #1178).
    it('an older row goes in ahead of a newer row that already waits for the turn', async () => {
      const older = cutRow({ ts: '310.5', text: '먼저 보낸 지시' });
      const newer = park({ ts: '310.6', text: '나중에 보낸 지시' });
      const steerTurn = vi.fn().mockReturnValue(true);
      handlerAny.claudeHandler.steerTurn = steerTurn;
      const settle = await busyTurn();
      const live = handlerAny.followupDispatcher.liveTurnEpoch(SESSION_KEY);
      handlerAny.waitForTurnOpen(SESSION_KEY, {
        rowKey: SESSION_KEY,
        itemId: newer.id,
        turnEpoch: live,
        what: 'test: waits for the turn',
      });

      await act({ itemId: older.id, op: 'promote', epoch: older.epoch });

      await vi.waitFor(() => expect(steerTurn).toHaveBeenCalledTimes(2));
      expect(steerTurn.mock.calls.map((call) => call[1].text)).toEqual([
        expect.stringContaining('먼저 보낸 지시'),
        expect.stringContaining('나중에 보낸 지시'),
      ]);
      await settle();
    });

    it('Retry with nothing running still runs it as its own turn', async () => {
      const cut = cutRow({ ts: '310.3', text: '혼자 실행' });
      const steerTurn = vi.fn().mockReturnValue(true);
      handlerAny.claudeHandler.steerTurn = steerTurn;

      const res = await act({ itemId: cut.id, op: 'promote', epoch: cut.epoch });

      expect(res).toEqual({ ok: true });
      await vi.waitFor(() => expect(startWithContinuation).toHaveBeenCalled());
      expect(steerTurn).not.toHaveBeenCalled();
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

  // The panel's <ui-agent-steering> offers Send now and Cancel on a delivered note (@2lab.ai/ui 0.40.0) — a note the
  // running turn holds in the SDK's input queue but the model has not read yet. Both reach the button's own doors:
  // Cancel asks the SDK to withdraw it first; Send now unsteers it and runs it now.
  describe('a delivered (steered) note', () => {
    const steered = (ts: string, uuid: string) => {
      const item = park({ ts });
      const moved = queue().steer(SESSION_KEY, item.id, item.epoch, uuid);
      if (!moved.ok) throw new Error(`not steered: ${moved.reason}`);
      return queue().get(SESSION_KEY, item.id);
    };
    const sdk = (verdict: 'withdrawn' | 'already-dequeued' | 'unreachable') => {
      const cancel = vi.fn().mockResolvedValue(verdict);
      handlerAny.claudeHandler.cancelSteeredMessage = cancel;
      return cancel;
    };

    it('Cancel withdraws it from the SDK before the model reads it, and says so', async () => {
      const item = steered('303.1', 'uuid-303-1');
      const cancel = sdk('withdrawn');
      const res = await act({ itemId: item.id, op: 'cancel', epoch: item.epoch });
      expect(cancel).toHaveBeenCalledWith(SESSION_KEY, 'uuid-303-1');
      expect(res).toEqual({ ok: true, message: '취소했습니다 — 모델에 전달되기 전에 회수했습니다.' });
      expect(queue().get(SESSION_KEY, item.id)?.state).toBe('cancelled');
    });

    it('a Cancel that came too late is not a success: the model has it, and the answer says it was not done', async () => {
      const item = steered('303.2', 'uuid-303-2');
      sdk('already-dequeued');
      const res = await act({ itemId: item.id, op: 'cancel', epoch: item.epoch });
      expect(res).toEqual({
        ok: true,
        message: '취소하지 못했습니다 — 이미 모델에 전달되어 실행 중입니다.',
        unfulfilled: true,
      });
      expect(queue().get(SESSION_KEY, item.id)?.state).toBe('resolved');
    });

    it('a Cancel the SDK could not answer puts the note back in line, and says it was not done', async () => {
      const item = steered('303.3', 'uuid-303-3');
      sdk('unreachable');
      const res = await act({ itemId: item.id, op: 'cancel', epoch: item.epoch });
      expect(res).toEqual({
        ok: true,
        message: '취소하지 못했습니다 — 전달 여부를 확인할 수 없어 큐로 되돌렸습니다. 다시 Cancel 할 수 있습니다.',
        unfulfilled: true,
      });
      expect(queue().get(SESSION_KEY, item.id)?.state).toBe('queued');
    });

    it('Send now takes it out of the running turn’s input queue and runs it now', async () => {
      const item = steered('303.4', 'uuid-303-4');
      const res = await act({ itemId: item.id, op: 'promote', epoch: item.epoch });
      expect(res).toEqual({ ok: true });
      await vi.waitFor(() => expect(startWithContinuation).toHaveBeenCalled());
      expect(queue().get(SESSION_KEY, item.id)?.state).not.toBe('steered');
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

  // SSOT 2026-11-02 — a dashboard user who may not manage the session presses as
  // themselves, so the button's own rules answer: the interrupt policy for Send now
  // and Cancel (here: refused), only the author for Edit (their own note: allowed).
  describe('a presser who may not manage the session (SSOT 2026-11-02)', () => {
    it('Cancel and Send now ask the interrupt policy about that user, not the owner', async () => {
      const canInterrupt = handlerAny.claudeHandler.canInterrupt as ReturnType<typeof vi.fn>;
      canInterrupt.mockImplementation((_c: string, _t: string, user: string) => user === 'U_OWNER');
      const item = park({ ts: '303.1' });
      const press = { itemId: item.id, epoch: item.epoch, actorUserId: 'U_OTHER', manages: false };
      expect(await act({ ...press, op: 'cancel' })).toMatchObject({ ok: false, status: 409 });
      expect(await act({ ...press, op: 'promote' })).toMatchObject({ ok: false, status: 409 });
      expect(queue().get(SESSION_KEY, item.id)?.state).toBe('queued');
      expect(canInterrupt).toHaveBeenCalledWith(CHANNEL, THREAD_TS, 'U_OTHER');
      // One who manages it (the owner, an admin in admin mode) presses as the owner.
      expect(await act({ ...press, op: 'cancel', manages: true })).toMatchObject({ ok: true });
      expect(queue().get(SESSION_KEY, item.id)?.state).toBe('cancelled');
    });

    it('Edit: their own note yes, the owner’s words no', async () => {
      const theirs = park({ ts: '303.2', user: 'U_OTHER', text: 'theirs' });
      const press = { op: 'edit', actorUserId: 'U_OTHER', manages: false };
      expect(await act({ ...press, itemId: theirs.id, epoch: theirs.epoch, text: 'fixed' })).toEqual({ ok: true });
      const owners = park({ ts: '303.3', text: 'owner words' });
      expect(await act({ ...press, itemId: owners.id, epoch: owners.epoch, text: 'x' })).toMatchObject({
        ok: false,
        status: 403,
      });
      expect(queue().get(SESSION_KEY, owners.id)?.message.text).toBe('owner words');
      // An admin in admin mode (manages) edits their own note — and not the owner's (only the author rewrites).
      const admins = park({ ts: '303.4', user: 'U_ADMIN', text: 'admin words' });
      const admin = { op: 'edit', actorUserId: 'U_ADMIN', manages: true };
      expect(await act({ ...admin, itemId: admins.id, epoch: admins.epoch, text: 'fixed' })).toEqual({ ok: true });
      const owners2 = park({ ts: '303.5', text: 'owner words 2' });
      expect(await act({ ...admin, itemId: owners2.id, epoch: owners2.epoch, text: 'x' })).toMatchObject({
        ok: false,
        status: 403,
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
    const respond = async (m: Record<string, unknown>, verdict?: 'refused' | 'unfulfilled') => {
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

  // Delivery evidence moves no generation (`markDelivered` keeps the run's settle token), yet it is what takes a
  // note off the panel's waiting list (dashboard.ts isRunningTurn): the dashboard has to hear that write too.
  it('tells the dashboard when a note’s own turn reached the model', async () => {
    // Listening from the start: the first write a listener hears is always new to it.
    const seen: string[] = [];
    handler.setFollowupChangeListener((key) => seen.push(key));
    const item = park({ ts: '304.5' });
    const claimed = queue().claimNext(SESSION_KEY);
    const marked = queue().markDispatched(SESSION_KEY, item.id, claimed.item.epoch);
    await tick();
    expect(seen.length).toBeGreaterThan(0);
    seen.length = 0;

    const delivered = queue().markDelivered(SESSION_KEY, item.id, marked.item.epoch);
    await tick();

    expect(delivered.ok && delivered.item.epoch).toBe(marked.item.epoch);
    expect(seen).toEqual([SESSION_KEY]);
    // Idempotent: every later leg of the turn reports again, and nothing changed.
    queue().markDelivered(SESSION_KEY, item.id, marked.item.epoch);
    await tick();
    expect(seen).toEqual([SESSION_KEY]);
    handler.setFollowupChangeListener(undefined);
  });

  // SSOT 2026-11-06 (dev, this thread): the slot is taken at dispatch, but activityState turns working only once the
  // SDK query answers — 85 s later that day. The dashboard reads the slot (isFollowupTurnBusy) so a message sent in
  // between waits in the queue on the panel too, and it hears when the slot is taken and released — a run that
  // involves no queued row commits nothing to the queue when it ends.
  it('a turn holds the session from dispatch until it settles, and the dashboard hears both moments', async () => {
    const seen: Array<{ key: string; busy: boolean }> = [];
    handler.setFollowupChangeListener((key) => seen.push({ key, busy: handler.isFollowupTurnBusy(key) }));
    let finish: (value: { hasPendingChoice: boolean }) => void = () => {};
    startWithContinuation.mockImplementationOnce(
      () => new Promise<{ hasPendingChoice: boolean }>((resolve) => (finish = resolve)),
    );
    expect(handler.isFollowupTurnBusy(SESSION_KEY)).toBe(false);
    const turn = handler.handleMessage(message({ ts: '305.1', text: '시작' }), vi.fn() as any);
    await vi.waitFor(() => expect(startWithContinuation).toHaveBeenCalled());
    expect(handler.isFollowupTurnBusy(SESSION_KEY)).toBe(true);
    await vi.waitFor(() => expect(seen).toContainEqual({ key: SESSION_KEY, busy: true }));
    finish({ hasPendingChoice: false });
    await turn;
    await vi.waitFor(() => expect(handler.isFollowupTurnBusy(SESSION_KEY)).toBe(false));
    await vi.waitFor(() => expect(seen[seen.length - 1]).toEqual({ key: SESSION_KEY, busy: false }));
    handler.setFollowupChangeListener(undefined);
  });
});
