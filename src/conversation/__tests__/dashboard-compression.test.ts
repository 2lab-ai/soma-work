/**
 * Dashboard first load is ~1.5 MB uncompressed (837 KB page + 677 KB board JSON
 * measured on a live instance, 2026-10-27), and the public proxy in front of the
 * viewer does not compress. The two first-load responses are compressed here,
 * opt-in per route: the global hook stays off so byte-range routes (artifacts,
 * user media) keep their Content-Range semantics untouched (#477).
 */

import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const AUTH = { Authorization: 'Bearer test-token' };

function sessions(n: number): Map<string, unknown> {
  const m = new Map<string, unknown>();
  for (let i = 0; i < n; i++) {
    m.set(`C${i}:t${i}`, {
      sessionId: `sid${i}`,
      title: `Session ${i} — dashboard loading work`,
      ownerId: `U${i % 3}`,
      ownerName: ['Alice', 'Bob', 'Zhuge'][i % 3],
      channelId: `C${i}`,
      threadTs: `t${i}`,
      activityState: i % 2 ? 'working' : 'idle',
      state: 'MAIN',
      lastActivity: new Date('2026-10-27T10:00:00Z'),
    });
  }
  return m;
}

describe('dashboard first-load compression (#477)', () => {
  let injectWebServer: (r: Record<string, unknown>) => Promise<{
    statusCode: number;
    headers: Record<string, string | string[] | undefined>;
    rawPayload: Buffer;
    body: string;
  }>;
  let stopWebServer: () => Promise<void>;

  beforeEach(async () => {
    vi.resetModules();
    const webServer = await import('../web-server');
    injectWebServer = webServer.injectWebServer as typeof injectWebServer;
    stopWebServer = webServer.stopWebServer;
    const dashboard = await import('../dashboard');
    dashboard.setDashboardSessionAccessor(() => sessions(40));
    await webServer.startWebServer({ listen: false });
  });

  afterEach(async () => {
    await stopWebServer();
  });

  it('GET /dashboard: brotli when the browser accepts it, much smaller, same page', async () => {
    const plain = await injectWebServer({ method: 'GET', url: '/dashboard', headers: { ...AUTH } });
    const res = await injectWebServer({
      method: 'GET',
      url: '/dashboard',
      headers: { ...AUTH, 'accept-encoding': 'gzip, deflate, br, zstd' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBe('br');
    expect(String(res.headers.vary).toLowerCase()).toContain('accept-encoding');
    const page = brotliDecompressSync(res.rawPayload).toString('utf8');
    expect(page).toBe(plain.body);
    expect(page.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(res.rawPayload.length).toBeLessThan(plain.rawPayload.length / 3);
  });

  it('GET /dashboard: gzip for a gzip-only client; identity when none is accepted', async () => {
    const gz = await injectWebServer({
      method: 'GET',
      url: '/dashboard',
      headers: { ...AUTH, 'accept-encoding': 'gzip' },
    });
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(gz.rawPayload).toString('utf8').startsWith('<!DOCTYPE html>')).toBe(true);

    const none = await injectWebServer({ method: 'GET', url: '/dashboard', headers: { ...AUTH } });
    expect(none.headers['content-encoding']).toBeUndefined();
    expect(none.body.startsWith('<!DOCTYPE html>')).toBe(true);
  });

  it('GET /dashboard/:userId is compressed too', async () => {
    const res = await injectWebServer({
      method: 'GET',
      url: '/dashboard/U1',
      headers: { ...AUTH, 'accept-encoding': 'br' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBe('br');
  });

  it('GET /api/dashboard/sessions (polled every 30 s per tab): brotli, same JSON', async () => {
    const plain = await injectWebServer({ method: 'GET', url: '/api/dashboard/sessions', headers: { ...AUTH } });
    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/sessions',
      headers: { ...AUTH, 'accept-encoding': 'br, gzip' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBe('br');
    const json = JSON.parse(brotliDecompressSync(res.rawPayload).toString('utf8'));
    expect(json).toEqual(JSON.parse(plain.body));
    expect(json.board).toBeDefined();
  });

  it('opt-in only: other routes are untouched (byte-range routes keep their semantics)', async () => {
    const res = await injectWebServer({
      method: 'GET',
      url: '/api/conversations',
      headers: { ...AUTH, 'accept-encoding': 'br, gzip' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
  });
});
