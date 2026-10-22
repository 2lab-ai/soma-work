import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Two dashboard bugs seen on dev fleet (2026-10-22), server half.
 *
 * 1. A session waiting out an automatic resume — a turn that failed with a
 *    429 and re-runs in an hour, or a goal whose completion check failed the
 *    same way — sat in DONE: the board bucketed on `activityState` alone, and
 *    the session is `idle` while it waits. It belongs in RUNNING, and the card
 *    says when it resumes, which attempt, and the error behind it.
 * 2. The model's TodoWrite marked two or three tasks `in_progress` at once and
 *    the dashboard spun every one of them — also on a session that had stopped.
 *    The board now carries one current task, and none when nothing runs.
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
const HOUR = 60 * 60 * 1000;
const RATE_LIMIT =
  'Claude pool rate-limited (surfaced as turn content): API Error: Request rejected (429) · All 10 eligible accounts are rate-limited right now; retry in 6016s.';

function goal(overrides: Record<string, any> = {}) {
  return {
    goalId: 'g1',
    objective: '#4989 리뷰·아키텍처 지도·머지 판단',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    createdBy: 'U1',
    continuationCount: 1,
    maxContinuations: 10,
    epoch: 1,
    ...overrides,
  };
}

/** The persisted error auto-retry marker (#351) plus the card detail, for run `sid1`. */
function retry(at: number, detail: Record<string, unknown> = {}) {
  return { pendingRetryAt: at, pendingRetrySessionId: 'sid1', pendingRetryDetail: detail };
}

function session(overrides: Record<string, any> = {}) {
  return {
    sessionId: 'sid1',
    ownerId: 'U1',
    channelId: 'C1',
    threadTs: 't1',
    activityState: 'idle',
    state: 'MAIN',
    lastActivity: new Date('2026-10-22T08:54:52Z'),
    activeAccumulatedMs: 3_485_924,
    ...overrides,
  };
}

