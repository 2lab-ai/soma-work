/**
 * #1080 — the cron drawer's 내용 보기 and 편집, server half:
 *   GET    /api/dashboard/cron/:id      — the whole job, prompt included
 *   PATCH  /api/dashboard/cron/:id      — the form's change
 * and the drawer's 지금 실행 and 삭제:
 *   POST   /api/dashboard/cron/:id/run  — fire it now, through the scheduler, as its owner
 *   DELETE /api/dashboard/cron/:id      — remove it
 * All for the job's owner, an admin with Admin mode on, or the viewer token
 * (the #716 write gate) — never for anyone else. The lane
 * (GET /api/dashboard/cron) still never carries a prompt.
 *
 * The jobs live in a real CronStorage file, so what a PATCH answers is what the
 * scheduler reads on its next tick.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CronStorage } from 'somalib/cron/cron-storage';
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
    jwtSecret: 'test-jwt-secret',
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
const PROMPT_MARKER = 'PROMPT-BODY-ONLY-FOR-THE-DRAWER';
const JSON_HEADERS = { 'content-type': 'application/json' };

describe('Dashboard cron editor API (#1080)', () => {
  let injectWebServer: any;
  let stopWebServer: any;
  let dashboard: any;
  let dir: string;
  let storage: CronStorage;
  let nightly: { id: string };
  let anchored: { id: string };
  let others: { id: string };

  beforeEach(async () => {
    vi.resetModules();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-dash-cron-edit-'));
    storage = new CronStorage(path.join(dir, 'cron-jobs.json'));
    nightly = storage.addJob({
      name: 'nightly-qa',
      expression: '0 9 * * 1-5',
      prompt: PROMPT_MARKER,
      owner: 'U_OWNER',
      channel: 'C0001',
      threadTs: null,
    });
    // A job replying in a thread it is anchored to.
    anchored = storage.addJob({
      name: 'thread-digest',
      expression: '30 0 * * *',
      prompt: 'digest',
      owner: 'U_OWNER',
      channel: 'C0001',
      threadTs: '1700000000.000100',
      target: 'thread',
    });
    others = storage.addJob({
      name: 'nightly-qa',
      expression: '0 1 * * *',
      prompt: 'someone else',
      owner: 'U_OTHER',
      channel: 'C0009',
      threadTs: null,
    });
    const webServer = await import('../web-server');
    injectWebServer = webServer.injectWebServer;
    stopWebServer = webServer.stopWebServer;
    dashboard = await import('../dashboard');
    dashboard.setDashboardCronSource(source());
    await webServer.startWebServer({ listen: false });
  });

  afterEach(async () => {
    fire = async () => ({ ok: true, message: 'idle_inject' });
    runJob.mockClear();
    dashboard.setCronRunAnswerWaitMs(undefined);
    dashboard.setDashboardCronSource(null);
    await stopWebServer();
    delete process.env.ADMIN_USERS;
    (await import('../../admin-utils')).resetAdminUsersCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** What the scheduler answers a manual fire with; null = no scheduler on this instance. */
  let fire: (() => Promise<{ ok: boolean; message: string }>) | null = async () => ({
    ok: true,
    message: 'idle_inject',
  });
  const runJob = vi.fn((_id: string, _triggeredBy: string) => (fire ? fire() : null));

  /** The source src/index.ts wires: the jobs by id, a change and a removal by (owner, name), a fire through the scheduler. */
  function source() {
    return {
      listJobs: () => storage.getAll(),
      listHistory: () => storage.getExecutionHistory(),
      getJob: (id: string) => storage.getAll().find((j) => j.id === id),
      updateJob: (id: string, patch: any) => {
        const job = storage.getAll().find((j) => j.id === id);
        return job ? storage.updateJob(job.owner, job.name, patch) : null;
      },
      runJob,
      deleteJob: (id: string) => {
        const job = storage.getAll().find((j) => j.id === id);
        return job ? storage.removeJob(job.owner, job.name) : false;
      },
    };
  }
  const stored = (id: string) => storage.getAll().find((j) => j.id === id)!;

  async function signIn(userId: string) {
    const { issueSlackToken } = await import('../oauth');
    const token = issueSlackToken({ slackUserId: userId, email: `${userId}@slack.local`, name: userId });
    const sso = await injectWebServer({ method: 'GET', url: `/auth/sso?token=${encodeURIComponent(token)}` });
    const setCookie = sso.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : String(setCookie)).split(';')[0];
    const me = await injectWebServer({ method: 'GET', url: '/auth/me', headers: { cookie } });
    return { cookie, csrfToken: JSON.parse(me.body).csrfToken as string };
  }
  async function asAdmin() {
    process.env.ADMIN_USERS = 'U_ADMIN';
    (await import('../../admin-utils')).resetAdminUsersCache();
    return signIn('U_ADMIN');
  }
  const get = (id: string, headers: Record<string, string> = AUTH_HEADER) =>
    injectWebServer({ method: 'GET', url: `/api/dashboard/cron/${encodeURIComponent(id)}`, headers });
  const patch = (id: string, payload: unknown, headers: Record<string, string> = AUTH_HEADER) =>
    injectWebServer({
      method: 'PATCH',
      url: `/api/dashboard/cron/${encodeURIComponent(id)}`,
      headers: { ...headers, ...JSON_HEADERS },
      payload,
    });
  const runNow = (id: string, headers: Record<string, string> = AUTH_HEADER) =>
    injectWebServer({ method: 'POST', url: `/api/dashboard/cron/${encodeURIComponent(id)}/run`, headers });
  const remove = (id: string, headers: Record<string, string> = AUTH_HEADER) =>
    injectWebServer({ method: 'DELETE', url: `/api/dashboard/cron/${encodeURIComponent(id)}`, headers });

  describe('GET /api/dashboard/cron/:id — the whole job', () => {
    it('the owner reads every field, the prompt included', async () => {
      const { cookie } = await signIn('U_OWNER');
      const res = await get(nightly.id, { cookie });
      expect(res.statusCode).toBe(200);
      const { job } = JSON.parse(res.body);
      expect(job).toMatchObject({
        id: nightly.id,
        name: 'nightly-qa',
        expression: '0 9 * * 1-5',
        prompt: PROMPT_MARKER,
        owner: 'U_OWNER',
        channel: 'C0001',
        threadTs: null,
        mode: 'default',
        target: 'channel',
        model: { type: 'default' },
        runAllowlist: [],
        scheduleChangedAt: null,
        lastRunAt: null,
      });
      expect(typeof job.createdAt).toBe('number');
      expect(typeof job.nextRunAt).toBe('number');
    });

    it('another signed-in user gets 403 and no prompt', async () => {
      const { cookie } = await signIn('U_STRANGER');
      const res = await get(nightly.id, { cookie });
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain(PROMPT_MARKER);
    });

    it('an admin needs Admin mode on: 403 without it, 200 with it', async () => {
      const { cookie } = await asAdmin();
      const without = await get(nightly.id, { cookie });
      expect(without.statusCode).toBe(403);
      expect(without.body).not.toContain(PROMPT_MARKER);
      const withMode = await get(nightly.id, { cookie, 'x-admin-mode': 'on' });
      expect(withMode.statusCode).toBe(200);
      expect(JSON.parse(withMode.body).job.prompt).toBe(PROMPT_MARKER);
    });

    it('a non-admin sending Admin mode on is still refused', async () => {
      const { cookie } = await signIn('U_STRANGER');
      expect((await get(nightly.id, { cookie, 'x-admin-mode': 'on' })).statusCode).toBe(403);
    });

    it('the viewer token reads it; anonymous callers cannot', async () => {
      const res = await get(nightly.id);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).job.prompt).toBe(PROMPT_MARKER);
      expect((await get(nightly.id, {})).statusCode).toBe(401);
    });

    it('an unknown id is 404; no cron source is 503', async () => {
      expect((await get('no-such-job')).statusCode).toBe(404);
      dashboard.setDashboardCronSource(null);
      expect((await get(nightly.id)).statusCode).toBe(503);
    });

    it('the lane still never carries a prompt', async () => {
      const res = await injectWebServer({ method: 'GET', url: '/api/dashboard/cron', headers: AUTH_HEADER });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).jobs).toHaveLength(3);
      expect(res.body).not.toContain(PROMPT_MARKER);
      expect(res.body).not.toContain('"prompt"');
    });
  });

  describe('PATCH /api/dashboard/cron/:id — the form’s change', () => {
    it('the owner changes every field; the answer is the fresh job, and the storage has it', async () => {
      const { cookie, csrfToken } = await signIn('U_OWNER');
      const res = await patch(
        nightly.id,
        {
          name: 'morning-qa',
          expression: '0  0 * * 1-5',
          prompt: 'a new prompt',
          channel: 'C0002',
          mode: 'fastlane',
          target: 'dm',
          model: { type: 'custom', model: 'claude-sonnet-4-20250514' },
        },
        { cookie, 'x-csrf-token': csrfToken },
      );
      expect(res.statusCode).toBe(200);
      const { job } = JSON.parse(res.body);
      expect(job).toMatchObject({
        id: nightly.id,
        name: 'morning-qa',
        expression: '0 0 * * 1-5',
        prompt: 'a new prompt',
        channel: 'C0002',
        mode: 'fastlane',
        target: 'dm',
        model: { type: 'custom', model: 'claude-sonnet-4-20250514' },
      });
      expect(typeof job.scheduleChangedAt).toBe('number');
      expect(stored(nightly.id)).toMatchObject({
        name: 'morning-qa',
        expression: '0 0 * * 1-5',
        prompt: 'a new prompt',
        channel: 'C0002',
        mode: 'fastlane',
        target: 'dm',
        modelConfig: { type: 'custom', model: 'claude-sonnet-4-20250514' },
      });
      // Back to the defaults: no overrides stored.
      const back = await patch(
        nightly.id,
        { mode: 'default', target: 'channel', model: { type: 'default' } },
        { cookie, 'x-csrf-token': csrfToken },
      );
      expect(back.statusCode).toBe(200);
      const plain = stored(nightly.id);
      expect(plain.mode).toBeUndefined();
      expect(plain.target).toBeUndefined();
      expect(plain.modelConfig).toBeUndefined();
    });

    it('another signed-in user gets 403 and nothing changes', async () => {
      const { cookie, csrfToken } = await signIn('U_STRANGER');
      const res = await patch(nightly.id, { prompt: 'hijack' }, { cookie, 'x-csrf-token': csrfToken });
      expect(res.statusCode).toBe(403);
      expect(stored(nightly.id).prompt).toBe(PROMPT_MARKER);
    });

    it('an admin needs Admin mode on: 403 without it, 200 with it', async () => {
      const { cookie, csrfToken } = await asAdmin();
      const without = await patch(nightly.id, { prompt: 'by admin' }, { cookie, 'x-csrf-token': csrfToken });
      expect(without.statusCode).toBe(403);
      expect(stored(nightly.id).prompt).toBe(PROMPT_MARKER);
      const withMode = await patch(
        nightly.id,
        { prompt: 'by admin' },
        { cookie, 'x-csrf-token': csrfToken, 'x-admin-mode': 'on' },
      );
      expect(withMode.statusCode).toBe(200);
      expect(stored(nightly.id).prompt).toBe('by admin');
      // The job stays its owner's.
      expect(stored(nightly.id).owner).toBe('U_OWNER');
    });

    it('the viewer token changes it; anonymous callers and a missing CSRF token cannot', async () => {
      expect((await patch(nightly.id, { prompt: 'by token' })).statusCode).toBe(200);
      expect(stored(nightly.id).prompt).toBe('by token');
      expect((await patch(nightly.id, { prompt: 'anon' }, {})).statusCode).toBe(401);
      const { cookie } = await signIn('U_OWNER');
      const noCsrf = await patch(nightly.id, { prompt: 'no csrf' }, { cookie });
      expect(noCsrf.statusCode).toBe(403);
      expect(stored(nightly.id).prompt).toBe('by token');
    });

    it('a bad value is 400 naming the field, and nothing changes', async () => {
      const before = stored(nightly.id);
      for (const [body, field] of [
        [{ expression: '0 9 * *' }, 'expression'],
        [{ expression: '99 9 * * *' }, 'expression'],
        [{ name: 'has space' }, 'name'],
        [{ prompt: '' }, 'prompt'],
        [{ prompt: 'x'.repeat(4001) }, 'prompt'],
        [{ channel: 'general' }, 'channel'],
        [{ mode: 'turbo' }, 'mode'],
        [{ model: { type: 'custom' } }, 'model'],
        [{ target: 'thread' }, 'target'],
        [{ owner: 'U_STRANGER' }, 'owner'],
      ] as const) {
        const res = await patch(nightly.id, body);
        expect(res.statusCode, JSON.stringify(body)).toBe(400);
        const answer = JSON.parse(res.body);
        expect(answer.field, JSON.stringify(body)).toBe(field);
        expect(answer.error).toMatch(/\S/);
      }
      expect((await patch(nightly.id, {})).statusCode).toBe(400);
      expect(stored(nightly.id)).toEqual(before);
    });

    it('a thread reply needs the job’s own thread anchor — the dashboard cannot pick one', async () => {
      const refused = await patch(nightly.id, { target: 'thread' });
      expect(refused.statusCode).toBe(400);
      expect(JSON.parse(refused.body).field).toBe('target');
      expect(stored(nightly.id).target).toBeUndefined();
      // A job that has one may reply there (it already does).
      const kept = await patch(anchored.id, { target: 'thread', prompt: 'digest 2' });
      expect(kept.statusCode).toBe(200);
      expect(stored(anchored.id)).toMatchObject({ target: 'thread', threadTs: '1700000000.000100' });
    });

    it('a channel change drops the thread anchor of the old channel', async () => {
      const res = await patch(anchored.id, { channel: 'C0002' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).job).toMatchObject({ channel: 'C0002', target: 'channel', threadTs: null });
      const job = stored(anchored.id);
      expect(job.threadTs).toBeNull();
      expect(job.target).toBeUndefined();
    });

    it('a name another job of the same owner has is 409; the same name under another owner is fine', async () => {
      const clash = await patch(anchored.id, { name: 'nightly-qa' });
      expect(clash.statusCode).toBe(409);
      expect(JSON.parse(clash.body).field).toBe('name');
      expect(stored(anchored.id).name).toBe('thread-digest');
      // U_OTHER's job is also called nightly-qa: names are per owner.
      expect((await patch(nightly.id, { name: 'nightly-qa', prompt: 'same name' })).statusCode).toBe(200);
      expect(stored(others.id).prompt).toBe('someone else');
    });

    it('an unknown id is 404; no cron source is 503', async () => {
      expect((await patch('no-such-job', { prompt: 'x' })).statusCode).toBe(404);
      dashboard.setDashboardCronSource(null);
      expect((await patch(nightly.id, { prompt: 'x' })).statusCode).toBe(503);
    });
  });

  describe('POST /api/dashboard/cron/:id/run — 지금 실행', () => {
    it('the owner fires it through the scheduler, attributed to them; a quick answer is passed on', async () => {
      const { cookie, csrfToken } = await signIn('U_OWNER');
      const res = await runNow(nightly.id, { cookie, 'x-csrf-token': csrfToken });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true, detail: 'idle_inject' });
      expect(runJob).toHaveBeenCalledTimes(1);
      expect(runJob).toHaveBeenCalledWith(nightly.id, 'U_OWNER');
    });

    it('a fire still running when the wait ends is answered as started — the request never waits for the turn', async () => {
      dashboard.setCronRunAnswerWaitMs(30);
      let finish!: (v: { ok: boolean; message: string }) => void;
      fire = () => new Promise((resolve) => (finish = resolve));
      const res = await runNow(nightly.id);
      expect(res.statusCode).toBe(202);
      expect(JSON.parse(res.body)).toEqual({ ok: true, started: true });
      finish({ ok: true, message: 'new_thread' }); // the turn ends later; nothing is left waiting on it
    });

    it('a fire the scheduler could not deliver is 502 with its reason', async () => {
      fire = async () => ({ ok: false, message: 'delivery failed (dm) — cron history 확인' });
      const res = await runNow(nightly.id);
      expect(res.statusCode).toBe(502);
      expect(JSON.parse(res.body).error).toBe('delivery failed (dm) — cron history 확인');
    });

    it('a fire that throws is 502, not a hung request', async () => {
      fire = async () => {
        throw new Error('slack down');
      };
      const res = await runNow(nightly.id);
      expect(res.statusCode).toBe(502);
      expect(JSON.parse(res.body).error).toMatch(/slack down/);
    });

    it('another signed-in user gets 403 and nothing fires', async () => {
      const { cookie, csrfToken } = await signIn('U_STRANGER');
      expect((await runNow(nightly.id, { cookie, 'x-csrf-token': csrfToken })).statusCode).toBe(403);
      expect(runJob).not.toHaveBeenCalled();
    });

    it('an admin needs Admin mode on; the fire is attributed to the admin', async () => {
      const { cookie, csrfToken } = await asAdmin();
      expect((await runNow(nightly.id, { cookie, 'x-csrf-token': csrfToken })).statusCode).toBe(403);
      expect(runJob).not.toHaveBeenCalled();
      const res = await runNow(nightly.id, { cookie, 'x-csrf-token': csrfToken, 'x-admin-mode': 'on' });
      expect(res.statusCode).toBe(200);
      expect(runJob).toHaveBeenCalledWith(nightly.id, 'U_ADMIN');
    });

    it('the viewer token fires it; anonymous callers and a missing CSRF token cannot', async () => {
      expect((await runNow(nightly.id)).statusCode).toBe(200);
      expect(runJob).toHaveBeenLastCalledWith(nightly.id, 'dashboard');
      expect((await runNow(nightly.id, {})).statusCode).toBe(401);
      const { cookie } = await signIn('U_OWNER');
      expect((await runNow(nightly.id, { cookie })).statusCode).toBe(403);
      expect(runJob).toHaveBeenCalledTimes(1);
    });

    it('an unknown id is 404; no scheduler on this instance is 503', async () => {
      expect((await runNow('no-such-job')).statusCode).toBe(404);
      fire = null;
      const res = await runNow(nightly.id);
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body).error).toMatch(/\S/);
    });
  });

  describe('DELETE /api/dashboard/cron/:id — 삭제', () => {
    it('the owner removes it; the other owner’s job of the same name stays', async () => {
      const { cookie, csrfToken } = await signIn('U_OWNER');
      const res = await remove(nightly.id, { cookie, 'x-csrf-token': csrfToken });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true });
      expect(storage.getAll().find((j) => j.id === nightly.id)).toBeUndefined();
      expect(stored(others.id).name).toBe('nightly-qa');
      expect((await remove(nightly.id)).statusCode).toBe(404); // already gone
    });

    it('another signed-in user gets 403 and the job stays', async () => {
      const { cookie, csrfToken } = await signIn('U_STRANGER');
      expect((await remove(nightly.id, { cookie, 'x-csrf-token': csrfToken })).statusCode).toBe(403);
      expect(stored(nightly.id).prompt).toBe(PROMPT_MARKER);
    });

    it('an admin needs Admin mode on', async () => {
      const { cookie, csrfToken } = await asAdmin();
      expect((await remove(nightly.id, { cookie, 'x-csrf-token': csrfToken })).statusCode).toBe(403);
      expect(stored(nightly.id)).toBeDefined();
      const res = await remove(nightly.id, { cookie, 'x-csrf-token': csrfToken, 'x-admin-mode': 'on' });
      expect(res.statusCode).toBe(200);
      expect(storage.getAll().find((j) => j.id === nightly.id)).toBeUndefined();
    });

    it('anonymous callers and a missing CSRF token cannot; the viewer token can', async () => {
      expect((await remove(nightly.id, {})).statusCode).toBe(401);
      const { cookie } = await signIn('U_OWNER');
      expect((await remove(nightly.id, { cookie })).statusCode).toBe(403);
      expect(stored(nightly.id)).toBeDefined();
      expect((await remove(nightly.id)).statusCode).toBe(200);
    });

    it('an unknown id is 404; no cron source is 503', async () => {
      expect((await remove('no-such-job')).statusCode).toBe(404);
      dashboard.setDashboardCronSource(null);
      expect((await remove(nightly.id)).statusCode).toBe(503);
    });
  });
});
