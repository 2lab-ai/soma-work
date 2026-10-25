import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * SSOT 2026-10-22 — dashboard live surfaces, server half: what the card
 * payload (`KanbanSession`) carries for
 *   T1/T2  total tokens (every kind) and API-equivalent cost, including the
 *          calls of the turn that is still running;
 *   T6     the completed goals, with their details;
 *   T7/T8  the task ledger (ids, elapsed time, tool calls, earlier tasks);
 *   T11    the moment the work finished (`doneAt`), for the DONE date groups;
 * and the throttle that pushes a running card at most once a second.
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

const archives: any[] = [];
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
  getArchiveStore: () => ({ listRecent: () => archives }),
}));

const AUTH_HEADER = { Authorization: 'Bearer test-token' };

function liveSession(overrides: Record<string, any> = {}) {
  return {
    sessionId: 'sid1',
    ownerId: 'U1',
    channelId: 'C1',
    threadTs: 't1',
    model: 'claude-opus-5-5[1m]',
    activityState: 'working',
    state: 'MAIN',
    lastActivity: new Date('2026-10-21T00:00:00Z'),
    ...overrides,
  };
}

function usage(overrides: Record<string, number> = {}) {
  return {
    currentInputTokens: 0,
    currentOutputTokens: 0,
    currentCacheReadTokens: 0,
    currentCacheCreateTokens: 0,
    contextWindow: 1_000_000,
    totalInputTokens: 1000,
    totalOutputTokens: 200,
    totalCacheReadTokens: 5000,
    totalCacheCreateTokens: 300,
    totalCostUsd: 1.5,
    lastUpdated: 1,
    ...overrides,
  };
}

