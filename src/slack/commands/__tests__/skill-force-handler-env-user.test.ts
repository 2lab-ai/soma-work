import * as fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { environmentSessionText, SkillForceHandler } from '../skill-force-handler';

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
}));
vi.mock('../../../user-skill-grants-store', () => ({
  isSkillUseAllowed: h.isAllowed,
  hasOneTimeGrant: h.hasOneTime,
  consumeOneTimeGrant: h.consumeOneTime,
  addOneTimeGrant: h.addOneTime,
}));
vi.mock('../../../skill-permission-request-store', () => ({ createPermissionRequest: h.createReq }));
vi.mock('../../../admin-utils', () => ({
  isAdminUser: (u: string) => u === 'UADMIN' || u === 'env:acme-dev2',
  getAdminUsers: () => new Set(['UADMIN']),
}));
vi.mock('../../../env-users', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../env-users')>()),
  isEnvironmentUser: (u: string) => u === 'env:acme-dev2',
}));

/**
 * An environment user's skill (`$acme-dev2:deploy`) runs as the environment user — the way a cron run request
 * already runs as the job owner — never inside the requester's session. Its permission card goes to the admins.
 */
describe('SkillForceHandler — environment user skills', () => {
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
    h.createReq.mockImplementation((i: any) => ({ requestId: 'req-1', ...i }));
    vi.mocked(fs.existsSync).mockImplementation((p) =>
      ['/mock/data/env:acme-dev2/skills/deploy/SKILL.md', '/mock/data/U094/skills/deploy/SKILL.md'].includes(String(p)),
    );
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (String(p) === '/mock/data/env:acme-dev2/skills/deploy/SKILL.md') return '# ENV DEPLOY BODY' as any;
      if (String(p) === '/mock/data/U094/skills/deploy/SKILL.md') return '# Zhuge Deploy' as any;
      throw new Error(`ENOENT ${String(p)}`);
    });
  });

  it('with a grant, runs the request as the environment user in a new thread — nothing reaches the requester', async () => {
    h.isAllowed.mockReturnValue(true);
    const result = await handler.execute(ctx('$acme-dev2:deploy --preflight'));
    await new Promise((r) => setImmediate(r));

    expect(result.handled).toBe(true);
    expect(result.continueWithPrompt).toBeUndefined();
    expect(runAsUser).toHaveBeenCalledWith(expect.objectContaining({ owner: 'env:acme-dev2', channel: 'C1' }));
    const sentText = (runAsUser.mock.calls[0]?.[0] as unknown as { text: string }).text;
    expect(sentText.split('\n')[0]).toBe('$acme-dev2:deploy');
    expect(sentText).toContain('＄acme-dev2:deploy --preflight');
    // The requester's thread is told where it runs; the skill body never shows up there.
    const posted = JSON.stringify(say.mock.calls);
    expect(posted).toContain('env:acme-dev2');
    expect(posted).toContain('https://slack.example/p900');
    expect(posted).not.toContain('ENV DEPLOY BODY');
  });

  it('spends a one-time grant on the hand-off', async () => {
    h.isAllowed.mockReturnValue(true);
    h.hasOneTime.mockReturnValue(true);
    await handler.execute(ctx('$acme-dev2:deploy'));
    expect(h.consumeOneTime).toHaveBeenCalledWith('env:acme-dev2', 'deploy', 'U1');
  });

  it('without a grant, asks the admins by DM with accept · deny · this skill always · whole environment always', async () => {
    const result = await handler.execute(ctx('$acme-dev2:deploy'));

    expect(result).toMatchObject({ handled: true, awaitingPermission: true });
    expect(runAsUser).not.toHaveBeenCalled();
    expect(h.createReq).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'invoke',
        ownerId: 'env:acme-dev2',
        skillName: 'deploy',
        requesterId: 'U1',
      }),
    );
    expect(slackApi.openDmChannel).toHaveBeenCalledWith('UADMIN');
    const card = JSON.stringify(slackApi.postMessage.mock.calls);
    expect(card).toContain('perm_yes_once');
    expect(card).toContain('perm_allow_skill');
    expect(card).toContain('perm_allow_all');
    expect(card).toContain('perm_deny');
    expect(card).toContain('acme-dev2 전체 항상');
    // The admin sees what will run.
    expect(card).toContain('$acme-dev2:deploy');
    expect(card).not.toContain('ENV DEPLOY BODY');
  });

  it("the environment user's own session runs its skill like any owner (no hand-off loop)", async () => {
    const result = await handler.execute(ctx('$acme-dev2:deploy', 'env:acme-dev2'));
    expect(runAsUser).not.toHaveBeenCalled();
    expect(result.continueWithPrompt).toContain('# ENV DEPLOY BODY');
  });

  it("refuses to mix an environment user's skill with other skills in one message", async () => {
    h.isAllowed.mockReturnValue(true);
    const result = await handler.execute(ctx('$acme-dev2:deploy $Zhuge:deploy'));
    expect(result.handled).toBe(true);
    expect(result.continueWithPrompt).toBeUndefined();
    expect(runAsUser).not.toHaveBeenCalled();
    expect(JSON.stringify(say.mock.calls)).toContain('단독');
  });

  it("another user's skill still runs in the requester's session", async () => {
    h.isAllowed.mockReturnValue(true);
    const result = await handler.execute(ctx('$Zhuge:deploy'));
    expect(runAsUser).not.toHaveBeenCalled();
    expect(result.continueWithPrompt).toContain('# Zhuge Deploy');
  });

  it('the environment session gets the skill call, and the requester words only as quoted data with $ neutralised', () => {
    const refs = [{ skill: 'deploy' }];
    const out = environmentSessionText('env:acme-dev2', refs, 'U1', '$acme-dev2:deploy $foo --preflight ```x');
    expect(out.split('\n')[0]).toBe('$acme-dev2:deploy');
    // No skill reference in the requester's words resolves again as the environment user.
    expect(out.slice(out.indexOf('\n'))).not.toContain('$');
    expect(out).toContain('＄foo --preflight');
    // The quote cannot be closed early.
    expect(out.match(/```/g)?.length).toBe(2);
  });

  it('hands the environment session a text that starts with the skill call', async () => {
    h.isAllowed.mockReturnValue(true);
    await handler.execute(ctx('배포해줘 $acme-dev2:deploy'));
    const sent = (runAsUser.mock.calls[0]?.[0] as unknown as { text: string }).text;
    expect(sent.startsWith('$acme-dev2:deploy')).toBe(true);
  });

  it('a skill the environment user does not have ends as not found, with no new thread', async () => {
    h.isAllowed.mockReturnValue(true);
    const result = await handler.execute(ctx('$acme-dev2:nope'));
    expect(runAsUser).not.toHaveBeenCalled();
    expect(result.continueWithPrompt).toBeUndefined();
    expect(JSON.stringify(say.mock.calls)).toContain('스킬을 찾을 수 없습니다');
  });

  it('a repeated request with the same words in the same thread is not sent to the admins again', async () => {
    h.createReq.mockImplementation((i: any) => ({ requestId: 'req-old', ...i, reused: true }));
    const result = await handler.execute(ctx('$acme-dev2:deploy'));
    expect(result).toMatchObject({ handled: true, awaitingPermission: true });
    expect(slackApi.openDmChannel).not.toHaveBeenCalled();
    expect(JSON.stringify(say.mock.calls)).toContain('이미 어드민 승인 대기');
  });

  it('the card shows the stored text — the words that run on approval', async () => {
    h.createReq.mockImplementation((i: any) => ({ requestId: 'req-1', ...i, originalText: 'STORED WORDS' }));
    await handler.execute(ctx('$acme-dev2:deploy shown-now'));
    const card = JSON.stringify(slackApi.postMessage.mock.calls);
    expect(card).toContain('STORED WORDS');
    expect(card).not.toContain('shown-now');
  });

  it('a request longer than the card can show is refused — no card, no run', async () => {
    const long = `$acme-dev2:deploy ${'x'.repeat(2100)}`;
    await handler.execute(ctx(long));
    h.isAllowed.mockReturnValue(true);
    await handler.execute(ctx(long));
    expect(slackApi.openDmChannel).not.toHaveBeenCalled();
    expect(runAsUser).not.toHaveBeenCalled();
    expect(JSON.stringify(say.mock.calls)).toContain('2000자까지');
  });

  it('an environment skill nested inside another skill is refused, so its body never reaches the requester', async () => {
    h.isAllowed.mockReturnValue(true);
    vi.mocked(fs.existsSync).mockImplementation((p) =>
      ['/mock/data/env:acme-dev2/skills/deploy/SKILL.md', '/mock/data/U094/skills/wrap/SKILL.md'].includes(String(p)),
    );
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (String(p) === '/mock/data/env:acme-dev2/skills/deploy/SKILL.md') return '# ENV DEPLOY BODY' as any;
      if (String(p) === '/mock/data/U094/skills/wrap/SKILL.md') return 'wrapper: $acme-dev2:deploy' as any;
      throw new Error(`ENOENT ${String(p)}`);
    });
    const result = await handler.execute(ctx('$Zhuge:wrap'));
    expect(runAsUser).not.toHaveBeenCalled();
    expect(String(result.continueWithPrompt ?? '')).not.toContain('ENV DEPLOY BODY');
    expect(slackApi.openDmChannel).not.toHaveBeenCalled();
  });

  it('a failing Slack post after the hand-off never becomes an unhandled rejection', async () => {
    h.isAllowed.mockReturnValue(true);
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      let calls = 0;
      const failingSay = vi.fn(async () => {
        calls++;
        if (calls > 0) throw new Error('channel_is_archived');
        return { ts: '1' };
      });
      const failingRun = vi.fn(async () => {
        throw new Error('scheduler down');
      });
      const h2 = new SkillForceHandler(resolveUser, { slackApi: slackApi as any, runAsUser: failingRun });
      await h2.execute({ ...ctx('$acme-dev2:deploy'), say: failingSay } as any);
      await new Promise((r) => setTimeout(r, 20));
      expect(failingRun).toHaveBeenCalled();
      expect(rejections).toEqual([]);
      // The run never started: nothing was spent for good (no one-time grant was held here).
      expect(h.addOneTime).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it("the environment skill's own dependencies are left to the environment session — the requester is not asked for them", async () => {
    h.isAllowed.mockImplementation((owner: string) => owner === 'env:acme-dev2');
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (String(p) === '/mock/data/env:acme-dev2/skills/deploy/SKILL.md') return 'uses $Zhuge:deploy' as any;
      throw new Error(`ENOENT ${String(p)}`);
    });
    const result = await handler.execute(ctx('$acme-dev2:deploy'));
    expect(result).not.toMatchObject({ awaitingPermission: true });
    expect(h.createReq).not.toHaveBeenCalled();
    expect(runAsUser).toHaveBeenCalledTimes(1);
    // The body was not even read on the requester's side.
    expect(vi.mocked(fs.readFileSync).mock.calls.map((c) => String(c[0]))).not.toContain(
      '/mock/data/env:acme-dev2/skills/deploy/SKILL.md',
    );
  });

  it('a one-time grant is claimed before the run: a second hand-off that finds it spent does not run', async () => {
    h.hasOneTime.mockReturnValue(true);
    // Allowed while resolving (the grant was there), not any more once the other hand-off spent it.
    h.isAllowed.mockReturnValueOnce(true).mockReturnValue(false);
    h.consumeOneTime.mockReturnValue(false);
    const result = await handler.execute(ctx('$acme-dev2:deploy'));
    expect(result.handled).toBe(true);
    expect(runAsUser).not.toHaveBeenCalled();
    expect(JSON.stringify(say.mock.calls)).toContain('이미 사용');
  });

  it('a claimed one-time grant is given back when the run never starts', async () => {
    h.isAllowed.mockReturnValue(true);
    h.hasOneTime.mockReturnValue(true);
    h.consumeOneTime.mockReturnValue(true);
    const neverStarts = vi.fn(async () => {
      throw new Error('scheduler down');
    });
    const h3 = new SkillForceHandler(resolveUser, { slackApi: slackApi as any, runAsUser: neverStarts });
    await h3.execute(ctx('$acme-dev2:deploy'));
    await new Promise((r) => setTimeout(r, 10));
    expect(h.consumeOneTime).toHaveBeenCalledWith('env:acme-dev2', 'deploy', 'U1');
    expect(h.addOneTime).toHaveBeenCalledWith('env:acme-dev2', 'deploy', 'U1');
  });
});
