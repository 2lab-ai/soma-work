/**
 * Dashboard SSOT 2026-10-27 T6 — the turn data the one-line rows read travels
 * through both conversation APIs (the harness of dashboard-user-media.test.ts):
 * a user turn's `origin` and a `/compact` turn's `compact`; an assistant turn
 * carries neither.
 */

import * as fs from 'node:fs';
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

const records = new Map<string, any>();

vi.mock('../../config', () => ({ config: mockConfig }));
vi.mock('../../env-paths', async () => {
  const nodeFs = await import('node:fs');
  return { IS_DEV: true, DATA_DIR: nodeFs.mkdtempSync('/tmp/dash-system-turns-data-') };
});
vi.mock('../recorder', () => ({
  listConversations: vi.fn().mockResolvedValue([]),
  getConversation: vi.fn(async (id: string) => records.get(id) ?? null),
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

describe('T6 — user turns carry origin and compact', () => {
  let web: any;

  beforeEach(async () => {
    vi.resetModules();
    records.clear();
    web = await import('../web-server');
    await import('../dashboard');
    await web.startWebServer({ listen: false });
  });
  afterEach(async () => {
    await web.stopWebServer();
  });

  const COMPACT = {
    estimateMs: 90_000,
    endedAt: 1_134_000,
    durationMs: 134_000,
    preTokens: 182_340,
    postTokens: 31_020,
  };
  function conversation(cid: string) {
    records.set(cid, {
      id: cid,
      channelId: 'C1',
      threadTs: 't1',
      ownerId: 'U1',
      ownerName: 'A',
      createdAt: 1,
      updatedAt: 2,
      turns: [
        { id: 'u0', role: 'user', timestamp: 500, userName: 'A', userId: 'U1', rawContent: 'legacy turn' },
        {
          id: 'u1',
          role: 'user',
          timestamp: 1000,
          userName: 'A',
          userId: 'U1',
          rawContent: '/compact',
          origin: { by: 'system' },
          compact: COMPACT,
        },
        {
          id: 'a1',
          role: 'assistant',
          timestamp: 2000,
          rawContent: 'ok',
          summaryTitle: 't',
          summaryBody: 'b',
          summarized: true,
          origin: { by: 'system' },
          compact: COMPACT,
        },
      ],
    });
  }

  it.each([
    ['dashboard session detail', '/api/dashboard/session/conv-t6'],
    ['conversation detail', '/api/conversations/conv-t6'],
  ])('%s', async (_label, url) => {
    conversation('conv-t6');
    const res = await web.injectWebServer({ method: 'GET', url, headers: AUTH });
    expect(res.statusCode).toBe(200);
    const turns = JSON.parse(res.body).turns;
    expect(turns[0].origin).toBeUndefined();
    expect(turns[0].compact).toBeUndefined();
    expect(turns[1].origin).toEqual({ by: 'system' });
    expect(turns[1].compact).toEqual(COMPACT);
    expect(turns[2].origin).toBeUndefined();
    expect(turns[2].compact).toBeUndefined();
  });
});
