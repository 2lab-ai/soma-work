/**
 * 사용자 할 일 (instruct_user) on the board: GET /api/dashboard/sessions carries a session's user actions — what, where,
 * the script and the host's check — on its card, so the detail card draws them in their own section. The Slack ts
 * stays server-side; a session without any gets no field.
 */
import * as fs from 'node:fs';
import { inspectUserActionScript } from 'somalib/user-action/user-action';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('../../env-paths', async () => {
  const nodeFs = await import('node:fs');
  return { IS_DEV: true, DATA_DIR: nodeFs.mkdtempSync('/tmp/dash-user-actions-data-') };
});
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
  getArchiveStore: () => ({ listRecent: vi.fn().mockReturnValue([]) }),
}));

const AUTH = { Authorization: 'Bearer test-token' };

afterAll(async () => {
  const { DATA_DIR } = await import('../../env-paths');
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('dashboard — user actions on the board', () => {
  let web: any;
  let dashboard: any;

  beforeEach(async () => {
    vi.resetModules();
    web = await import('../web-server');
    dashboard = await import('../dashboard');
    await web.startWebServer({ listen: false });
  });

  afterEach(async () => {
    await web.stopWebServer();
  });

  it('a session with a user action carries it (without the Slack ts); one without carries nothing', async () => {
    const script = "open 'https://example.com/verify'";
    const action = {
      id: 'ua_1',
      title: '인증 페이지 열기',
      host: 'owner-mac',
      why: '소유자 본인만 할 수 있다.',
      script,
      shell: 'bash',
      expect: '페이지가 열린다',
      effects: '페이지를 연다.',
      optional: false,
      createdAt: 1,
      status: 'pending',
      slackTs: '111.222',
      inspection: inspectUserActionScript(script, 'bash', { checked: true, ok: true, tool: 'bash -n' }),
    };
    const base = {
      ownerId: 'U1',
      ownerName: 'A',
      activityState: 'working',
      state: 'MAIN',
      lastActivity: new Date('2026-11-14T00:00:00Z'),
    };
    const sessions = new Map<string, any>([
      ['C1:t1', { ...base, sessionId: 's1', title: 'With', channelId: 'C1', threadTs: 't1', userActions: [action] }],
      ['C2:t2', { ...base, sessionId: 's2', title: 'Without', channelId: 'C2', threadTs: 't2' }],
    ]);
    dashboard.setDashboardSessionAccessor(() => sessions);
    const res = await web.injectWebServer({ method: 'GET', url: '/api/dashboard/sessions', headers: AUTH });
    const cards = JSON.parse(res.body).board.working;
    const withIt = cards.find((c: any) => c.title === 'With');
    expect(withIt.userActions).toHaveLength(1);
    expect(withIt.userActions[0]).toMatchObject({ id: 'ua_1', host: 'owner-mac', script, status: 'pending' });
    expect(withIt.userActions[0].inspection.syntax).toEqual({ checked: true, ok: true, tool: 'bash -n' });
    expect(withIt.userActions[0]).not.toHaveProperty('slackTs');
    expect(cards.find((c: any) => c.title === 'Without').userActions).toBeUndefined();
  });
});
