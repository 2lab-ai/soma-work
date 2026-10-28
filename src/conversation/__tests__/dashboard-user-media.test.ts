/**
 * User media (SSOT 2026-10-25) — the files a user attached to an instruction,
 * through the real web server (the harness of dashboard-artifacts.test.ts).
 *
 *   R1  the session detail API carries each user turn's attachments
 *   R2  the content route serves a kept copy (Content-Type from the kind table,
 *       nosniff, Range for audio/video seeking); sign-in required
 *   R3  a user upload never runs: html / svg / text / markdown always get the
 *       inert sandbox CSP (no allow-scripts, nothing loaded), unlike a model artifact
 *   R4  an id not on a user turn, or without a kept copy, is 404
 *   R5  the card carries the attachment count of its conversation
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
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

const records = new Map<string, any>();

vi.mock('../../config', () => ({ config: mockConfig }));
vi.mock('../../env-paths', async () => {
  const nodeFs = await import('node:fs');
  return { IS_DEV: true, DATA_DIR: nodeFs.mkdtempSync('/tmp/dash-user-media-data-') };
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
const TMP = fs.realpathSync(os.tmpdir());

afterAll(async () => {
  const { DATA_DIR } = await import('../../env-paths');
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('dashboard user media API', () => {
  let web: any;
  let dashboard: any;
  let userMedia: any;
  let store: any;
  let root: string;
  const made: string[] = [];

  beforeEach(async () => {
    vi.resetModules();
    records.clear();
    root = fs.mkdtempSync(path.join(TMP, 'dash-um-'));
    userMedia = await import('../user-media');
    store = new userMedia.UserMediaStore(path.join(root, 'store'));
    userMedia.setUserMediaStoreForTests(store);
    web = await import('../web-server');
    dashboard = await import('../dashboard');
    await web.startWebServer({ listen: false });
  });

  afterEach(async () => {
    await web.stopWebServer();
    userMedia.setUserMediaStoreForTests(null);
    for (const p of made.splice(0)) fs.rmSync(p, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** A downloaded Slack file, captured and committed under a user turn of `cid`. */
  async function attach(cid: string, name: string, body: string | Buffer, mimetype = '') {
    const p = path.join(TMP, `slack-file-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
    fs.writeFileSync(p, body);
    made.push(p);
    const [a] = await store.capture(cid, [{ path: p, name, mimetype, size: Buffer.byteLength(body as any) }]);
    await store.commit(cid, [a]);
    return a;
  }
  function conversation(cid: string, attachments: any[], text = '이 스크린샷처럼 고쳐줘') {
    records.set(cid, {
      id: cid,
      channelId: 'C1',
      threadTs: 't1',
      ownerId: 'U1',
      ownerName: 'A',
      createdAt: 1,
      updatedAt: 2,
      turns: [
        { id: 'u1', role: 'user', timestamp: 1000, userName: 'A', userId: 'U1', rawContent: text, attachments },
        {
          id: 'a1',
          role: 'assistant',
          timestamp: 2000,
          rawContent: 'ok',
          summaryTitle: 't',
          summaryBody: 'b',
          summarized: true,
        },
      ],
    });
  }
  const content = (cid: string, id: string, headers: Record<string, string> = AUTH, q = '') =>
    web.injectWebServer({ method: 'GET', url: `/api/dashboard/session/${cid}/media/${id}/content${q}`, headers });

  it('R1 — the session detail API carries the attachments of each user turn', async () => {
    const a = await attach('conv-r1', 'login.png', 'PNG');
    conversation('conv-r1', [a]);
    const res = await web.injectWebServer({ method: 'GET', url: '/api/dashboard/session/conv-r1', headers: AUTH });
    const turns = JSON.parse(res.body).turns;
    expect(turns[0].attachments).toEqual([
      expect.objectContaining({ id: a.id, name: 'login.png', kind: 'image', stored: true }),
    ]);
    expect(turns[1].attachments).toBeUndefined();
  });

  it('R2 — serves the kept copy as the kind table says, with nosniff; needs sign-in', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]);
    const a = await attach('conv-r2', 'shot.png', png, 'image/png');
    conversation('conv-r2', [a]);
    const res = await content('conv-r2', a.id);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.rawPayload).toEqual(png);
    const anon = await content('conv-r2', a.id, {});
    expect(anon.statusCode).toBe(401);
    const dl = await content('conv-r2', a.id, AUTH, '?download=1');
    expect(dl.headers['content-disposition']).toMatch(/^attachment; filename="shot.png"/);
  });

  it('R2 — a voice note supports Range so it can be played and seeked', async () => {
    const a = await attach('conv-r2b', 'memo.m4a', Buffer.from('0123456789'), 'audio/mp4');
    conversation('conv-r2b', [a]);
    const res = await content('conv-r2b', a.id, { ...AUTH, Range: 'bytes=2-5' });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 2-5/10');
    expect(res.body).toBe('2345');
  });

  it('R3 — html, svg, text and markdown uploads are served inert: no scripts, nothing loaded', async () => {
    const html = await attach('conv-r3', 'page.html', '<script>alert(1)</script>');
    const svg = await attach('conv-r3', 'x.svg', '<svg onload="alert(1)"/>');
    const md = await attach('conv-r3', 'notes.md', '# hi');
    const txt = await attach('conv-r3', 'log.txt', 'hi');
    conversation('conv-r3', [html, svg, md, txt]);
    for (const a of [html, svg, md, txt]) {
      const res = await content('conv-r3', a.id);
      expect(res.statusCode).toBe(200);
      const csp = String(res.headers['content-security-policy'] || '');
      expect(csp).toMatch(/(^|;\s*)sandbox(;|$)/);
      expect(csp).not.toContain('allow-scripts');
      expect(csp).toContain("default-src 'none'");
    }
  });

  it('R4 — an id that is not a user attachment, or has no kept copy, is 404', async () => {
    const a = await attach('conv-r4', 'a.png', 'PNG');
    const [remote] = await store.capture('conv-r4', [
      { path: '', name: 'clip.mov', mimetype: 'video/quicktime', size: 5 },
    ]);
    await store.commit('conv-r4', [remote]);
    conversation('conv-r4', [remote]); // `a` is on disk but on no turn
    expect((await content('conv-r4', a.id)).statusCode).toBe(404);
    expect((await content('conv-r4', remote.id)).statusCode).toBe(404);
    expect((await content('conv-nope', a.id)).statusCode).toBe(404);
  });

  it('R5 — the kanban card carries how many attachments its conversation keeps', async () => {
    const a = await attach('conv-r5', 'a.png', 'PNG');
    const b = await attach('conv-r5', 'b.pdf', 'PDF');
    conversation('conv-r5', [a, b]);
    const sessions = new Map<string, any>();
    sessions.set('C1:t1', {
      sessionId: 's',
      title: 'With media',
      ownerId: 'U1',
      ownerName: 'A',
      channelId: 'C1',
      threadTs: 't1',
      activityState: 'working',
      state: 'MAIN',
      conversationId: 'conv-r5',
      lastActivity: new Date('2026-10-25T00:00:00Z'),
    });
    sessions.set('C2:t2', {
      sessionId: 's2',
      title: 'Without',
      ownerId: 'U1',
      ownerName: 'A',
      channelId: 'C2',
      threadTs: 't2',
      activityState: 'working',
      state: 'MAIN',
      conversationId: 'conv-none',
      lastActivity: new Date('2026-10-25T00:00:00Z'),
    });
    dashboard.setDashboardSessionAccessor(() => sessions);
    const res = await web.injectWebServer({ method: 'GET', url: '/api/dashboard/sessions', headers: AUTH });
    const cards = JSON.parse(res.body).board.working;
    expect(cards.find((c: any) => c.conversationId === 'conv-r5').userMedia).toEqual({ count: 2 });
    expect(cards.find((c: any) => c.conversationId === 'conv-none').userMedia).toBeUndefined();
  });
});
