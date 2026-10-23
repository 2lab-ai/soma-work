import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * SSOT 2026-10-23 — dashboard server half of
 *   T3/T4  the card says it came from a cron fire (`cronJob`), live and archived;
 *   T5     GET /api/dashboard/cron — this instance's jobs (no prompt text), each
 *          with its runs newest first, linked to the session a run opened;
 *   T7/T9  GET /api/dashboard/capacity — the llmux cooldown view, cached, never 500.
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
const CRON = { id: 'job-1', name: 'nightly-qa' };
const PROMPT_MARKER = 'PROMPT-BODY-MUST-NOT-LEAK';

function liveSession(overrides: Record<string, any> = {}) {
  return {
    sessionId: 'sid1',
    ownerId: 'U1',
    ownerName: 'Z',
    channelId: 'C1',
    threadTs: 't1',
    model: 'claude-opus-5-5[1m]',
    activityState: 'idle',
    state: 'MAIN',
    lastActivity: new Date('2026-10-23T03:30:00Z'),
    ...overrides,
  };
}

describe('Dashboard — cron lane + capacity (SSOT 2026-10-23)', () => {
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
    dashboard.setDashboardCronSource?.(null);
    dashboard.setCapacitySource?.(null);
    await stopWebServer();
    vi.useRealTimers();
  });

  async function get(url: string) {
    const res = await injectWebServer({ method: 'GET', url, headers: AUTH_HEADER });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body);
  }

  describe('T3/T4 — cron origin on the card', () => {
    it('a live cron session carries cronJob; a human session does not', async () => {
      dashboard.setDashboardSessionAccessor(
        () =>
          new Map([
            ['C1:t1', liveSession({ cronJob: CRON, title: 'nightly-qa', titleProvisional: true })],
            ['C1:t2', liveSession({ sessionId: 'sid2', threadTs: 't2', title: 'Human work' })],
          ]),
      );
      const { board } = await get('/api/dashboard/sessions');
      const cards = [...board.idle, ...board.working];
      expect(cards.find((c: any) => c.threadTs === 't1').cronJob).toEqual(CRON);
      expect(cards.find((c: any) => c.threadTs === 't2').cronJob).toBeUndefined();
    });

    it('an archived cron session keeps cronJob', async () => {
      dashboard.setDashboardSessionAccessor(() => new Map());
      archives.push({
        archivedAt: Date.parse('2026-10-23T02:00:00Z'),
        archiveReason: 'terminated',
        sessionKey: 'C1-t0',
        sessionId: 's0',
        ownerId: 'U1',
        channelId: 'C1',
        threadTs: 't0',
        title: 'QA pass: orders API',
        lastActivity: '2026-10-23T01:59:00Z',
        cronJob: CRON,
      });
      const { board } = await get('/api/dashboard/sessions');
      expect(board.closed[0].cronJob).toEqual(CRON);
    });
  });

  describe('T5 — GET /api/dashboard/cron', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-23T04:20:00Z'));
    });

    function source() {
      return {
        listJobs: () => [
          {
            id: 'job-1',
            name: 'nightly-qa',
            expression: '0 * * * *',
            prompt: PROMPT_MARKER,
            owner: 'U1',
            channel: 'C1',
            threadTs: null,
            createdAt: '2026-10-01T00:00:00Z',
            lastRunAt: '2026-10-23T04:00:04Z',
            lastRunMinute: '2026-10-23T04:00',
            mode: 'fastlane',
          },
          {
            id: 'job-2',
            name: 'other-owner',
            expression: '30 9 * * *',
            prompt: 'x',
            owner: 'U2',
            channel: 'C2',
            threadTs: null,
            createdAt: '2026-10-01T00:00:00Z',
            lastRunAt: null,
            lastRunMinute: null,
          },
        ],
        // Deliberately NOT time-ordered (cron-storage groups history by job).
        listHistory: () => [
          {
            jobId: 'job-1',
            jobName: 'nightly-qa',
            executedAt: '2026-10-23T02:00:03Z',
            status: 'failed',
            executionPath: 'new_thread',
            error: 'thread creation returned no ts',
          },
          {
            jobId: 'job-1',
            jobName: 'nightly-qa',
            executedAt: '2026-10-23T04:00:04Z',
            status: 'success',
            executionPath: 'new_thread',
            sessionKey: 'C1-t9',
          },
          {
            jobId: 'job-1',
            jobName: 'nightly-qa',
            executedAt: '2026-10-23T03:00:02Z',
            status: 'success',
            executionPath: 'new_thread',
            triggeredBy: 'U3',
          },
          {
            jobId: 'job-2',
            jobName: 'other-owner',
            executedAt: '2026-10-22T09:30:00Z',
            status: 'success',
            executionPath: 'dm',
          },
        ],
      };
    }

    it('lists jobs without their prompt, runs newest first, the run linked to its live session', async () => {
      dashboard.setDashboardCronSource(source());
      dashboard.setDashboardSessionAccessor(
        () =>
          new Map([
            [
              'C1:t9',
              liveSession({
                threadTs: 't9',
                cronJob: CRON,
                activityState: 'working',
                title: 'QA pass: orders API',
                conversationId: 'conv-9',
              }),
            ],
          ]),
      );
      const { jobs } = await get('/api/dashboard/cron');
      const job = jobs.find((j: any) => j.id === 'job-1');
      expect(job).toBeDefined();
      expect(JSON.stringify(jobs)).not.toContain(PROMPT_MARKER);
      expect(job).toMatchObject({ name: 'nightly-qa', expression: '0 * * * *', owner: 'U1', mode: 'fastlane' });
      // Next fire of "0 * * * *" (UTC) after 04:20Z.
      expect(job.nextRunAt).toBe(Date.parse('2026-10-23T05:00:00Z'));
      expect(job.runs.map((r: any) => r.executedAt)).toEqual([
        Date.parse('2026-10-23T04:00:04Z'),
        Date.parse('2026-10-23T03:00:02Z'),
        Date.parse('2026-10-23T02:00:03Z'),
      ]);
      expect(job.runs[0].session).toMatchObject({
        headline: 'QA pass: orders API',
        conversationId: 'conv-9',
        activityState: 'working',
        live: true,
      });
      expect(job.runs[1].session).toBeUndefined();
      expect(job.runs[1].triggeredBy).toBe('U3');
      expect(job.runs[2]).toMatchObject({ status: 'failed', error: 'thread creation returned no ts' });
      expect(job.historyCap).toBe(20);
    });

    it('a thread archived twice links the run to its newest archive, whatever the listing order', async () => {
      const base = { archiveReason: 'terminated', sessionKey: 'C1-t9', ownerId: 'U1', channelId: 'C1', threadTs: 't9' };
      // Oldest first, as a directory listing may return them.
      archives.push(
        {
          ...base,
          archivedAt: Date.parse('2026-10-20T00:00:00Z'),
          title: 'older run',
          lastActivity: '2026-10-20T00:00:00Z',
        },
        {
          ...base,
          archivedAt: Date.parse('2026-10-23T04:10:00Z'),
          title: 'newer run',
          lastActivity: '2026-10-23T04:10:00Z',
        },
      );
      dashboard.setDashboardCronSource(source());
      dashboard.setDashboardSessionAccessor(() => new Map());
      const { jobs } = await get('/api/dashboard/cron');
      const job = jobs.find((j: any) => j.id === 'job-1');
      expect(job.runs[0].session).toMatchObject({ headline: 'newer run', live: false });
    });

    it('runs sharing one thread: only the newest owns its live state and usage', async () => {
      dashboard.setDashboardCronSource({
        listJobs: () => [
          {
            id: 'job-9',
            name: 'inject-job',
            expression: '0 * * * *',
            prompt: 'x',
            owner: 'U1',
            channel: 'C1',
            threadTs: null,
            createdAt: '2026-10-01T00:00:00Z',
            lastRunAt: null,
            lastRunMinute: null,
          },
        ],
        listHistory: () => [
          {
            jobId: 'job-9',
            jobName: 'inject-job',
            executedAt: '2026-10-23T02:00:00Z',
            status: 'success',
            executionPath: 'idle_inject',
            sessionKey: 'C1-t7',
          },
          {
            jobId: 'job-9',
            jobName: 'inject-job',
            executedAt: '2026-10-23T04:00:00Z',
            status: 'success',
            executionPath: 'idle_inject',
            sessionKey: 'C1-t7',
          },
        ],
      });
      dashboard.setDashboardSessionAccessor(
        () =>
          new Map([
            [
              'C1:t7',
              liveSession({
                threadTs: 't7',
                cronJob: { id: 'job-9', name: 'inject-job' },
                activityState: 'working',
                title: 'current work',
                usage: {
                  totalInputTokens: 10,
                  totalOutputTokens: 5,
                  totalCacheReadTokens: 0,
                  totalCacheCreateTokens: 0,
                  totalCostUsd: 2,
                },
              }),
            ],
          ]),
      );
      const { jobs } = await get('/api/dashboard/cron');
      const [newest, earlier] = jobs[0].runs;
      expect(newest.session).toMatchObject({ activityState: 'working', live: true, costUsd: 2 });
      expect(earlier.session).toMatchObject({ activityState: 'idle', live: false, earlierInThread: true });
      expect(earlier.session.costUsd).toBeUndefined();
    });

    it("a run injected into someone else's busy session does not read as this job running", async () => {
      dashboard.setDashboardCronSource({
        listJobs: () => [
          {
            id: 'job-5',
            name: 'inject-only',
            expression: '0 * * * *',
            prompt: 'x',
            owner: 'U1',
            channel: 'C1',
            threadTs: null,
            createdAt: '2026-10-01T00:00:00Z',
            lastRunAt: null,
            lastRunMinute: null,
          },
        ],
        listHistory: () => [
          {
            jobId: 'job-5',
            jobName: 'inject-only',
            executedAt: '2026-10-23T04:00:00Z',
            status: 'success',
            executionPath: 'idle_inject',
            sessionKey: 'C1-t3',
          },
        ],
      });
      dashboard.setDashboardSessionAccessor(
        () => new Map([['C1:t3', liveSession({ threadTs: 't3', activityState: 'working', title: 'human work' })]]),
      );
      const { jobs } = await get('/api/dashboard/cron');
      expect(jobs[0].runs[0].session).toMatchObject({ activityState: 'idle', live: true });
      expect(jobs[0].runs[0].session.costUsd).toBeUndefined();
    });

    it('filters by owner when a user is selected', async () => {
      dashboard.setDashboardCronSource(source());
      dashboard.setDashboardSessionAccessor(() => new Map());
      const { jobs } = await get('/api/dashboard/cron?userId=U2');
      expect(jobs.map((j: any) => j.id)).toEqual(['job-2']);
      expect(jobs[0].runs[0]).toMatchObject({ executionPath: 'dm', status: 'success' });
    });

    it('is an empty list when the scheduler is not wired', async () => {
      dashboard.setDashboardSessionAccessor(() => new Map());
      expect(await get('/api/dashboard/cron')).toEqual({ jobs: [] });
    });
  });

  describe('T7/T9 — GET /api/dashboard/capacity', () => {
    const NOW_S = Math.floor(Date.now() / 1000);
    const status = {
      current: 'ai7',
      accounts: [
        {
          name: 'ai7',
          type: 'oauth',
          group: 'claude',
          status: 'ok',
          order: 1,
          five_hour: { utilization: 0.5, resets_at: NOW_S + 3600, resets_in_secs: 3600 },
          seven_day: { utilization: 0.1, resets_at: NOW_S + 86400 * 3, resets_in_secs: 86400 * 3 },
        },
      ],
    };

    it('serves the view and caches the llmux read', async () => {
      const fetchStatus = vi.fn().mockResolvedValue(status);
      dashboard.setCapacitySource({
        enabled: () => ({ ok: true }),
        fetchStatus,
        tiers: () => ({ 'claude:ai7': 'claude-max-20x' }),
      });
      const first = await get('/api/dashboard/capacity');
      expect(first.capacity.available).toBe(true);
      expect(first.capacity.groups[0]).toMatchObject({ group: 'claude', label: 'Claude' });
      expect(first.capacity.groups[0].markers[0]).toMatchObject({ account: 'ai7', tier: 'claude-max-20x' });
      await get('/api/dashboard/capacity');
      expect(fetchStatus).toHaveBeenCalledTimes(1);
    });

    it('an llmux failure is a 200 with available:false and the reason — never a 500', async () => {
      dashboard.setCapacitySource({
        enabled: () => ({ ok: true }),
        fetchStatus: vi.fn().mockRejectedValue(new Error('llmux unreachable at http://localhost:3456')),
        tiers: () => ({}),
      });
      const { capacity } = await get('/api/dashboard/capacity');
      expect(capacity.available).toBe(false);
      expect(capacity.reason).toContain('llmux unreachable');
    });

    it('not in llmux mode → available:false with the reason', async () => {
      const fetchStatus = vi.fn();
      dashboard.setCapacitySource({
        enabled: () => ({ ok: false, reason: 'auth mode is ccp' }),
        fetchStatus,
        tiers: () => ({}),
      });
      const { capacity } = await get('/api/dashboard/capacity');
      expect(capacity).toMatchObject({ available: false, reason: 'auth mode is ccp' });
      expect(fetchStatus).not.toHaveBeenCalled();
    });
  });
});
