import * as fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvRunQueue } from '../../env-run-queue';
import { ENVIRONMENT_REQUEST_MAX_CHARS, SkillForceHandler } from '../skill-force-handler';

vi.mock('node:fs');

vi.mock('../../../env-paths', () => ({ PLUGINS_DIR: '/mock/plugins', DATA_DIR: '/mock/data' }));
vi.mock('../../../path-utils', () => ({
  isSafePathSegment: (s: string) => !!s && !s.includes('/') && !s.includes('..'),
}));

const h = vi.hoisted(() => ({
  isAllowed: vi.fn((_o: string, _s: string, _r: string) => false),
  hasOneTime: vi.fn((_o: string, _s: string, _r: string) => false),
  consumeOneTime: vi.fn((_o: string, _s: string, _r: string) => true),
  addOneTime: vi.fn(),
  createReq: vi.fn((i: any) => ({ requestId: 'req-1', ...i })),
  markHandled: vi.fn(),
  retire: vi.fn(),
}));
vi.mock('../../../user-skill-grants-store', () => ({
  isSkillUseAllowed: h.isAllowed,
  hasOneTimeGrant: h.hasOneTime,
  consumeOneTimeGrant: h.consumeOneTime,
  addOneTimeGrant: h.addOneTime,
}));
vi.mock('../../../skill-permission-request-store', () => ({
  createPermissionRequest: h.createReq,
  markRequestHandled: h.markHandled,
  retirePendingRequests: h.retire,
}));
vi.mock('../../../admin-utils', () => ({
  isAdminUser: (u: string) => u === 'UADMIN' || u === 'env:acme-dev2',
  getAdminUsers: () => new Set(['UADMIN']),
}));
vi.mock('../../../env-users', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../env-users')>()),
  isEnvironmentUser: (u: string) => u === 'env:acme-dev2',
}));

const ENV_SKILL = '/mock/data/env:acme-dev2/skills/deploy/SKILL.md';
const PERSON_SKILL = '/mock/data/U094/skills/deploy/SKILL.md';
const PLUGIN_SKILL = '/mock/plugins/stv/skills/new-task/SKILL.md';

/**
 * #1304 — what a model's RUN_ENV_SKILL may hand off, decided by the same resolution a typed message gets, before
 * anything is posted or run; and the run the typed path starts, handed back so the host can wake the requester.
 */
