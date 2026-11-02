/**
 * SSOT 2026-11-02 T7 — the Executive Summary's TL;DR on the dashboard's task card.
 * Through the real web server (the harness of dashboard-artifacts.test.ts): a session that holds a
 * TL;DR (`executiveSummary`, set when the summary landed, cleared by the next input) carries it on
 * its card as `esTldr`; a session without one carries none.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
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
// A fresh data dir per run: the work-log backfill test must not see earlier runs' logs.
vi.mock('../../env-paths', async () => {
  const nodeFs = await import('node:fs');
  return { IS_DEV: true, DATA_DIR: nodeFs.mkdtempSync('/tmp/dash-artifacts-data-') };
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

describe('T7 — the card carries the Executive Summary TL;DR', () => {
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

  const base = (over: Record<string, unknown>) => ({
    title: 't',
    ownerId: 'U1',
    ownerName: 'A',
    activityState: 'idle',
    state: 'MAIN',
    lastActivity: new Date('2026-11-02T00:00:00Z'),
    ...over,
  });

  it('esTldr: the lines and when they came; none without a summary', async () => {
    const sessions = new Map<string, any>();
    sessions.set(
      'C1:t1',
      base({
        sessionId: 's1',
        channelId: 'C1',
        threadTs: 't1',
        conversationId: 'conv-1',
        executiveSummary: { tldr: ['하나', '둘', '셋'], at: 1_793_591_000_000 },
      }),
    );
    sessions.set('C2:t2', base({ sessionId: 's2', channelId: 'C2', threadTs: 't2', conversationId: 'conv-2' }));
    dashboard.setDashboardSessionAccessor(() => sessions);
    const res = await web.injectWebServer({ method: 'GET', url: '/api/dashboard/sessions', headers: AUTH });
    const board = JSON.parse(res.body).board;
    const cards = [...board.waiting, ...board.working, ...board.idle, ...board.closed];
    expect(cards.find((c: any) => c.conversationId === 'conv-1').esTldr).toEqual({
      lines: ['하나', '둘', '셋'],
      at: 1_793_591_000_000,
    });
    expect(cards.find((c: any) => c.conversationId === 'conv-2')).not.toHaveProperty('esTldr');
  });
});
