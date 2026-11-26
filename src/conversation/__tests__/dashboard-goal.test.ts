import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * SSOT 2026-10-21 T2/T3 — the work item shows the session's goal list (current
 * goal + its state + the goals queued behind it) and lets the owner add a goal,
 * delete the current goal (the next one starts) or delete a queued goal.
 *
 * The server half: the card payload (`KanbanSession.goal`) and the one write
 * route. The goal semantics live in `SlackHandler.handleHostGoalAction`
 * (covered in `slack-handler.host-goal-action.test.ts`); here the handler is a
 * double and what is pinned is the HTTP contract around it.
 */

const mockConfig = {
  conversation: {
    summaryModel: 'claude-haiku-4-20250414',
    viewerHost: '127.0.0.1',
    viewerPort: 0,
    viewerUrl: '',
    viewerToken: 'test-token',
  },
  oauth: {
    google: { clientId: '', clientSecret: '' },
    microsoft: { clientId: '', clientSecret: '' },
    jwtSecret: '',
    jwtExpiresIn: 604800,
  },
};

vi.mock('../../config', () => ({ config: mockConfig }));
vi.mock('../../env-paths', () => ({ IS_DEV: true, DATA_DIR: '/tmp/test-data' }));
vi.mock('../recorder', () => ({
  listConversations: vi.fn().mockResolvedValue([]),
  getConversation: vi.fn().mockResolvedValue(null),
  getTurnRawContent: vi.fn().mockResolvedValue(null),
}));
vi.mock('../viewer', () => ({
  renderConversationListPage: vi.fn().mockReturnValue('<html></html>'),
  renderConversationViewPage: vi.fn().mockReturnValue('<html></html>'),
}));
vi.mock('../../session-archive', () => ({
  getArchiveStore: () => ({ listRecent: () => [] }),
}));

const AUTH_HEADER = { Authorization: 'Bearer test-token' };

function goal(overrides: Record<string, any> = {}) {
  return {
    goalId: 'g1',
    objective: '대시보드 개선',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    createdBy: 'U1',
    continuationCount: 2,
    maxContinuations: 10,
    epoch: 5,
    ...overrides,
  };
}

function liveSession(overrides: Record<string, any> = {}) {
  return {
    sessionId: 'sid1',
    ownerId: 'U1',
    channelId: 'C1',
    threadTs: 't1',
    activityState: 'working',
    state: 'MAIN',
    lastActivity: new Date('2026-10-21T00:00:00Z'),
    ...overrides,
  };
}

