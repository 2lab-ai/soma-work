import * as fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillForceHandler } from '../skill-force-handler';

vi.mock('node:fs');

vi.mock('../../../env-paths', () => ({ PLUGINS_DIR: '/mock/plugins', DATA_DIR: '/mock/data' }));
vi.mock('../../../path-utils', () => ({
  isSafePathSegment: (s: string) => !!s && !s.includes('/') && !s.includes('..'),
}));

// Controllable permission gate + request-store mocks.
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

/**
 * RED tests for the permission gate (Q1/Q2): A using B's skill requires B's
 * grant. Denied → halt + post a permission-request prompt; allowed → inject;
 * one-time grant → consumed only on the success path.
 */
describe('SkillForceHandler — permission gate', () => {
  const mockSay = vi.fn().mockResolvedValue({ ts: '1' });
  const resolveUser = (t: string): string | null => (t === 'Zhuge' ? 'U094' : null);
  const handler = new SkillForceHandler(resolveUser);

  const makeCtx = (text: string, user = 'U1') => ({ user, channel: 'C1', threadTs: '171.1', text, say: mockSay });

  function mountFs(files: Record<string, string>) {
    vi.mocked(fs.existsSync).mockImplementation((p) => String(p) in files);
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      const c = files[String(p)];
      if (c === undefined) throw new Error(`ENOENT ${String(p)}`);
      return c as any;
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    h.isAllowed.mockReturnValue(false);
    h.hasOneTime.mockReturnValue(false);
    h.consumeOneTime.mockReturnValue(true);
    h.createReq.mockImplementation((i: any) => ({ requestId: 'req-1', ...i }));
    mountFs({ '/mock/data/U094/skills/deploy/SKILL.md': '# Zhuge Deploy' });
  });

  it('DENY: cross-user use without a grant does NOT inject and posts a permission request', async () => {
    h.isAllowed.mockReturnValue(false);
    const result = await handler.execute(makeCtx('$Zhuge:deploy', 'U1'));

    expect(result.handled).toBe(true);
    expect(result.continueWithPrompt).toBeUndefined(); // halted — no skill leaked
    // A permission request was created for (owner U094, skill deploy, requester U1).
    expect(h.createReq).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'invoke', ownerId: 'U094', skillName: 'deploy', requesterId: 'U1' }),
    );
    // The prompt was posted with the 3-button block.
    const sayArg = mockSay.mock.calls.find((c) => Array.isArray(c[0].blocks));
    expect(sayArg).toBeTruthy();
    expect(JSON.stringify(sayArg?.[0].blocks)).toContain('skill_perm_');
    // The owner's skill content must NOT appear anywhere.
    expect(JSON.stringify(mockSay.mock.calls)).not.toContain('Zhuge Deploy');
  });

  it('ALLOW: with a grant, the skill injects normally (no permission request)', async () => {
    h.isAllowed.mockReturnValue(true);
    const result = await handler.execute(makeCtx('$Zhuge:deploy', 'U1'));

    expect(result.continueWithPrompt).toContain('# Zhuge Deploy');
    expect(h.createReq).not.toHaveBeenCalled();
  });

  it('ONE-TIME: a one-time grant authorizes the use and is consumed on success', async () => {
    h.isAllowed.mockReturnValue(true);
    h.hasOneTime.mockReturnValue(true);
    const result = await handler.execute(makeCtx('$Zhuge:deploy', 'U1'));

    expect(result.continueWithPrompt).toContain('# Zhuge Deploy');
    expect(h.consumeOneTime).toHaveBeenCalledWith('U094', 'deploy', 'U1');
  });

  it('does NOT gate the requester’s OWN skill (no permission check)', async () => {
    mountFs({ '/mock/data/U1/skills/mine/SKILL.md': '# My Own Skill' });
    const result = await handler.execute(makeCtx('$user:mine', 'U1'));

    expect(result.continueWithPrompt).toContain('# My Own Skill');
    expect(h.isAllowed).not.toHaveBeenCalled();
  });

  it('GATES nested cross-user refs: a denied nested owner ref halts the turn', async () => {
    // U1 runs their OWN skill which references Zhuge's deploy. The nested
    // cross-user read must be permission-checked and, when denied, halt.
    mountFs({
      '/mock/data/U1/skills/mine/SKILL.md': '# Mine\nthen $Zhuge:deploy',
      '/mock/data/U094/skills/deploy/SKILL.md': '# ZHUGE SECRET',
    });
    h.isAllowed.mockReturnValue(false);
    const result = await handler.execute(makeCtx('$user:mine', 'U1'));

    expect(result.continueWithPrompt).toBeUndefined();
    expect(h.createReq).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'U094', skillName: 'deploy' }));
    expect(JSON.stringify(mockSay.mock.calls)).not.toContain('ZHUGE SECRET');
  });
});
