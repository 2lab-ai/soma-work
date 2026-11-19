import * as fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvHandoffRuns } from '../../env-handoff-runs';
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
   * .prd/36 A10 · A11 — hand-offs are not serialized per environment user any more (lanes line up in the work queue,
   * by keys). The requester waits on the host while its hand-off runs, and the hand-off ends only when the
   * environment user's thread holds no work-queue entry — a run that queued and ended its first turn is not over.
   */
  describe('hand-off and the work queue', () => {
    it('A11 — two hand-offs to the same environment start at once', async () => {
      h.isAllowed.mockReturnValue(true);
      const never = vi.fn(() => new Promise<string>(() => {}));
      const both = new SkillForceHandler(resolveUser, { slackApi: slackApi as any, runAsUser: never });
      await both.execute({
        user: 'U1',
        channel: 'C1',
        threadTs: '171.1',
        text: '$acme-dev2:deploy QA',
        say: vi.fn().mockResolvedValue({}),
      });
      await both.execute({
        user: 'U1',
        channel: 'C1',
        threadTs: '272.2',
        text: '$acme-dev2:deploy QA',
        say: vi.fn().mockResolvedValue({}),
      });
      expect(never).toHaveBeenCalledTimes(2);
    });

    it('A10 — the requester waits on the host until the environment thread holds no entry', async () => {
      h.isAllowed.mockReturnValue(true);
      const runs = new EnvHandoffRuns();
      let freeEnvThread!: () => void;
      const whenFree = vi.fn(
        (_c: string, _t: string) =>
          new Promise<void>((resolve) => {
            freeEnvThread = resolve;
          }),
      );
      const run = vi.fn(async (input: { onOpened?: (ts: string) => void }) => {
        input.onOpened?.('900.1');
        return '900.1';
      });
      const handler2 = new SkillForceHandler(resolveUser, {
        slackApi: slackApi as any,
        runAsUser: run,
        handoffRuns: runs,
        whenFree,
      });
      const say = vi.fn().mockResolvedValue({ ts: '1' });
      const result = await handler2.execute({
        user: 'U1',
        channel: 'C1',
        threadTs: '171.1',
        text: '$acme-dev2:deploy QA',
        say,
      });
      expect(runs.statusFor('C1', '171.1')).toMatchObject({ owner: 'env:acme-dev2' });
      await vi.waitFor(() => expect(whenFree).toHaveBeenCalledWith('C1', '900.1'));
      expect(runs.statusFor('C1', '171.1')?.envThread).toEqual({ channel: 'C1', threadTs: '900.1' });
      let ended = false;
      void result.environmentRun?.finished.then(() => {
        ended = true;
      });
      await new Promise((r) => setImmediate(r));
      expect(ended).toBe(false);
      expect(say.mock.calls.map((c) => String(c[0]?.text ?? '')).some((t) => t.includes('⏹'))).toBe(false);
      freeEnvThread();
      await expect(result.environmentRun?.finished).resolves.toMatchObject({ ok: true, rootTs: '900.1' });
      expect(runs.isRunning('C1', '171.1')).toBe(false);
      expect(say.mock.calls.map((c) => String(c[0]?.text ?? '')).some((t) => t.includes('⏹'))).toBe(true);
    });

    it('a run that failed ends the hand-off too', async () => {
      h.isAllowed.mockReturnValue(true);
      const runs = new EnvHandoffRuns();
      const failing = new SkillForceHandler(resolveUser, {
        slackApi: slackApi as any,
        runAsUser: vi.fn().mockRejectedValue(new Error('scheduler off')),
        handoffRuns: runs,
      });
      const result = await failing.execute({
        user: 'U1',
        channel: 'C1',
        threadTs: '171.1',
        text: '$acme-dev2:deploy QA',
        say: vi.fn().mockResolvedValue({}),
      });
      await expect(result.environmentRun?.finished).resolves.toMatchObject({ ok: false });
      expect(runs.isRunning('C1', '171.1')).toBe(false);
    });
  });
});