describe('Dashboard — work item goal list (SSOT T2/T3)', () => {
  let startWebServer: any;
  let stopWebServer: any;
  let injectWebServer: any;
  let dashboard: any;
  let HostGoalActionError: any;

  beforeEach(async () => {
    vi.resetModules();
    const webServer = await import('../web-server');
    startWebServer = webServer.startWebServer;
    stopWebServer = webServer.stopWebServer;
    injectWebServer = webServer.injectWebServer;
    dashboard = await import('../dashboard');
    HostGoalActionError = (await import('../../slack/goal-host-actions')).HostGoalActionError;
    await startWebServer({ listen: false });
  });

  afterEach(async () => {
    await stopWebServer();
  });

  async function board(sessions: Map<string, any>) {
    dashboard.setDashboardSessionAccessor(() => sessions);
    const res = await injectWebServer({ method: 'GET', url: '/api/dashboard/sessions', headers: AUTH_HEADER });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body).board;
  }

  describe('goal stall — the card says the loop stopped on a repeated failure', () => {
    it('carries the stall reason', async () => {
      const sessions = new Map<string, any>([
        [
          'C1:t1',
          liveSession({
            goal: goal({
              lastEvalReason: 'dev에 에픽이 없다',
              stall: {
                stallId: 's1',
                stalledAt: 77,
                reason: 'dev에 에픽이 없다',
                actions: ['a', 'b', 'c'],
                confidence: 0.98,
              },
            }),
          }),
        ],
      ]);
      const board_ = await board(sessions);
      const card = [...(board_.working ?? []), ...(board_.waiting ?? []), ...(board_.done ?? [])][0];
      expect(card.goal.current.stalled).toEqual({ at: 77, reason: 'dev에 에픽이 없다', actions: ['a', 'b', 'c'] });
    });
  });

  describe('T2 — the card carries the current goal, its state and the queue', () => {
    it('serializes current goal, status, progress, eval gap and queued goals in order', async () => {
      const sessions = new Map<string, any>([
        [
          'C1:t1',
          liveSession({
            goal: goal({ lastEvalReason: '테스트가 아직 없다' }),
            goalQueue: [
              goal({ goalId: 'g2', objective: '두번째', status: 'queued' }),
              goal({ goalId: 'g3', objective: '세번째', status: 'queued' }),
            ],
            goalHistory: [goal({ goalId: 'g0', status: 'complete' })],
          }),
        ],
      ]);

      const card = (await board(sessions)).working[0];

      expect(card.goal).toEqual({
        current: {
          goalId: 'g1',
          objective: '대시보드 개선',
          status: 'active',
          continuationCount: 2,
          maxContinuations: 10,
          lastEvalReason: '테스트가 아직 없다',
          // .prd/39 S3 — the phase the goal line names (PR10).
          phase: { kind: 'running' },
        },
        queue: [
          { goalId: 'g2', objective: '두번째' },
          { goalId: 'g3', objective: '세번째' },
        ],
        paused: [],
        completedCount: 1,
        // SSOT 2026-10-22 T6 — the completed goals themselves, newest first.
        history: [{ goalId: 'g0', objective: '대시보드 개선', createdAt: 1, continuationCount: 2 }],
      });
    });

    it('shows a paused and a completed current goal with their status', async () => {
      const paused = (await board(new Map([['C1:t1', liveSession({ goal: goal({ status: 'paused' }) })]]))).working[0];
      expect(paused.goal.current.status).toBe('paused');

      const done = (await board(new Map([['C1:t1', liveSession({ goal: goal({ status: 'complete' }) })]]))).working[0];
      expect(done.goal.current.status).toBe('complete');
    });

    it('carries the paused goals (SSOT 2026-11-06) — a session with only paused goals still has a goal block', async () => {
      const card = (
        await board(
          new Map([
            [
              'C1:t1',
              liveSession({
                goal: undefined,
                goalPaused: [goal({ goalId: 'p1', objective: '쉬는 목표', status: 'paused' })],
              }),
            ],
          ]),
        )
      ).working[0];
      expect(card.goal.current).toBeUndefined();
      expect(card.goal.paused).toEqual([{ goalId: 'p1', objective: '쉬는 목표' }]);
    });

    it('omits the goal block for a session that never had a goal', async () => {
      const card = (await board(new Map([['C1:t1', liveSession()]]))).working[0];
      expect(card.goal).toBeUndefined();
    });
  });

  describe('T3 — POST /api/dashboard/session/:key/goal', () => {
    async function post(payload: any, key = 'C1:t1') {
      return injectWebServer({
        method: 'POST',
        url: `/api/dashboard/session/${encodeURIComponent(key)}/goal`,
        headers: AUTH_HEADER,
        payload,
      });
    }

    beforeEach(() => {
      dashboard.setDashboardSessionAccessor(() => new Map([['C1:t1', liveSession({ goal: goal() })]]));
    });

    it('adds a goal through the host handler', async () => {
      const handler = vi.fn().mockResolvedValue({ outcome: 'queued', goalId: 'g2', position: 1 });
      dashboard.setDashboardGoalHandler(handler);

      const res = await post({ action: 'add', objective: '  새 목표  ' });

      expect(res.statusCode).toBe(200);
      expect(handler).toHaveBeenCalledWith('C1:t1', { action: 'add', objective: '  새 목표  ' }, undefined);
      expect(JSON.parse(res.body)).toEqual({ ok: true, result: { outcome: 'queued', goalId: 'g2', position: 1 } });
    });

    it('deletes the current goal (the next one starts) and a queued goal, naming where it was seen', async () => {
      const handler = vi.fn().mockResolvedValue({ outcome: 'deleted', goalId: 'g1' });
      dashboard.setDashboardGoalHandler(handler);

      expect((await post({ action: 'delete', goalId: 'g1', expect: 'current' })).statusCode).toBe(200);
      expect((await post({ action: 'delete', goalId: 'g2', expect: 'queued' })).statusCode).toBe(200);

      expect(handler.mock.calls.map((call: any[]) => call[1])).toEqual([
        { action: 'delete', goalId: 'g1', expect: 'current' },
        { action: 'delete', goalId: 'g2', expect: 'queued' },
      ]);
    });

    it('pauses the current goal and resumes a paused one through the host handler', async () => {
      const handler = vi.fn().mockResolvedValue({ outcome: 'paused', goalId: 'g1' });
      dashboard.setDashboardGoalHandler(handler);

      expect((await post({ action: 'pause', goalId: 'g1' })).statusCode).toBe(200);
      expect((await post({ action: 'resume', goalId: 'p1' })).statusCode).toBe(200);
      expect((await post({ action: 'delete', goalId: 'p1', expect: 'paused' })).statusCode).toBe(200);

      expect(handler.mock.calls.map((call: any[]) => call[1])).toEqual([
        { action: 'pause', goalId: 'g1' },
        { action: 'resume', goalId: 'p1' },
        { action: 'delete', goalId: 'p1', expect: 'paused' },
      ]);
    });

    // 2026-11-26 — the goal composer: an add carries files; a queued goal is moved (drag) or edited in place.
    it('an add with the composer files: decoded (base64 → bytes) after the session gate, handed with the objective', async () => {
      const handler = vi.fn().mockResolvedValue({ outcome: 'started', goalId: 'g2', opening: 'started' });
      dashboard.setDashboardGoalHandler(handler);

      const res = await post({
        action: 'add',
        objective: '스크린샷 보고 고쳐줘',
        attachments: [{ name: 'shot.png', mimetype: 'image/png', data: Buffer.from('png-bytes').toString('base64') }],
      });

      expect(res.statusCode).toBe(200);
      const action = handler.mock.calls[0][1];
      expect(action.action).toBe('add');
      expect(action.objective).toBe('스크린샷 보고 고쳐줘');
      expect(action.attachments).toHaveLength(1);
      expect(action.attachments[0].name).toBe('shot.png');
      expect(action.attachments[0].mimetype).toBe('image/png');
      expect(Buffer.from(action.attachments[0].data).toString()).toBe('png-bytes');
    });

    it('an add without files hands no attachments key; an empty list is the same', async () => {
      const handler = vi.fn().mockResolvedValue({ outcome: 'queued', goalId: 'g2', position: 1 });
      dashboard.setDashboardGoalHandler(handler);
      await post({ action: 'add', objective: 'a' });
      await post({ action: 'add', objective: 'b', attachments: [] });
      expect(handler.mock.calls.map((c: any[]) => c[1])).toEqual([
        { action: 'add', objective: 'a' },
        { action: 'add', objective: 'b' },
      ]);
    });

    it('moves a queued goal to a queue index and edits a queued goal through the host handler', async () => {
      const handler = vi.fn().mockResolvedValue({ outcome: 'moved', goalId: 'g3', position: 1 });
      dashboard.setDashboardGoalHandler(handler);

      expect((await post({ action: 'move', goalId: 'g3', to: 0 })).statusCode).toBe(200);
      expect((await post({ action: 'edit', goalId: 'g2', objective: '고친 목표' })).statusCode).toBe(200);

      expect(handler.mock.calls.map((call: any[]) => call[1])).toEqual([
        { action: 'move', goalId: 'g3', to: 0 },
        { action: 'edit', goalId: 'g2', objective: '고친 목표' },
      ]);
    });

    it('a body over the default 1 MB takes the composer limit (a phone photo fits)', async () => {
      const handler = vi.fn().mockResolvedValue({ outcome: 'queued', goalId: 'g2', position: 1 });
      dashboard.setDashboardGoalHandler(handler);
      const big = Buffer.alloc(2 * 1024 * 1024, 7).toString('base64');
      const res = await post({
        action: 'add',
        objective: '사진',
        attachments: [{ name: 'p.jpg', mimetype: 'image/jpeg', data: big }],
      });
      expect(res.statusCode).toBe(200);
      expect(handler.mock.calls[0][1].attachments[0].data.length).toBe(2 * 1024 * 1024);
    });

    it.each([
      [{ action: 'add', objective: 'x', attachments: 'nope' }, /attachments/],
      [{ action: 'add', objective: 'x', attachments: [{ name: 'a', data: '!!!' }] }, /base64/],
      [{ action: 'move', goalId: 'g2' }, /to must be/],
      [{ action: 'move', goalId: 'g2', to: -1 }, /to must be/],
      [{ action: 'move', goalId: 'g2', to: 1.5 }, /to must be/],
      [{ action: 'move', to: 0 }, /goalId/],
      [{ action: 'edit', goalId: 'g2' }, /objective/],
      [{ action: 'edit', goalId: 'g2', objective: '  ' }, /objective/],
      [{ action: 'edit', goalId: 'g2', objective: 'x'.repeat(4001) }, /4000/],
      [{ action: 'edit', objective: 'x' }, /goalId/],
    ])('rejects a malformed move / edit / attachments body %j with 400', async (payload, message) => {
      const handler = vi.fn();
      dashboard.setDashboardGoalHandler(handler);

      const res = await post(payload);

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(message);
      expect(handler).not.toHaveBeenCalled();
    });

    it.each([
      [{}, /action/],
      [{ action: 'pause' }, /goalId/],
      [{ action: 'resume', goalId: 'x'.repeat(201) }, /goalId/],
      [{ action: 'clear' }, /action/],
      [{ action: 'add' }, /objective/],
      [{ action: 'add', objective: '   ' }, /objective/],
      [{ action: 'add', objective: 'x'.repeat(4001) }, /4000/],
      [{ action: 'delete', goalId: 'g1' }, /expect/],
      [{ action: 'delete', expect: 'current' }, /goalId/],
    ])('rejects a malformed body %j with 400 before touching the session', async (payload, message) => {
      const handler = vi.fn();
      dashboard.setDashboardGoalHandler(handler);

      const res = await post(payload);

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(message);
      expect(handler).not.toHaveBeenCalled();
    });

    it.each([
      [404, 'Session not found'],
      [409, 'The current goal has changed — refresh and try again'],
      [502, 'Could not post to the Slack thread — nothing was changed'],
      [503, 'Goal was not started — queue full'],
    ])('answers a host refusal with its status %i and message', async (status, message) => {
      dashboard.setDashboardGoalHandler(vi.fn().mockRejectedValue(new HostGoalActionError(status, message)));

      const res = await post({ action: 'delete', goalId: 'g1', expect: 'current' });

      expect(res.statusCode).toBe(status);
      expect(JSON.parse(res.body).error).toBe(message);
    });

    it('answers an unexpected handler crash with 500 and no detail', async () => {
      dashboard.setDashboardGoalHandler(vi.fn().mockRejectedValue(new Error('boom internal-detail')));

      const res = await post({ action: 'add', objective: 'x' });

      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain('internal-detail');
    });
  });

  // SSOT 2026-11-19 — 중지 while a goal runs: the card asks, and the yes rides the stop as `pauseGoalId`.
  describe('POST /api/dashboard/session/:key/stop — pause the running goal first', () => {
    async function stop(payload?: any, key = 'C1:t1') {
      return injectWebServer({
        method: 'POST',
        url: `/api/dashboard/session/${encodeURIComponent(key)}/stop`,
        headers: AUTH_HEADER,
        ...(payload === undefined ? {} : { payload }),
      });
    }

    beforeEach(() => {
      dashboard.setDashboardSessionAccessor(() => new Map([['C1:t1', liveSession({ goal: goal() })]]));
    });

    it('passes the goal to pause to the stop handler', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      dashboard.setDashboardStopHandler(handler);

      const res = await stop({ pauseGoalId: 'g1' });

      expect(res.statusCode).toBe(200);
      expect(handler).toHaveBeenCalledWith('C1:t1', { pauseGoalId: 'g1' });
    });

    it('a plain stop while a goal runs (a stale card that did not ask): refused with the goal, so the card asks', async () => {
      dashboard.setDashboardSessionAccessor(
        () =>
          new Map([
            [
              'C1:t1',
              liveSession({ goal: goal(), goalQueue: [goal({ goalId: 'g2', objective: '다음', status: 'queued' })] }),
            ],
          ]),
      );
      const handler = vi.fn();
      dashboard.setDashboardStopHandler(handler);

      const res = await stop();

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).goal).toEqual({ goalId: 'g1', objective: '대시보드 개선', queued: 1 });
      expect(handler).not.toHaveBeenCalled();
    });

    it('no body: a plain stop, as before (no goal runs)', async () => {
      dashboard.setDashboardSessionAccessor(
        () => new Map([['C1:t1', liveSession({ goal: goal({ status: 'paused' }) })]]),
      );
      const handler = vi.fn().mockResolvedValue(undefined);
      dashboard.setDashboardStopHandler(handler);

      expect((await stop()).statusCode).toBe(200);
      expect((await stop({})).statusCode).toBe(200);
      expect(handler.mock.calls).toEqual([['C1:t1'], ['C1:t1']]);
    });

    it.each([
      [{ pauseGoalId: '' }],
      [{ pauseGoalId: 7 }],
      [{ pauseGoalId: 'x'.repeat(201) }],
    ])('rejects a malformed goal id %j with 400 before stopping anything', async (payload) => {
      const handler = vi.fn();
      dashboard.setDashboardStopHandler(handler);

      const res = await stop(payload);

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/pauseGoalId/);
      expect(handler).not.toHaveBeenCalled();
    });

    it('a refused goal pause answers with its status and reason — nothing was stopped', async () => {
      dashboard.setDashboardStopHandler(
        vi.fn().mockRejectedValue(new HostGoalActionError(409, 'Another goal is running now — refresh and try again')),
      );

      const res = await stop({ pauseGoalId: 'g1' });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error).toBe('Another goal is running now — refresh and try again');
    });
  });
});
