import * as fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillForceHandler } from '../skill-force-handler';

vi.mock('node:fs');

vi.mock('../../../env-paths', () => ({ PLUGINS_DIR: '/mock/plugins', DATA_DIR: '/mock/data' }));
vi.mock('../../../path-utils', () => ({
  isSafePathSegment: (s: string) => !!s && !s.includes('/') && !s.includes('..'),
}));

const h = vi.hoisted(() => ({
  envAllowed: vi.fn((_key: string, _requester: string, _scope?: unknown) => false),
  isAdmin: vi.fn((_u: string) => false),
  requestEnv: vi.fn(async (_input: any) => ({ requestId: 'env-req-1', delivered: 'dm' as const })),
}));
vi.mock('../../../user-skill-grants-store', () => ({
  isSkillUseAllowed: () => true,
  hasOneTimeGrant: () => false,
  consumeOneTimeGrant: () => true,
  isEnvSkillUseAllowed: h.envAllowed,
}));
vi.mock('../../../admin-utils', () => ({ isAdminUser: h.isAdmin }));
vi.mock('../../env-skill-permission-request', () => ({
  requestEnvSkillPermission: h.requestEnv,
  describeEnvSkillDelivery: (d: string, k: string) => `notice:${d}:${k}`,
}));

/**
 * The environment-skill gate of `$plugin:skill`: a skill of a deploy-time environment plugin runs
 * for a non-admin only on an admin's grant. Denied → the turn halts (nothing of the skill leaks)
 * and the admins are asked; admin or granted → the skill injects as before.
 */
describe('SkillForceHandler — environment-skill gate', () => {
  const mockSay = vi.fn().mockResolvedValue({ ts: '1' });
  const slackApi = { postMessage: vi.fn(), openDmChannel: vi.fn() } as any;
  const mcpManager = { getPluginManager: () => ({ getEnvPluginNames: () => new Set(['acme-env']) }) } as any;
  const handler = new SkillForceHandler(() => null, { slackApi, mcpManager });

  const makeCtx = (text: string, user = 'U1') => ({ user, channel: 'C1', threadTs: '171.1', text, say: mockSay });

  function mountFs(files: Record<string, string>) {
    vi.mocked(fs.existsSync).mockImplementation((p) => String(p) in files || String(p) === '/mock/plugins/acme-env');
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      const c = files[String(p)];
      if (c === undefined) throw new Error(`ENOENT ${String(p)}`);
      return c as any;
    });
    vi.mocked(fs.readdirSync).mockImplementation(
      () =>
        [
          { name: 'acme-env', isDirectory: () => true },
          { name: 'stv', isDirectory: () => true },
        ] as any,
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    h.envAllowed.mockReturnValue(false);
    h.isAdmin.mockReturnValue(false);
    mountFs({
      '/mock/plugins/acme-env/skills/post-deploy/SKILL.md':
        '# ACME post-deploy\nUse `$acme-env:staging-qa` for values.',
      '/mock/plugins/acme-env/skills/staging-qa/SKILL.md': '# ACME staging profile SECRET-ISH VALUES',
      '/mock/plugins/stv/skills/new-task/SKILL.md': '# stv new-task\nthen `$acme-env:staging-qa`',
    });
  });

  it('DENY: a non-admin without a grant halts and asks the admins, leaking nothing', async () => {
    const text = '$acme-env:post-deploy --preflight repo=acme/app target=deploy/staging';
    const result = await handler.execute(makeCtx(text));

    expect(result).toEqual({ handled: true, awaitingPermission: true });
    expect(h.requestEnv).toHaveBeenCalledTimes(1);
    expect(h.requestEnv).toHaveBeenCalledWith({
      slackApi,
      requesterId: 'U1',
      skillKey: 'acme-env:post-deploy',
      channel: 'C1',
      threadTs: '171.1',
      originalText: text,
    });
    expect(h.envAllowed).toHaveBeenCalledWith(
      'acme-env:post-deploy',
      'U1',
      expect.objectContaining({ channel: 'C1', threadTs: '171.1' }),
    );
    expect(JSON.stringify(mockSay.mock.calls)).not.toContain('ACME post-deploy');
  });

  it('ALLOW: an admin runs the environment skill without asking (nested environment refs too)', async () => {
    h.isAdmin.mockReturnValue(true);
    const result = await handler.execute(makeCtx('$acme-env:post-deploy'));

    expect(result.continueWithPrompt).toContain('# ACME post-deploy');
    expect(result.continueWithPrompt).toContain('# ACME staging profile');
    expect(h.requestEnv).not.toHaveBeenCalled();
    expect(h.envAllowed).not.toHaveBeenCalled();
  });

  it('ALLOW: a granted requester runs it (the grant check sees the asking thread)', async () => {
    h.envAllowed.mockReturnValue(true);
    const result = await handler.execute(makeCtx('$acme-env:post-deploy'));

    expect(result.continueWithPrompt).toContain('# ACME post-deploy');
    expect(h.requestEnv).not.toHaveBeenCalled();
  });

  it('DENY at depth: a granted top-level skill that nests an ungranted environment skill still halts', async () => {
    h.envAllowed.mockImplementation((key: string) => key === 'acme-env:post-deploy');
    const result = await handler.execute(makeCtx('$acme-env:post-deploy'));

    expect(result.awaitingPermission).toBe(true);
    expect(h.requestEnv).toHaveBeenCalledWith(expect.objectContaining({ skillKey: 'acme-env:staging-qa' }));
    expect(result.continueWithPrompt).toBeUndefined();
  });

  it('DENY via a non-environment skill: a plain plugin skill nesting an environment skill halts too', async () => {
    const result = await handler.execute(makeCtx('$stv:new-task'));

    expect(result.awaitingPermission).toBe(true);
    expect(h.requestEnv).toHaveBeenCalledWith(expect.objectContaining({ skillKey: 'acme-env:staging-qa' }));
  });

  it('DENY via bare $skill: the fallback scan resolving to an environment plugin is gated', async () => {
    const result = await handler.execute(makeCtx('$post-deploy'));

    expect(result.awaitingPermission).toBe(true);
    expect(h.requestEnv).toHaveBeenCalledWith(expect.objectContaining({ skillKey: 'acme-env:post-deploy' }));
  });

  it('asks once per environment skill even when it is referenced twice', async () => {
    const result = await handler.execute(makeCtx('$acme-env:staging-qa and again $acme-env:staging-qa'));

    expect(result.awaitingPermission).toBe(true);
    expect(h.requestEnv).toHaveBeenCalledTimes(1);
  });

  it('a host without environment plugins gates nothing', async () => {
    const plain = new SkillForceHandler(() => null, {
      slackApi,
      mcpManager: { getPluginManager: () => ({ getEnvPluginNames: () => new Set<string>() }) } as any,
    });
    const result = await plain.execute(makeCtx('$acme-env:post-deploy'));

    expect(result.continueWithPrompt).toContain('# ACME post-deploy');
    expect(h.requestEnv).not.toHaveBeenCalled();
  });

  it('without a Slack API it still tells the requester why the turn stopped', async () => {
    const noSlack = new SkillForceHandler(() => null, { mcpManager });
    const result = await noSlack.execute(makeCtx('$acme-env:post-deploy'));

    expect(result.awaitingPermission).toBe(true);
    expect(mockSay).toHaveBeenCalledWith(expect.objectContaining({ text: 'notice:none:acme-env:post-deploy' }));
  });
});