describe('Dashboard — live surfaces (SSOT 2026-10-22)', () => {
  let startWebServer: any;
  let stopWebServer: any;
  let injectWebServer: any;
  let dashboard: any;

  beforeEach(async () => {
    vi.resetModules();
    archives.length = 0;
    const webServer = await import('../web-server');
    startWebServer = webServer.startWebServer;
    stopWebServer = webServer.stopWebServer;
    injectWebServer = webServer.injectWebServer;
    dashboard = await import('../dashboard');
    await startWebServer({ listen: false });
  });

  afterEach(async () => {
    await stopWebServer();
    vi.useRealTimers();
  });

  async function board(sessions: Map<string, any>) {
    dashboard.setDashboardSessionAccessor(() => sessions);
    const res = await injectWebServer({ method: 'GET', url: '/api/dashboard/sessions', headers: AUTH_HEADER });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body).board;
  }

  describe('T1/T2 — tokens of every kind and cost, live', () => {
    it('carries cache read / write totals next to input / output', async () => {
      const card = (await board(new Map([['C1:t1', liveSession({ usage: usage() })]]))).working[0];
      expect(card.tokenUsage).toMatchObject({
        totalInputTokens: 1000,
        totalOutputTokens: 200,
        totalCacheReadTokens: 5000,
        totalCacheCreateTokens: 300,
        totalCostUsd: 1.5,
      });
    });

    it('folds the running turn’s calls into the totals, priced at the session model', async () => {
      const liveUsage = {
        'm:a': { inputTokens: 100, outputTokens: 1000, cacheReadTokens: 10_000, cacheCreateTokens: 0 },
        'm:b': { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 2000 },
      };
      const card = (await board(new Map([['C1:t1', liveSession({ usage: usage(), liveUsage })]]))).working[0];
      expect(card.tokenUsage).toMatchObject({
        totalInputTokens: 1100,
        totalOutputTokens: 1200,
        totalCacheReadTokens: 15_000,
        totalCacheCreateTokens: 2300,
      });
      expect(card.tokenUsage.totalCostUsd).toBeGreaterThan(1.5);
    });

    it('a first turn still running (no committed usage yet) already shows its calls', async () => {
      const liveUsage = { 'm:a': { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreateTokens: 0 } };
      const card = (await board(new Map([['C1:t1', liveSession({ liveUsage })]]))).working[0];
      expect(card.tokenUsage).toMatchObject({ totalInputTokens: 10, totalOutputTokens: 20 });
      expect(card.tokenUsage.totalCostUsd).toBeGreaterThan(0);
    });

    it('pushes a running card at most once a second, the last value always arriving', () => {
      vi.useFakeTimers();
      const sent: string[] = [];
      const push = dashboard.createLiveUpdateThrottle((key: string) => sent.push(key), 1000);
      push('a');
      push('a');
      push('a');
      push('b');
      expect(sent).toEqual(['a', 'b']);
      vi.advanceTimersByTime(999);
      expect(sent).toEqual(['a', 'b']);
      vi.advanceTimersByTime(1);
      expect(sent).toEqual(['a', 'b', 'a']);
      vi.advanceTimersByTime(5000);
      expect(sent).toEqual(['a', 'b', 'a']);
    });
  });

  describe('T7/T8 — tasks come from the task ledger', () => {
    it('carries ids, times, tool calls and the earlier tasks', async () => {
      dashboard.setDashboardTaskAccessor(() => ({
        current: [{ id: 'T2', content: 'B', status: 'in_progress', startedAt: 5, toolCalls: 4 }],
        earlier: [{ id: 'T1', content: 'A', status: 'completed', startedAt: 1, completedAt: 3, toolCalls: 9 }],
      }));
      const card = (await board(new Map([['C1:t1', liveSession()]]))).working[0];
      expect(card.tasks).toEqual([{ id: 'T2', content: 'B', status: 'in_progress', startedAt: 5, toolCalls: 4 }]);
      expect(card.earlierTasks).toEqual([
        { id: 'T1', content: 'A', status: 'completed', startedAt: 1, completedAt: 3, toolCalls: 9 },
      ]);
    });

    it('an archived card keeps the tasks of its ledger', async () => {
      archives.push({
        archivedAt: Date.parse('2026-10-20T10:00:00Z'),
        archiveReason: 'terminated',
        sessionKey: 'C9:t9',
        sessionId: 's9',
        ownerId: 'U1',
        channelId: 'C9',
        threadTs: 't9',
        lastActivity: '2026-10-20T09:00:00.000Z',
        taskLedger: {
          nextSeq: 3,
          current: ['T2'],
          tasks: [
            { id: 'T1', content: 'A', status: 'completed', startedAt: 1, completedAt: 2, toolCalls: 1 },
            { id: 'T2', content: 'B', status: 'completed', startedAt: 2, completedAt: 4, toolCalls: 5 },
          ],
        },
      });
      const card = (await board(new Map())).closed[0];
      expect(card.tasks.map((t: any) => t.id)).toEqual(['T2']);
      expect(card.earlierTasks.map((t: any) => t.id)).toEqual(['T1']);
    });
  });

  describe('T6 — completed goals with their details', () => {
    const done = (id: string, completedAt: number, extra: Record<string, any> = {}) => ({
      goalId: id,
      objective: `goal ${id}`,
      status: 'complete',
      createdAt: completedAt - 60_000,
      updatedAt: completedAt,
      createdBy: 'U1',
      completedAt,
      completedVia: 'eval-model',
      completionReason: 'all requirements have evidence',
      activeMsUsed: 120_000,
      tokensInput: 10,
      tokensOutput: 20,
      tokensCacheRead: 30,
      tokensCacheCreate: 40,
      costUsd: 0.25,
      continuationCount: 3,
      maxContinuations: 10,
      ...extra,
    });

    it('lists completed goals newest first, with time, tokens, cost, how and why they closed', async () => {
      const card = (
        await board(
          new Map([
            ['C1:t1', liveSession({ goalHistory: [done('g1', 1000), done('g2', 2000, { completedVia: 'user' })] })],
          ]),
        )
      ).working[0];
      expect(card.goal.completedCount).toBe(2);
      expect(card.goal.history).toEqual([
        {
          goalId: 'g2',
          objective: 'goal g2',
          createdAt: 2000 - 60_000,
          completedAt: 2000,
          completedVia: 'user',
          completionReason: 'all requirements have evidence',
          activeMsUsed: 120_000,
          tokens: 100,
          costUsd: 0.25,
          continuationCount: 3,
        },
        expect.objectContaining({ goalId: 'g1', completedVia: 'eval-model' }),
      ]);
    });

    it('a finished goal that stays current (queue empty) still opens with its details (review: T6)', async () => {
      const g = done('g1', 1000);
      const card = (await board(new Map([['C1:t1', liveSession({ goal: g, goalHistory: [done('g0', 500), g] })]])))
        .working[0];
      // The current block shows only its objective and state; the details live in the list.
      expect(card.goal.completedCount).toBe(2);
      expect(card.goal.history.map((h: any) => h.goalId)).toEqual(['g1', 'g0']);
      expect(card.goal.history[0]).toMatchObject({ completedAt: 1000, costUsd: 0.25 });
    });

    it('caps a long completion reason', async () => {
      const card = (
        await board(
          new Map([['C1:t1', liveSession({ goalHistory: [done('g1', 1, { completionReason: 'x'.repeat(5000) })] })]]),
        )
      ).working[0];
      expect(card.goal.history[0].completionReason.length).toBeLessThanOrEqual(1000);
    });

    it('an archived card keeps its goals', async () => {
      archives.push({
        archivedAt: 5,
        archiveReason: 'terminated',
        sessionKey: 'C9:t9',
        sessionId: 's9',
        ownerId: 'U1',
        channelId: 'C9',
        threadTs: 't9',
        lastActivity: '2026-10-20T09:00:00.000Z',
        goalHistory: [done('g7', 7)],
      });
      const card = (await board(new Map())).closed[0];
      expect(card.goal.history.map((h: any) => h.goalId)).toEqual(['g7']);
    });
  });

  describe('T11 — when the work finished (doneAt)', () => {
    it('an idle card finished when it last went idle; without that, at its last activity', async () => {
      const b = await board(
        new Map([
          ['C1:t1', liveSession({ activityState: 'idle', activityStateChangedAt: 1_700_000_000_000 })],
          ['C2:t2', liveSession({ channelId: 'C2', threadTs: 't2', activityState: 'idle' })],
        ]),
      );
      const byKey = Object.fromEntries(b.idle.map((c: any) => [c.key, c.doneAt]));
      expect(byKey).toEqual({ 'C1:t1': 1_700_000_000_000, 'C2:t2': Date.parse('2026-10-21T00:00:00Z') });
    });

    it('a running card has no finish time; an archived card finished at its last activity', async () => {
      archives.push({
        archivedAt: Date.parse('2026-10-22T00:00:00Z'),
        archiveReason: 'sleep_expired',
        sessionKey: 'C9:t9',
        sessionId: 's9',
        ownerId: 'U1',
        channelId: 'C9',
        threadTs: 't9',
        lastActivity: '2026-10-19T08:00:00.000Z',
      });
      const b = await board(new Map([['C1:t1', liveSession()]]));
      expect(b.working[0].doneAt).toBeUndefined();
      expect(b.closed[0].doneAt).toBe(Date.parse('2026-10-19T08:00:00.000Z'));
    });
  });

  describe('spec 13 §3.7 — when a waiting card started waiting (waitingSince)', () => {
    it('a session waiting on its user: the moment it switched to waiting; working and idle cards have none', async () => {
      const b = await board(
        new Map([
          ['C1:t1', liveSession({ activityState: 'waiting', activityStateChangedAt: 1_700_000_100_000 })],
          ['C2:t2', liveSession({ channelId: 'C2', threadTs: 't2', activityStateChangedAt: 1_700_000_000_000 })],
          [
            'C3:t3',
            liveSession({
              channelId: 'C3',
              threadTs: 't3',
              activityState: 'idle',
              activityStateChangedAt: 1_700_000_200_000,
            }),
          ],
        ]),
      );
      expect(b.waiting[0].waitingSince).toBe(1_700_000_100_000);
      expect(b.working[0].waitingSince).toBeUndefined();
      expect(b.idle[0].waitingSince).toBeUndefined();
    });

    it('a turn blocked on permission prompts waits since the oldest prompt, not since the turn started', () => {
      const working = { activityState: 'working', activityStateChangedAt: 5 };
      expect(dashboard.liveWaitingSince(working, [{ createdAt: 30 }, { createdAt: 20 }])).toBe(20);
      expect(dashboard.liveWaitingSince(working, [{ createdAt: Number.NaN }])).toBeUndefined();
      expect(dashboard.liveWaitingSince({ activityState: 'waiting' }, [])).toBeUndefined();
      expect(dashboard.liveWaitingSince(working, [])).toBeUndefined();
    });
  });

  describe('T4/T5 — model switch route and card fields', () => {
    async function post(payload: any, key = 'C1:t1') {
      return injectWebServer({
        method: 'POST',
        url: `/api/dashboard/session/${encodeURIComponent(key)}/model`,
        headers: AUTH_HEADER,
        payload,
      });
    }

    beforeEach(() => {
      dashboard.setDashboardSessionAccessor(() => new Map([['C1:t1', liveSession()]]));
    });

    it('switches through the host handler and answers with its result', async () => {
      const result = {
        status: 'compacting',
        nickname: 'grok[1m]',
        model: 'grok-4.6',
        autoCompactTokens: 450_000,
        usedTokens: 600_000,
      };
      const handler = vi.fn().mockResolvedValue(result);
      dashboard.setDashboardModelHandler(handler);
      const res = await post({ model: 'grok[1m]' });
      expect(res.statusCode).toBe(200);
      expect(handler).toHaveBeenCalledWith('C1:t1', 'grok[1m]');
      expect(JSON.parse(res.body)).toEqual({ ok: true, result });
    });

    it.each([[{}], [{ model: 5 }], [{ model: '' }], [{ model: 'x'.repeat(65) }]])('400 for %j', async (body) => {
      dashboard.setDashboardModelHandler(vi.fn());
      expect((await post(body)).statusCode).toBe(400);
    });

    it('answers a refusal with its status and message', async () => {
      const { ModelSwitchError } = await import('../../session/model-switch');
      dashboard.setDashboardModelHandler(vi.fn().mockRejectedValue(new ModelSwitchError(409, '먼저 compact')));
      const res = await post({ model: 'grok[1m]' });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body)).toEqual({ error: '먼저 compact' });
    });

    it('the card carries context tokens, the model’s auto-compact threshold and a waiting switch', async () => {
      const card = (
        await board(
          new Map([
            [
              'C1:t1',
              liveSession({
                model: 'grok-4.6',
                usage: usage({ currentInputTokens: 300_000, currentCacheReadTokens: 20_000 }),
                pendingModelSwitch: { model: 'claude-opus-5-5[1m]', nickname: 'opus[1m]', requestedAt: Date.now() },
              }),
            ],
          ]),
        )
      ).working[0];
      expect(card).toMatchObject({ contextTokens: 320_000, autoCompactTokens: 450_000, pendingModel: 'opus[1m]' });
    });

    it('a waiting switch past its TTL no longer locks the picker (its queued compact never came, review R3-2)', async () => {
      const card = (
        await board(
          new Map([
            [
              'C1:t1',
              liveSession({
                model: 'grok-4.6',
                usage: usage({ currentInputTokens: 300_000 }),
                pendingModelSwitch: {
                  model: 'claude-opus-5-5[1m]',
                  nickname: 'opus[1m]',
                  requestedAt: Date.now() - 31 * 60 * 1000,
                },
              }),
            ],
          ]),
        )
      ).working[0];
      expect(card.pendingModel).toBeUndefined();
    });

    it('the page lists the six representative models with their auto-compact thresholds', async () => {
      const res = await injectWebServer({ method: 'GET', url: '/dashboard', headers: AUTH_HEADER });
      const m = /const REPRESENTATIVE_MODELS = (\[.*?\]);\n/.exec(res.body);
      expect(m).not.toBeNull();
      const list = JSON.parse(m![1]);
      expect(list.map((x: any) => x.nickname)).toEqual([
        'opus[1m]',
        'fable[1m]',
        'sonnet[1m]',
        'sol[1m]',
        'astra[1m]',
        'grok[1m]',
      ]);
      expect(list.find((x: any) => x.nickname === 'grok[1m]')).toMatchObject({
        model: 'grok-4.6',
        contextWindow: 500_000,
        autoCompactTokens: 450_000,
      });
      expect(list.find((x: any) => x.nickname === 'sonnet[1m]')).toMatchObject({ model: 'claude-sonnet-4-6[1m]' });
    });
  });
});