describe('Dashboard — sessions waiting out an automatic resume, and the one current task', () => {
  let startWebServer: any;
  let stopWebServer: any;
  let injectWebServer: any;
  let dashboard: any;

  beforeEach(async () => {
    vi.resetModules();
    const webServer = await import('../web-server');
    startWebServer = webServer.startWebServer;
    stopWebServer = webServer.stopWebServer;
    injectWebServer = webServer.injectWebServer;
    dashboard = await import('../dashboard');
    await startWebServer({ listen: false });
  });

  afterEach(async () => {
    dashboard.setDashboardTaskAccessor(() => undefined);
    await stopWebServer();
  });

  async function board(sessions: Map<string, any>) {
    dashboard.setDashboardSessionAccessor(() => sessions);
    const res = await injectWebServer({ method: 'GET', url: '/api/dashboard/sessions', headers: AUTH_HEADER });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body).board;
  }

  describe('bug 2 — an armed resume keeps the card in RUNNING and says when, which attempt and why', () => {
    it('a turn that failed with a 429 and re-runs later is RUNNING, not DONE', async () => {
      const at = Date.now() + HOUR;
      const b = await board(
        new Map([['C1:t1', session(retry(at, { attempt: 1, maxAttempts: 3, reason: RATE_LIMIT }))]]),
      );

      expect(b.idle).toHaveLength(0);
      expect(b.working).toHaveLength(1);
      expect(b.working[0].activityState).toBe('idle');
      expect(b.working[0].autoResume).toEqual({
        kind: 'error-retry',
        at,
        attempt: 1,
        maxAttempts: 3,
        reason: RATE_LIMIT,
      });
    });

    it('the dev incident: active goal, completion check re-runs in an hour → RUNNING with attempt n/MAX', async () => {
      const { GOAL_EVAL_DISPATCH_MAX_RETRIES } = await import('../../slack/goal-completion-evaluator');
      const at = Date.now() + HOUR;
      const b = await board(
        new Map([
          [
            'C1:t1',
            session({
              goal: goal({
                evalDispatchRetryCount: 1,
                evalBackoffUntil: at,
                evalRetryReason: 'one-shot dispatch aborted during pool rate-limit retry wait',
              }),
            }),
          ],
        ]),
      );

      expect(b.idle).toHaveLength(0);
      expect(b.working[0].autoResume).toEqual({
        kind: 'goal-eval-retry',
        at,
        attempt: 1,
        maxAttempts: GOAL_EVAL_DISPATCH_MAX_RETRIES,
        reason: 'one-shot dispatch aborted during pool rate-limit retry wait',
      });
    });

    it('a goal whose completion check is running right now is RUNNING', async () => {
      const b = await board(
        new Map([['C1:t1', session({ goal: goal({ pendingEval: { requestedAt: 5, turnId: '5' } }) })]]),
      );
      expect(b.working[0].autoResume).toEqual({ kind: 'goal-eval' });
    });

    it('the turn retry wins over a goal re-check (the sooner action)', async () => {
      const at = Date.now() + HOUR;
      const b = await board(
        new Map([
          [
            'C1:t1',
            session({
              ...retry(at, { attempt: 2, maxAttempts: 3, reason: RATE_LIMIT }),
              goal: goal({ evalBackoffUntil: Date.now() + 2 * HOUR, evalDispatchRetryCount: 1 }),
            }),
          ],
        ]),
      );
      expect(b.working[0].autoResume.kind).toBe('error-retry');
      expect(b.working[0].autoResume.attempt).toBe(2);
    });

    it('nothing armed, or the window already passed, or the goal is not active → DONE as before', async () => {
      const past = Date.now() - 1000;
      const b = await board(
        new Map<string, any>([
          ['C1:a', session({ threadTs: 'a' })],
          ['C1:b', session({ threadTs: 'b', ...retry(past, { attempt: 1, maxAttempts: 3 }) })],
          ['C1:c', session({ threadTs: 'c', goal: goal({ evalBackoffUntil: past }) })],
          ['C1:d', session({ threadTs: 'd', goal: goal({ status: 'paused', evalBackoffUntil: Date.now() + HOUR }) })],
          ['C1:e', session({ threadTs: 'e', goal: goal() })],
        ]),
      );
      expect(b.working).toHaveLength(0);
      expect(b.idle).toHaveLength(5);
      for (const card of b.idle) expect(card.autoResume).toBeUndefined();
    });

    it('a marker of a previous run or of a sleeping session is not a resume (same rule as the restart re-arm, #351)', async () => {
      const at = Date.now() + HOUR;
      const b = await board(
        new Map<string, any>([
          ['C1:a', session({ threadTs: 'a', ...retry(at), pendingRetrySessionId: 'old-run' })],
          ['C1:b', session({ threadTs: 'b', ...retry(at), state: 'SLEEPING' })],
        ]),
      );
      expect(b.working).toHaveLength(0);
      for (const card of [...b.idle, ...b.closed]) expect(card.autoResume).toBeUndefined();
    });

    it('a question to the user still wins: waiting stays in NEEDS YOU', async () => {
      const b = await board(
        new Map([['C1:t1', session({ activityState: 'waiting', ...retry(Date.now() + HOUR, { attempt: 1 }) })]]),
      );
      expect(b.waiting).toHaveLength(1);
      expect(b.working).toHaveLength(0);
    });

    it('deriveAutoResume never reports garbage counts or a blank reason', () => {
      const now = 1_000;
      expect(
        dashboard.deriveAutoResume(
          {
            sessionId: 's',
            pendingRetryAt: 2_000,
            pendingRetrySessionId: 's',
            pendingRetryDetail: { attempt: 'x', maxAttempts: -1, reason: '' },
          },
          now,
        ),
      ).toEqual({ kind: 'error-retry', at: 2_000, attempt: undefined, maxAttempts: undefined, reason: undefined });
      expect(
        dashboard.deriveAutoResume({ sessionId: 's', pendingRetryAt: 'soon', pendingRetrySessionId: 's' }, now),
      ).toBeUndefined();
      expect(dashboard.deriveAutoResume(undefined, now)).toBeUndefined();
    });
  });

  describe('bug 1 — at most one task in progress, and none when the session is not running', () => {
    const snapshot = () => [
      { content: 'T1 리뷰', status: 'completed', startedAt: 1, completedAt: 2 },
      { content: 'T1.5 변이 실행', status: 'in_progress', startedAt: 3 },
      { content: 'T2.1 지도 마무리', status: 'in_progress', startedAt: 4 },
      { content: 'T3.1 최종 게이트', status: 'pending' },
    ];

    it('a running session: the first in_progress task is current, a later one reads as pending', async () => {
      const stored = snapshot();
      dashboard.setDashboardTaskAccessor(() => ({ current: stored, earlier: [] }));
      const b = await board(new Map([['C1:t1', session({ activityState: 'working' })]]));

      expect(b.working[0].tasks.map((t: any) => t.status)).toEqual(['completed', 'in_progress', 'pending', 'pending']);
      expect(b.working[0].tasks[1].content).toBe('T1.5 변이 실행');
      // Display-only: the stored snapshot keeps what the model wrote.
      expect(stored.map((t) => t.status)).toEqual(['completed', 'in_progress', 'in_progress', 'pending']);
    });

    it('an idle session in DONE has no current task (Slack plan block finalize rule)', async () => {
      dashboard.setDashboardTaskAccessor(() => ({ current: snapshot(), earlier: [] }));
      const b = await board(new Map<string, any>([['C1:idle', session({ threadTs: 'idle' })]]));
      const card = b.idle[0];
      expect(card.tasks.filter((t: any) => t.status === 'in_progress')).toHaveLength(0);
      expect(card.tasks[0].status).toBe('completed');
    });

    it('a question to the user or an armed resume keeps exactly one current task (what it was / will be doing)', async () => {
      dashboard.setDashboardTaskAccessor(() => ({ current: snapshot(), earlier: [] }));
      const b = await board(
        new Map<string, any>([
          ['C1:resume', session({ threadTs: 'resume', ...retry(Date.now() + HOUR, { attempt: 1 }) })],
          ['C1:ask', session({ threadTs: 'ask', activityState: 'waiting' })],
        ]),
      );
      for (const card of [...b.working, ...b.waiting]) {
        expect(card.tasks.map((t: any) => t.status)).toEqual(['completed', 'in_progress', 'pending', 'pending']);
      }
    });

    it('normalizeTaskProgress keeps a single in_progress untouched and passes undefined through', () => {
      const one = [
        { content: 'a', status: 'pending' },
        { content: 'b', status: 'in_progress' },
      ];
      expect(dashboard.normalizeTaskProgress(one, true)).toEqual(one);
      expect(dashboard.normalizeTaskProgress(undefined, true)).toBeUndefined();
    });

    it('the live task_update push carries the same one-current-task view', async () => {
      const webServer = await import('../web-server');
      dashboard.setDashboardSessionAccessor(() => new Map([['C1:t1', session({ activityState: 'working' })]]));
      const messages: any[] = [];
      // The WS upgrade authenticates by cookie (the browser path); the viewer
      // token travels as a bearer cookie.
      const headers = { cookie: `soma_dash_token=${encodeURIComponent('bearer:test-token')}` };
      const ws = await webServer.injectWebServerWS('/ws/dashboard', { headers }, (socket: any) => {
        socket.on('message', (data: any) => messages.push(JSON.parse(data.toString())));
      });
      try {
        dashboard.broadcastTaskUpdate('C1:t1', snapshot());
        await vi.waitFor(() => expect(messages.some((m) => m.type === 'task_update')).toBe(true));
      } finally {
        ws.terminate();
      }
      const msg = messages.find((m) => m.type === 'task_update');
      expect(msg.tasks.map((t: any) => t.status)).toEqual(['completed', 'in_progress', 'pending', 'pending']);
    });
  });
});
