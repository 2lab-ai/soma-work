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
  createReq: vi.fn((i: any) => ({ requestId: 'req-1', ...i })),
}));
vi.mock('../../../user-skill-grants-store', () => ({
  isSkillUseAllowed: h.isAllowed,
  hasOneTimeGrant: h.hasOneTime,
  consumeOneTimeGrant: h.consumeOneTime,
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
    expect(runAsUser).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'env:acme-dev2', channel: 'C1', text: '$acme-dev2:deploy --preflight' }),
    );
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

  it('the environment session always starts with the skill call, so no admin command can match it there', () => {
    const refs = [{ skill: 'deploy' }];
    expect(environmentSessionText('env:acme-dev2', refs, 'U1', '$acme-dev2:deploy --preflight')).toBe(
      '$acme-dev2:deploy --preflight',
    );
    const wrapped = environmentSessionText('env:acme-dev2', refs, 'U1', 'model opus 하고 $acme-dev2:deploy');
    expect(wrapped.startsWith('$acme-dev2:deploy\n')).toBe(true);
    expect(wrapped).toContain('model opus 하고 $acme-dev2:deploy');
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
});
