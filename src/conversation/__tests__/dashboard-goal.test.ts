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
      expect(card.goal.current.stalled).toEqual({ at: 77, reason: 'dev에 에픽이 없다' });
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
        },
        queue: [
          { goalId: 'g2', objective: '두번째' },
          { goalId: 'g3', objective: '세번째' },
        ],
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

    it.each([
      [{}, /action/],
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
});
