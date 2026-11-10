/**
 * SSOT 2026-10-23 — dashboard artifacts through the real web server
 * (startWebServer + injectWebServer, the harness of dashboard.test.ts).
 *
 *   T1  the card payload carries the session's artifacts; the list API returns them
 *   T8  content route serves html / png / wav so the browser can show and play them:
 *       right Content-Type, Range (206) for audio seeking, html sandboxed by CSP
 *   T7  a file whose bytes were not kept is listed but has no content (404)
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

describe('dashboard artifacts API', () => {
  let web: any;
  let dashboard: any;
  let artifacts: any;
  let root: string;
  let store: any;

  beforeEach(async () => {
    vi.resetModules();
    // Under /tmp: upload snapshots are only ever read from /tmp.
    root = fs.mkdtempSync('/tmp/dash-artifacts-');
    artifacts = await import('../artifacts');
    store = new artifacts.ArtifactStore(path.join(root, 'store'));
    artifacts.setArtifactStoreForTests(store);
    web = await import('../web-server');
    dashboard = await import('../dashboard');
    await web.startWebServer({ listen: false });
  });

  afterEach(async () => {
    await web.stopWebServer();
    artifacts.setArtifactStoreForTests(null);
    fs.rmSync(root, { recursive: true, force: true });
  });

  function file(name: string, body: string | Buffer): string {
    const p = path.join(root, name);
    fs.writeFileSync(p, body);
    return p;
  }

  it('T1 — the kanban card carries the artifact summary of its conversation', async () => {
    await store.recordSlackUpload({
      conversationId: 'conv-a',
      filePath: file('r.html', '<b>r</b>'),
      filename: 'r.html',
      slackFileId: 'F1',
    });
    const sessions = new Map<string, any>();
    sessions.set('C1:t1', {
      sessionId: 's',
      title: 'With artifacts',
      ownerId: 'U1',
      ownerName: 'A',
      channelId: 'C1',
      threadTs: 't1',
      activityState: 'working',
      state: 'MAIN',
      conversationId: 'conv-a',
      lastActivity: new Date('2026-10-23T00:00:00Z'),
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
      conversationId: 'conv-empty',
      lastActivity: new Date('2026-10-23T00:00:00Z'),
    });
    dashboard.setDashboardSessionAccessor(() => sessions);
    const res = await web.injectWebServer({ method: 'GET', url: '/api/dashboard/sessions', headers: AUTH });
    const cards = JSON.parse(res.body).board.working;
    const withArt = cards.find((c: any) => c.conversationId === 'conv-a');
    expect(withArt.artifacts).toEqual({ count: 1, recent: [expect.objectContaining({ name: 'r.html' })] });
    expect(withArt.artifacts.recent[0]).toMatchObject({ name: 'r.html', kind: 'html', stored: true });
    expect(cards.find((c: any) => c.conversationId === 'conv-empty').artifacts).toBeUndefined();
  });

  it('T7 — the list API backfills uploads made before this feature from the work log', async () => {
    const workLog = await import('../work-log');
    const p = file('old.png', 'PNG-old');
    await workLog.appendWorkLog('conv-old', {
      kind: 'tool',
      tool: 'mcp__slack-mcp__send_media',
      text: 'send_media',
      raw: JSON.stringify({ file_path: p }),
    });
    await workLog.appendWorkLog('conv-old', {
      kind: 'tool_result',
      tool: 'mcp__slack-mcp__send_media',
      ok: true,
      text: 'ok',
      raw: JSON.stringify({ uploaded: true, file_id: 'FOLD', filename: 'old.png' }),
    });
    await workLog.flushWorkLog();
    const res = await web.injectWebServer({
      method: 'GET',
      url: '/api/dashboard/session/conv-old/artifacts',
      headers: AUTH,
    });
    expect(JSON.parse(res.body).artifacts).toEqual([
      expect.objectContaining({ name: 'old.png', kind: 'image', stored: true }),
    ]);
  });

  it('T1 — list API returns every artifact of the conversation, newest first (SSOT 2026-11-02 T3); needs sign-in', async () => {
    await store.recordSlackUpload({ conversationId: 'conv-b', filename: 'a.png', slackFileId: 'A', now: 1 });
    await store.recordSlackUpload({ conversationId: 'conv-b', filename: 'b.md', slackFileId: 'B', now: 2 });
    const res = await web.injectWebServer({
      method: 'GET',
      url: '/api/dashboard/session/conv-b/artifacts',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).artifacts.map((a: any) => a.kind)).toEqual(['markdown', 'image']);
    const anon = await web.injectWebServer({ method: 'GET', url: '/api/dashboard/session/conv-b/artifacts' });
    expect(anon.statusCode).toBe(401);
  });

  it('T8 — png is served as an image', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]);
    const a = await store.recordSlackUpload({
      conversationId: 'c',
      filePath: file('p.png', png),
      filename: 'p.png',
      slackFileId: 'P',
    });
    const res = await web.injectWebServer({
      method: 'GET',
      url: `/api/dashboard/session/c/artifacts/${a.id}/content`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.rawPayload).toEqual(png);
  });

  it('T8 — wav supports Range so the audio element can play and seek', async () => {
    const wav = Buffer.from('RIFF0123456789WAVE');
    const a = await store.recordSlackUpload({
      conversationId: 'c',
      filePath: file('v.wav', wav),
      filename: 'v.wav',
      slackFileId: 'V',
    });
    const url = `/api/dashboard/session/c/artifacts/${a.id}/content`;
    const full = await web.injectWebServer({ method: 'GET', url, headers: AUTH });
    expect(full.headers['content-type']).toBe('audio/wav');
    expect(full.headers['accept-ranges']).toBe('bytes');
    const part = await web.injectWebServer({ method: 'GET', url, headers: { ...AUTH, Range: 'bytes=4-7' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 4-7/${wav.length}`);
    expect(part.body).toBe('0123');
    const bad = await web.injectWebServer({ method: 'GET', url, headers: { ...AUTH, Range: 'bytes=999-' } });
    expect(bad.statusCode).toBe(416);
  });

  it('T8 — html runs only in a sandbox: CSP sandbox without allow-same-origin', async () => {
    const a = await store.recordSlackUpload({
      conversationId: 'c',
      filePath: file('r.html', '<script>parent.document.cookie</script>'),
      filename: 'r.html',
      slackFileId: 'H',
    });
    const res = await web.injectWebServer({
      method: 'GET',
      url: `/api/dashboard/session/c/artifacts/${a.id}/content`,
      headers: AUTH,
    });
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toMatch(/^sandbox\b/);
    expect(csp).toContain('allow-scripts');
    expect(csp).not.toContain('allow-same-origin');
    // The dashboard itself offers open-in-tab and download; the page gets no popups, dialogs or downloads.
    expect(csp).not.toMatch(/allow-(popups|modals|downloads|forms|top-navigation)/);
    expect(csp).toContain("frame-src 'none'");
    const dl = await web.injectWebServer({
      method: 'GET',
      url: `/api/dashboard/session/c/artifacts/${a.id}/content?download=1`,
      headers: AUTH,
    });
    expect(String(dl.headers['content-disposition'])).toMatch(/^attachment;/);
  });

  it('T7 — a listed file without kept bytes has no content; unknown ids 404', async () => {
    const a = await store.recordSlackUpload({ conversationId: 'c', filename: 'big.mov', slackFileId: 'B', size: 9e9 });
    const gone = await web.injectWebServer({
      method: 'GET',
      url: `/api/dashboard/session/c/artifacts/${a.id}/content`,
      headers: AUTH,
    });
    expect(gone.statusCode).toBe(404);
    const unknown = await web.injectWebServer({
      method: 'GET',
      url: '/api/dashboard/session/c/artifacts/NOPE/content',
      headers: AUTH,
    });
    expect(unknown.statusCode).toBe(404);
  });

  // ── #1074 — versions: the list, an earlier version's content, the line diff ──

  async function versioned() {
    const v1 = await store.recordSlackUpload({
      conversationId: 'cv',
      filePath: file('report.html', '<h1>R</h1>\n<p>old</p>\n'),
      filename: 'report.html',
      slackFileId: 'V1',
      now: 1,
    });
    const v2 = await store.recordSlackUpload({
      conversationId: 'cv',
      filePath: file('report.html', '<h1>R</h1>\n<p>new</p>\n'),
      filename: 'report.html',
      slackFileId: 'V2',
      now: 2,
    });
    return { v1, v2 };
  }

  it('#1074 T2/T6 — the card counts an artifact once and carries its version badge only', async () => {
    await versioned();
    const sessions = new Map<string, any>();
    sessions.set('C9:t9', {
      sessionId: 's9',
      title: 'Versions',
      ownerId: 'U1',
      ownerName: 'A',
      channelId: 'C9',
      threadTs: 't9',
      activityState: 'working',
      state: 'MAIN',
      conversationId: 'cv',
      lastActivity: new Date('2026-11-09T00:00:00Z'),
    });
    dashboard.setDashboardSessionAccessor(() => sessions);
    const res = await web.injectWebServer({ method: 'GET', url: '/api/dashboard/sessions', headers: AUTH });
    const card = JSON.parse(res.body).board.working.find((c: any) => c.conversationId === 'cv');
    expect(card.artifacts.count).toBe(1);
    expect(card.artifacts.recent).toHaveLength(1);
    expect(card.artifacts.recent[0]).toMatchObject({ name: 'report.html', version: 2, changed: true });
    expect(card.artifacts.recent[0]).not.toHaveProperty('sha256');
    expect(card.artifacts.recent[0]).not.toHaveProperty('previousId');
    expect(JSON.stringify(card)).not.toContain('"versions"');
  });

  it('#1074 T4 — the versions of an artifact, newest first; an earlier version still opens; needs sign-in', async () => {
    const { v1, v2 } = await versioned();
    const res = await web.injectWebServer({
      method: 'GET',
      url: `/api/dashboard/session/cv/artifacts/${v1.id}/versions`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.key).toBe('name:report.html');
    expect(body.versions.map((a: any) => [a.id, a.version])).toEqual([
      [v2.id, 2],
      [v1.id, 1],
    ]);
    const old = await web.injectWebServer({
      method: 'GET',
      url: `/api/dashboard/session/cv/artifacts/${v1.id}/content`,
      headers: AUTH,
    });
    expect(old.body).toContain('<p>old</p>');
    const anon = await web.injectWebServer({
      method: 'GET',
      url: `/api/dashboard/session/cv/artifacts/${v1.id}/versions`,
    });
    expect(anon.statusCode).toBe(401);
    const unknown = await web.injectWebServer({
      method: 'GET',
      url: '/api/dashboard/session/cv/artifacts/NOPE/versions',
      headers: AUTH,
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('#1074 T4 — the line diff against the previous version (or a chosen one) of an HTML source', async () => {
    const { v1, v2 } = await versioned();
    const res = await web.injectWebServer({
      method: 'GET',
      url: `/api/dashboard/session/cv/artifacts/${v2.id}/diff`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const d = JSON.parse(res.body);
    expect(d).toMatchObject({
      from: { id: v1.id, version: 1 },
      to: { id: v2.id, version: 2 },
      added: 1,
      removed: 1,
      truncated: false,
    });
    expect(d.text).toBe('@@ -1,2 +1,2 @@\n <h1>R</h1>\n-<p>old</p>\n+<p>new</p>');
    const back = await web.injectWebServer({
      method: 'GET',
      url: `/api/dashboard/session/cv/artifacts/${v1.id}/diff?against=${v2.id}`,
      headers: AUTH,
    });
    expect(JSON.parse(back.body)).toMatchObject({ from: { id: v2.id }, to: { id: v1.id }, added: 1, removed: 1 });
    const anon = await web.injectWebServer({ method: 'GET', url: `/api/dashboard/session/cv/artifacts/${v2.id}/diff` });
    expect(anon.statusCode).toBe(401);
  });

  it('#1074 T4 — no diff for a first version, another artifact, a missing copy or a binary file', async () => {
    const { v1, v2 } = await versioned();
    const other = await store.recordSlackUpload({
      conversationId: 'cv',
      filePath: file('other.html', '<p>x</p>'),
      filename: 'other.html',
      slackFileId: 'O1',
    });
    const png1 = await store.recordSlackUpload({
      conversationId: 'cv',
      filePath: file('chart.png', 'P1'),
      filename: 'chart.png',
      slackFileId: 'P1',
    });
    const png2 = await store.recordSlackUpload({
      conversationId: 'cv',
      filePath: file('chart.png', 'P2'),
      filename: 'chart.png',
      slackFileId: 'P2',
    });
    const get = (id: string, q = '') =>
      web.injectWebServer({ method: 'GET', url: `/api/dashboard/session/cv/artifacts/${id}/diff${q}`, headers: AUTH });
    expect((await get(v1.id)).statusCode).toBe(404);
    expect((await get(v2.id, `?against=${other.id}`)).statusCode).toBe(404);
    expect(png1.version).toBe(1);
    expect((await get(png2.id)).statusCode).toBe(415);
    await store.recordSlackUpload({
      conversationId: 'cv',
      filename: 'report.html',
      slackFileId: 'V3',
      size: 5,
      now: 3,
    });
    const v3 = store.list('cv').find((a: any) => a.slackFileId === 'V3');
    expect(v3).toMatchObject({ version: 3, stored: false });
    expect((await get(v3.id)).statusCode).toBe(404);
  });
});
