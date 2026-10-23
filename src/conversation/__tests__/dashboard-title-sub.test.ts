/**
 * Dashboard panel subtitle (titleSub) — "Title generation failed" on a session
 * the viewer does not own, and 🔄 never generating (Slack report 2026-10-23).
 *
 * Cause: the panel auto-POSTs /generate-title for every viewer when the
 * subtitle is missing, but that route sits behind the #716 write gate, so a
 * non-owner (or an admin with Admin mode off) always got 403 — which the
 * client rendered as "Title generation failed", and 🔄 repeated the same 403.
 *
 * Contract pinned here:
 *   T1 — any signed-in viewer fills a MISSING subtitle (POST ensure-title);
 *        auth + CSRF still apply; one LLM call per conversation at a time;
 *        a fill never overwrites a subtitle written meanwhile; a failed fill
 *        pauses further fills for the cooldown; no text → no LLM call.
 *   T2 — 🔄 works: on a missing subtitle it retries the fill for anyone; on an
 *        existing one it regenerates for the owner / Admin-mode admin only
 *        (POST generate-title keeps the #716 gate), and the button is hidden
 *        for everyone else. A permission 403 is never shown as a failure.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationRecord } from '../types';

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
    jwtSecret: 'test-jwt-secret',
    jwtExpiresIn: 604800,
  },
};

const paths = vi.hoisted(() => ({ dataDir: '' }));
const llm = vi.hoisted(() => ({ generateTitle: vi.fn() }));

vi.mock('../../config', () => ({ config: mockConfig }));
vi.mock('../../env-paths', () => ({
  IS_DEV: true,
  get DATA_DIR() {
    return paths.dataDir;
  },
}));
vi.mock('../../admin-utils', () => ({ isAdminUser: (id: string) => id === 'U_ADMIN' }));
vi.mock('../title-generator', () => ({ generateTitle: llm.generateTitle }));
vi.mock('../viewer', () => ({
  renderConversationListPage: vi.fn().mockReturnValue('<html></html>'),
  renderConversationViewPage: vi.fn().mockReturnValue('<html></html>'),
}));
vi.mock('../../session-archive', () => ({
  getArchiveStore: () => ({ listRecent: vi.fn().mockReturnValue([]) }),
}));

const CONV_ID = 'conv-title-1';

function conversation(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    id: CONV_ID,
    channelId: 'C1',
    threadTs: '1.1',
    ownerId: 'U_OWNER',
    ownerName: 'george cho',
    title: '$autoz <https://github.com/acme/board/issues/1234>',
    workflow: 'default',
    createdAt: 1,
    updatedAt: 2,
    turns: [
      {
        id: 't1',
        role: 'user' as const,
        timestamp: 1,
        userId: 'U_OWNER',
        userName: 'george cho',
        rawContent: '$autoz <https://github.com/acme/board/issues/1234>',
      },
    ],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('dashboard subtitle routes (ensure-title / generate-title)', () => {
  let web: typeof import('../web-server');
  let recorder: typeof import('../recorder');

  async function seed(overrides: Partial<ConversationRecord> = {}) {
    const { ConversationStorage } = await import('../storage');
    await new ConversationStorage().save(conversation(overrides));
  }

  async function stored() {
    const { ConversationStorage } = await import('../storage');
    return new ConversationStorage().load(CONV_ID);
  }

  async function signIn(userId: string) {
    const { issueSlackToken } = await import('../oauth');
    const token = issueSlackToken({ slackUserId: userId, email: `${userId}@slack.local`, name: userId });
    const sso = await web.injectWebServer({ method: 'GET', url: `/auth/sso?token=${encodeURIComponent(token)}` });
    const setCookie = sso.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : String(setCookie)).split(';')[0];
    const me = await web.injectWebServer({ method: 'GET', url: '/auth/me', headers: { cookie } });
    return { cookie, csrf: JSON.parse(me.body).csrfToken as string };
  }

  function post(route: 'ensure-title' | 'generate-title', who: { cookie: string; csrf: string }, adminMode = 'off') {
    return web.injectWebServer({
      method: 'POST',
      url: `/api/dashboard/session/${CONV_ID}/${route}`,
      headers: { cookie: who.cookie, 'x-csrf-token': who.csrf, 'x-admin-mode': adminMode },
    });
  }

  beforeEach(async () => {
    vi.resetModules();
    llm.generateTitle.mockReset();
    paths.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-title-sub-'));
    web = await import('../web-server');
    recorder = await import('../recorder');
    await web.startWebServer({ listen: false });
  }, 60_000);

  afterEach(async () => {
    await web.stopWebServer();
    fs.rmSync(paths.dataDir, { recursive: true, force: true });
  });

  // ── T1: a missing subtitle is filled for any signed-in viewer ──

  it('T1 — fills a missing subtitle for a signed-in viewer who does not own the session', async () => {
    await seed();
    llm.generateTitle.mockResolvedValue('보드 이슈 #1234 자동 처리');
    const viewer = await signIn('U_VIEWER');

    const res = await post('ensure-title', viewer);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, titleSub: '보드 이슈 #1234 자동 처리' });
    expect((await stored())?.titleSub).toBe('보드 이슈 #1234 자동 처리');
    expect(llm.generateTitle).toHaveBeenCalledTimes(1);
    expect(llm.generateTitle.mock.calls[0][0]).toContain('$autoz <https://github.com/acme/board/issues/1234>');
  });

  it('T1 — returns the stored subtitle without an LLM call when one already exists', async () => {
    await seed({ titleSub: '이미 있는 부제' });
    const viewer = await signIn('U_VIEWER');

    const res = await post('ensure-title', viewer);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, titleSub: '이미 있는 부제' });
    expect(llm.generateTitle).not.toHaveBeenCalled();
  });

  it('T1 — still requires sign-in and a valid CSRF token; a CSRF rejection says so', async () => {
    await seed();
    llm.generateTitle.mockResolvedValue('x');

    const anon = await web.injectWebServer({ method: 'POST', url: `/api/dashboard/session/${CONV_ID}/ensure-title` });
    expect(anon.statusCode).toBe(401);

    const viewer = await signIn('U_VIEWER');
    const noCsrf = await web.injectWebServer({
      method: 'POST',
      url: `/api/dashboard/session/${CONV_ID}/ensure-title`,
      headers: { cookie: viewer.cookie },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(JSON.parse(noCsrf.body).code).toBe('csrf_failed');
    expect(llm.generateTitle).not.toHaveBeenCalled();
  });

  it('T1 — 404 for an unknown conversation', async () => {
    const viewer = await signIn('U_VIEWER');
    const res = await post('ensure-title', viewer);
    expect(res.statusCode).toBe(404);
  });

  it('T1 — concurrent fills of one conversation share a single LLM call', async () => {
    await seed();
    const gate = deferred<string | null>();
    llm.generateTitle.mockReturnValue(gate.promise);
    const a = await signIn('U_VIEWER');
    const b = await signIn('U_OTHER');

    const first = post('ensure-title', a);
    const second = post('ensure-title', b);
    await vi.waitFor(() => expect(llm.generateTitle).toHaveBeenCalled(), { timeout: 30_000 });
    gate.resolve('공유된 부제');
    const [r1, r2] = await Promise.all([first, second]);

    expect(llm.generateTitle).toHaveBeenCalledTimes(1);
    expect(JSON.parse(r1.body).titleSub).toBe('공유된 부제');
    expect(JSON.parse(r2.body).titleSub).toBe('공유된 부제');
  });

  it('T1 — a fill never overwrites a subtitle written while it was generating', async () => {
    await seed();
    const gate = deferred<string | null>();
    llm.generateTitle.mockReturnValue(gate.promise);
    const viewer = await signIn('U_VIEWER');

    const pending = post('ensure-title', viewer);
    await vi.waitFor(() => expect(llm.generateTitle).toHaveBeenCalled(), { timeout: 30_000 });
    await recorder.updateConversationTitleSub(CONV_ID, '소유자가 만든 부제');
    gate.resolve('늦게 도착한 부제');
    const res = await pending;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).titleSub).toBe('소유자가 만든 부제');
    expect((await stored())?.titleSub).toBe('소유자가 만든 부제');
  });

  it('T1 — a failed fill answers generation_failed, then pauses fills for the cooldown', async () => {
    await seed();
    llm.generateTitle.mockResolvedValue(null);
    const viewer = await signIn('U_VIEWER');

    const failed = await post('ensure-title', viewer);
    expect(failed.statusCode).toBe(502);
    expect(JSON.parse(failed.body).code).toBe('generation_failed');

    const again = await post('ensure-title', viewer);
    expect(again.statusCode).toBe(429);
    const body = JSON.parse(again.body);
    expect(body.code).toBe('cooldown');
    expect(body.retryAfterMs).toBeGreaterThan(0);
    expect(llm.generateTitle).toHaveBeenCalledTimes(1);
  });

  it('T1 — no conversation text means no LLM call', async () => {
    await seed({ turns: [] });
    const viewer = await signIn('U_VIEWER');

    const res = await post('ensure-title', viewer);

    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).code).toBe('no_content');
    expect(llm.generateTitle).not.toHaveBeenCalled();
  });

  // ── T2: 🔄 regenerates for whoever may overwrite; the #716 gate stays ──

  it('T2 — the owner regenerates (overwrites) an existing subtitle', async () => {
    await seed({ titleSub: '예전 부제' });
    llm.generateTitle.mockResolvedValue('새 부제');
    const owner = await signIn('U_OWNER');

    const res = await post('generate-title', owner);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, titleSub: '새 부제' });
    expect((await stored())?.titleSub).toBe('새 부제');
  });

  it('T2 — a non-owner cannot overwrite: generate-title stays 403 and the subtitle is untouched', async () => {
    await seed({ titleSub: '예전 부제' });
    llm.generateTitle.mockResolvedValue('남이 바꾼 부제');
    const viewer = await signIn('U_VIEWER');

    const res = await post('generate-title', viewer);

    expect(res.statusCode).toBe(403);
    expect(llm.generateTitle).not.toHaveBeenCalled();
    expect((await stored())?.titleSub).toBe('예전 부제');
  });

  it('T2 — an admin overwrites only with Admin mode on', async () => {
    await seed({ titleSub: '예전 부제' });
    llm.generateTitle.mockResolvedValue('관리자가 바꾼 부제');
    const admin = await signIn('U_ADMIN');

    expect((await post('generate-title', admin, 'off')).statusCode).toBe(403);
    const on = await post('generate-title', admin, 'on');
    expect(on.statusCode).toBe(200);
    expect(JSON.parse(on.body).titleSub).toBe('관리자가 바꾼 부제');
  });

  it('T2 — a regenerate that the LLM fails answers generation_failed and keeps the old subtitle', async () => {
    await seed({ titleSub: '예전 부제' });
    llm.generateTitle.mockResolvedValue(null);
    const owner = await signIn('U_OWNER');

    const res = await post('generate-title', owner);

    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body).code).toBe('generation_failed');
    expect((await stored())?.titleSub).toBe('예전 부제');
  });
});

describe('ensureTitleSub cooldown (server module)', () => {
  beforeEach(() => {
    vi.resetModules();
    llm.generateTitle.mockReset();
    paths.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-title-sub-mod-'));
  });

  afterEach(() => {
    fs.rmSync(paths.dataDir, { recursive: true, force: true });
  });

  it('allows the next fill once the cooldown has passed', async () => {
    const { ConversationStorage } = await import('../storage');
    await new ConversationStorage().save(conversation());
    const { getConversation } = await import('../recorder');
    const { ensureTitleSub, TITLE_SUB_FILL_COOLDOWN_MS } = await import('../title-sub');
    const record = await getConversation(CONV_ID);
    if (!record) throw new Error('seeded conversation missing');
    const t0 = 1_000_000;

    llm.generateTitle.mockResolvedValueOnce(null);
    expect(await ensureTitleSub(record, t0)).toMatchObject({ ok: false, reason: 'generation_failed' });
    expect(await ensureTitleSub(record, t0 + TITLE_SUB_FILL_COOLDOWN_MS - 1)).toMatchObject({
      ok: false,
      reason: 'cooldown',
    });
    expect(llm.generateTitle).toHaveBeenCalledTimes(1);

    llm.generateTitle.mockResolvedValueOnce('쿨다운 뒤 부제');
    expect(await ensureTitleSub(record, t0 + TITLE_SUB_FILL_COOLDOWN_MS)).toEqual({
      ok: true,
      titleSub: '쿨다운 뒤 부제',
    });
    expect(llm.generateTitle).toHaveBeenCalledTimes(2);
  }, 60_000);
});

describe('fill never overwrites — recorder and generation edge cases (review round 1)', () => {
  beforeEach(() => {
    vi.resetModules();
    llm.generateTitle.mockReset();
    paths.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-title-sub-race-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(paths.dataDir, { recursive: true, force: true });
  });

  it('concurrent cold reads share one disk read, so no stale snapshot can exist', async () => {
    const { ConversationStorage } = await import('../storage');
    await new ConversationStorage().save(conversation());
    const recorder = await import('../recorder');

    // Read #1 is held on the disk. Read #2 must not start its own disk read
    // (whose older snapshot could later land over the live object).
    const realLoad = ConversationStorage.prototype.load;
    const held = deferred<void>();
    const load = vi.spyOn(ConversationStorage.prototype, 'load').mockImplementation(async function (
      this: unknown,
      id: string,
    ) {
      await held.promise;
      return realLoad.call(this as InstanceType<typeof ConversationStorage>, id);
    });

    const first = recorder.getConversation(CONV_ID);
    const second = recorder.getConversation(CONV_ID);
    held.resolve();
    const [a, b] = await Promise.all([first, second]);

    expect(load).toHaveBeenCalledTimes(1);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  }, 60_000);

  // astra-zhuge review round 2: owner regenerates, the record is evicted from
  // the LRU cache (100 other conversations), then a viewer fills.
  it('after eviction a fill still sees the owner subtitle and does not overwrite it', async () => {
    const { ConversationStorage } = await import('../storage');
    const storage = new ConversationStorage();
    await storage.save(conversation());
    for (let i = 0; i < 100; i++) await storage.save(conversation({ id: `other-${i}` }));
    const recorder = await import('../recorder');

    await recorder.getConversation(CONV_ID);
    await recorder.updateConversationTitleSub(CONV_ID, 'OWNER-TITLE');
    for (let i = 0; i < 100; i++) await recorder.getConversation(`other-${i}`);

    expect(await recorder.fillConversationTitleSub(CONV_ID, 'late-viewer-fill')).toBe('OWNER-TITLE');
    expect((await storage.load(CONV_ID))?.titleSub).toBe('OWNER-TITLE');
  }, 120_000);

  it('a record with a save still in flight is not evicted', async () => {
    const { ConversationStorage } = await import('../storage');
    const storage = new ConversationStorage();
    await storage.save(conversation());
    for (let i = 0; i < 100; i++) await storage.save(conversation({ id: `other-${i}` }));
    const recorder = await import('../recorder');

    const live = await recorder.getConversation(CONV_ID);
    const realSave = ConversationStorage.prototype.save;
    const held = deferred<void>();
    vi.spyOn(ConversationStorage.prototype, 'save').mockImplementation(async function (
      this: unknown,
      record: ConversationRecord,
    ) {
      if (record.id === CONV_ID) await held.promise;
      return realSave.call(this as InstanceType<typeof ConversationStorage>, record);
    });
    const saving = recorder.updateConversationTitleSub(CONV_ID, 'OWNER-TITLE');
    for (let i = 0; i < 100; i++) await recorder.getConversation(`other-${i}`);

    // Still cached: the next read is the live object, not the pre-save file.
    expect(await recorder.getConversation(CONV_ID)).toBe(live);
    expect(await recorder.fillConversationTitleSub(CONV_ID, 'late-viewer-fill')).toBe('OWNER-TITLE');
    held.resolve();
    await saving;
    expect((await storage.load(CONV_ID))?.titleSub).toBe('OWNER-TITLE');
  }, 120_000);

  it('a fill does not bump updatedAt (derived data is not activity)', async () => {
    const { ConversationStorage } = await import('../storage');
    await new ConversationStorage().save(conversation({ updatedAt: 42 }));
    const recorder = await import('../recorder');

    expect(await recorder.fillConversationTitleSub(CONV_ID, '부제')).toBe('부제');
    const saved = await new ConversationStorage().load(CONV_ID);
    expect(saved?.titleSub).toBe('부제');
    expect(saved?.updatedAt).toBe(42);
  }, 60_000);

  it('a generation that throws is a failed fill and starts the cooldown', async () => {
    const { ConversationStorage } = await import('../storage');
    await new ConversationStorage().save(conversation());
    const { getConversation } = await import('../recorder');
    const { ensureTitleSub } = await import('../title-sub');
    const record = await getConversation(CONV_ID);
    if (!record) throw new Error('seeded conversation missing');

    llm.generateTitle.mockRejectedValueOnce(new Error('lease release failed'));
    expect(await ensureTitleSub(record, 1_000)).toEqual({ ok: false, reason: 'generation_failed' });
    expect(await ensureTitleSub(record, 1_001)).toMatchObject({ ok: false, reason: 'cooldown' });
    expect(llm.generateTitle).toHaveBeenCalledTimes(1);
  }, 60_000);
});

// ── Client half: the shipped panel code, cut out of renderDashboardPage() ──

const DASHBOARD_TS = fs.readFileSync(path.join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function clientFn(name: string): string {
  const start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}

interface TitleSubClient {
  titleSubCanRegen(ownerId: unknown, viewerId: unknown, viewerIsAdmin: unknown, adminModeOn: unknown): boolean;
  titleSubEndpoint(convId: string, regenerate: boolean): string;
  isCsrfRejection(status: number, data: unknown): boolean;
  titleSubView(
    status: number,
    data: unknown,
    canRegen: boolean,
    previous: string,
  ): { text: string; titleSub: string; regen: boolean };
}

const FNS = ['titleSubCanRegen', 'titleSubEndpoint', 'isCsrfRejection', 'titleSubView'];
function client(): TitleSubClient {
  const body = `${FNS.map(clientFn).join('\n')}\nreturn { ${FNS.join(', ')} };`;
  return new Function('READ_ONLY_MSG', body)('Read-only — not your session') as TitleSubClient;
}

describe('panel subtitle client (shipped code)', () => {
  it('T2 — 🔄 over an existing subtitle is offered to the owner or an Admin-mode admin only', () => {
    const c = client();
    expect(c.titleSubCanRegen('U_OWNER', 'U_OWNER', false, false)).toBe(true);
    expect(c.titleSubCanRegen('U_OWNER', 'U_VIEWER', false, false)).toBe(false);
    expect(c.titleSubCanRegen('U_OWNER', 'U_ADMIN', true, true)).toBe(true);
    expect(c.titleSubCanRegen('U_OWNER', 'U_ADMIN', true, false)).toBe(false);
    // A stray "on" flag in localStorage alone never unlocks it.
    expect(c.titleSubCanRegen('U_OWNER', 'U_VIEWER', false, true)).toBe(false);
    // Fail closed on a legacy record with no owner.
    expect(c.titleSubCanRegen(undefined, '', false, false)).toBe(false);
  });

  it('T1 — a missing subtitle goes to ensure-title; 🔄 over an existing one goes to generate-title', () => {
    const c = client();
    expect(c.titleSubEndpoint('conv/1', false)).toBe('/api/dashboard/session/conv%2F1/ensure-title');
    expect(c.titleSubEndpoint('conv/1', true)).toBe('/api/dashboard/session/conv%2F1/generate-title');
  });

  it('only a CSRF rejection triggers the token refresh + retry', () => {
    const c = client();
    expect(c.isCsrfRejection(403, { code: 'csrf_failed' })).toBe(true);
    expect(c.isCsrfRejection(403, { error: 'Forbidden — write requires conversation ownership' })).toBe(false);
    expect(c.isCsrfRejection(500, { code: 'csrf_failed' })).toBe(false);
  });

  it('T1 — a filled subtitle shows; 🔄 follows the overwrite rule', () => {
    const c = client();
    expect(c.titleSubView(200, { ok: true, titleSub: '부제' }, false, '')).toEqual({
      text: '부제',
      titleSub: '부제',
      regen: false,
    });
    expect(c.titleSubView(200, { ok: true, titleSub: '부제' }, true, '')).toEqual({
      text: '부제',
      titleSub: '부제',
      regen: true,
    });
  });

  it('T2 — a failed fill shows the failure with 🔄 to retry the fill', () => {
    const c = client();
    const v = c.titleSubView(502, { code: 'generation_failed' }, false, '');
    expect(v).toEqual({ text: 'Title generation failed', titleSub: '', regen: true });
    const cool = c.titleSubView(429, { code: 'cooldown', retryAfterMs: 42_000 }, false, '');
    expect(cool.text).toMatch(/retry/i);
    expect(cool.regen).toBe(true);
  });

  it('T2 — a permission 403 is never rendered as "Title generation failed"', () => {
    const c = client();
    const kept = c.titleSubView(403, { error: 'Forbidden' }, true, '예전 부제');
    expect(kept).toEqual({ text: '예전 부제', titleSub: '예전 부제', regen: false });
    const none = c.titleSubView(403, { error: 'Forbidden' }, false, '');
    expect(none.text).not.toMatch(/Title generation failed/);
    expect(none.regen).toBe(false);
  });

  it('a CSRF rejection that survives the retry is a plain failure with 🔄, not "read-only"', () => {
    const c = client();
    const v = c.titleSubView(403, { code: 'csrf_failed' }, false, '');
    expect(v).toEqual({ text: 'Title generation failed', titleSub: '', regen: true });
  });

  it('T2 — 🔄 is judged against the signed-in user, not the board filter (currentUserId)', () => {
    const can = clientFn('panelTitleSubCanRegen');
    expect(can.includes('_viewerUserId')).toBe(true);
    expect(can.includes('currentUserId')).toBe(false);
    expect(clientFn('_applyUserPill').includes('_viewerUserId = (data && data.user && data.user.slackUserId)')).toBe(
      true,
    );
  });

  it('T1/T2 — the panel wires the helpers: open → ensure path, 🔄 → regenerate only over a stored subtitle', () => {
    expect(TEMPLATE.includes('generateTitleSub(loadingConvId, false)')).toBe(true);
    expect(TEMPLATE.includes('generateTitleSub(panelConvId, !!_panelTitleSub)')).toBe(true);
    expect(/textEl\.textContent = 'Title generation failed';/.test(TEMPLATE)).toBe(false);
  });
});