describe('SkillForceHandler — environment hand-off for a model command (#1304)', () => {
  const say = vi.fn().mockResolvedValue({ ts: '1' });
  const resolveUser = (t: string): string | null =>
    t === 'acme-dev2' ? 'env:acme-dev2' : t === 'Zhuge' ? 'U094' : null;
  const runAsUser = vi.fn(async (input: { onOpened?: (ts: string) => void }) => {
    input.onOpened?.('900.1');
    return '900.1';
  });
  const slackApi = {
    openDmChannel: vi.fn(async (u: string) => `D-${u}`),
    postMessage: vi.fn(async () => ({ ts: '5' })),
    getPermalink: vi.fn(async () => 'https://slack.example/p900'),
  };
  const handler = new SkillForceHandler(resolveUser, { slackApi: slackApi as any, runAsUser });
  const ctx = (text: string, user = 'U1') => ({ user, channel: 'C1', threadTs: '171.1', text, say });

  beforeEach(() => {
    vi.clearAllMocks();
    h.isAllowed.mockReturnValue(false);
    h.hasOneTime.mockReturnValue(false);
    vi.mocked(fs.existsSync).mockImplementation((p) =>
      [ENV_SKILL, PERSON_SKILL, PLUGIN_SKILL, '/mock/plugins/stv'].includes(String(p)),
    );
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      throw new Error(`no read expected: ${String(p)}`);
    });
  });

  describe('checkEnvironmentHandoff', () => {
    it("accepts one environment user's existing skill and names it", () => {
      expect(handler.checkEnvironmentHandoff('$acme-dev2:deploy QA 1.4.0..1.4.2', 'U1')).toEqual({
        ok: true,
        owner: 'env:acme-dev2',
        skill: 'deploy',
      });
    });

    it.each([
      ['your own skill', '$user:deploy', 'U094', /environment user/],
      ["another person's skill", '$Zhuge:deploy', 'U1', /environment user/],
      ['a plugin skill', '$stv:new-task', 'U1', /environment user/],
      ['a skill the environment user does not have', '$acme-dev2:nope', 'U1', /not found|no skill/i],
      ['text with no skill reference', 'please run QA', 'U1', /skill reference/i],
      ['text that names a second skill', '$acme-dev2:deploy then $Zhuge:deploy', 'U1', /one/i],
      ['the environment user itself', '$acme-dev2:deploy', 'env:acme-dev2', /already runs as/i],
      [
        'a request longer than the admin card shows',
        `$acme-dev2:deploy ${'x'.repeat(ENVIRONMENT_REQUEST_MAX_CHARS)}`,
        'U1',
        new RegExp(String(ENVIRONMENT_REQUEST_MAX_CHARS)),
      ],
    ])('rejects %s — with a reason, and nothing posted, asked or run', (_label, text, user, reason) => {
      const check = handler.checkEnvironmentHandoff(text, user);
      expect(check.ok).toBe(false);
      if (check.ok) return;
      expect(check.reason).toMatch(reason);
      expect(say).not.toHaveBeenCalled();
      expect(runAsUser).not.toHaveBeenCalled();
      expect(h.createReq).not.toHaveBeenCalled();
      expect(slackApi.postMessage).not.toHaveBeenCalled();
      expect(h.consumeOneTime).not.toHaveBeenCalled();
    });

    it('never reads a skill body (the environment user reads it, in its own session)', () => {
      handler.checkEnvironmentHandoff('$acme-dev2:deploy go', 'U1');
      expect(fs.readFileSync).not.toHaveBeenCalled();
    });
  });

  describe('execute — the run it starts', () => {
    it('hands back the environment run; it settles with the thread link once the run ends', async () => {
      h.isAllowed.mockReturnValue(true);
      const result = await handler.execute(ctx('$acme-dev2:deploy QA'));
      expect(result.handled).toBe(true);
      expect(result.environmentRun?.owner).toBe('env:acme-dev2');
      await expect(result.environmentRun?.finished).resolves.toEqual({
        ok: true,
        rootTs: '900.1',
        link: 'https://slack.example/p900',
      });
    });

    it('a run that opened no thread settles as not run', async () => {
      h.isAllowed.mockReturnValue(true);
      runAsUser.mockResolvedValueOnce(undefined as unknown as string);
      const result = await handler.execute(ctx('$acme-dev2:deploy QA'));
      const end = await result.environmentRun?.finished;
      expect(end?.ok).toBe(false);
    });

    it('a run that failed settles with its error', async () => {
      h.isAllowed.mockReturnValue(true);
      runAsUser.mockRejectedValueOnce(new Error('scheduler off'));
      const result = await handler.execute(ctx('$acme-dev2:deploy QA'));
      await expect(result.environmentRun?.finished).resolves.toEqual({ ok: false, reason: 'scheduler off' });
    });

    it('a request waiting for the admins has no run', async () => {
      const result = await handler.execute(ctx('$acme-dev2:deploy QA'));
      expect(result).toMatchObject({ handled: true, awaitingPermission: true });
      expect(result.environmentRun).toBeUndefined();
    });
  });

  /**
   * SSOT 2026-11-19 — environment work runs one at a time per environment user: a second hand-off waits in line (the
   * requester's thread is told it is queued, not asked anything) and starts by itself once the first run ended.
   */
  describe('environment run queue', () => {
    it('a second hand-off to the same environment waits for the first run, then starts by itself', async () => {
      h.isAllowed.mockReturnValue(true);
      const releases: Array<() => void> = [];
      const queuedRun = vi.fn(
        (input: { onOpened?: (ts: string) => void }) =>
          new Promise<string>((resolve) => {
            input.onOpened?.('900.1');
            releases.push(() => resolve('900.1'));
          }),
      );
      const queue = new EnvRunQueue({ schedule: () => {} });
      const queued = new SkillForceHandler(resolveUser, {
        slackApi: slackApi as any,
        runAsUser: queuedRun,
        envRunQueue: queue,
      });
      const sayA = vi.fn().mockResolvedValue({ ts: '1' });
      const sayB = vi.fn().mockResolvedValue({ ts: '1' });

      const a = await queued.execute({
        user: 'U1',
        channel: 'C1',
        threadTs: '171.1',
        text: '$acme-dev2:deploy QA',
        say: sayA,
      });
      const b = await queued.execute({
        user: 'U1',
        channel: 'C1',
        threadTs: '272.2',
        text: '$acme-dev2:deploy QA',
        say: sayB,
      });
      expect(queuedRun).toHaveBeenCalledTimes(1);
      expect(queue.statusFor('C1', '272.2')).toMatchObject({ state: 'queued', owner: 'env:acme-dev2', position: 1 });
      // The waiting requester is told it is in line — a notice, never a question.
      const notices = sayB.mock.calls.map((c) => String(c[0]?.text ?? ''));
      expect(notices.some((t) => t.includes('대기열') && t.includes('env:acme-dev2'))).toBe(true);

      releases[0]();
      await expect(a.environmentRun?.finished).resolves.toMatchObject({ ok: true });
      await vi.waitFor(() => expect(queuedRun).toHaveBeenCalledTimes(2));
      expect(queue.statusFor('C1', '272.2')).toMatchObject({ state: 'running' });
      releases[1]();
      await expect(b.environmentRun?.finished).resolves.toMatchObject({ ok: true });
      expect(queue.isPending('C1', '272.2')).toBe(false);
    });

    it('the first hand-off starts at once and posts no queue notice', async () => {
      h.isAllowed.mockReturnValue(true);
      const queue = new EnvRunQueue({ schedule: () => {} });
      const free = new SkillForceHandler(resolveUser, { slackApi: slackApi as any, runAsUser, envRunQueue: queue });
      const sayA = vi.fn().mockResolvedValue({ ts: '1' });
      const a = await free.execute({
        user: 'U1',
        channel: 'C1',
        threadTs: '171.1',
        text: '$acme-dev2:deploy QA',
        say: sayA,
      });
      await a.environmentRun?.finished;
      expect(sayA.mock.calls.map((c) => String(c[0]?.text ?? '')).some((t) => t.includes('대기열'))).toBe(false);
    });
  });
});
