import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gatedManageSkillCopy } from '../user-skill-copy-gate';

const h = vi.hoisted(() => ({
  resolve: vi.fn((t: string) => (t === 'Zhuge' ? 'U0B' : t === 'self' ? 'U0A' : null)),
  allowed: vi.fn((_o: string, _s: string, _r: string) => false),
  consume: vi.fn(() => true),
  copy: vi.fn(() => ({ ok: true, message: 'copied' })),
}));
vi.mock('../slack/commands/user-identity-resolver', () => ({ resolveUserIdentifier: h.resolve }));
vi.mock('../user-skill-grants-store', () => ({ isSkillUseAllowed: h.allowed, consumeOneTimeGrant: h.consume }));
vi.mock('../user-skill-store', () => ({ copyUserSkill: h.copy }));

/**
 * RED tests: MANAGE_SKILL copy must NOT bypass the permission gate (codex
 * blocking finding). A may only copy B's skill when B granted access.
 */
describe('gatedManageSkillCopy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.resolve.mockImplementation((t: string) => (t === 'Zhuge' ? 'U0B' : t === 'self' ? 'U0A' : null));
    h.allowed.mockReturnValue(false);
    h.copy.mockReturnValue({ ok: true, message: 'copied' });
  });

  it('DENIES copy without a grant (no read of the owner skill)', () => {
    h.allowed.mockReturnValue(false);
    const res = gatedManageSkillCopy('U0A', 'Zhuge', 'deploy');
    expect(res.ok).toBe(false);
    expect(h.copy).not.toHaveBeenCalled();
  });

  it('ALLOWS copy when the owner granted access', () => {
    h.allowed.mockReturnValue(true);
    const res = gatedManageSkillCopy('U0A', 'Zhuge', 'deploy');
    expect(res.ok).toBe(true);
    expect(h.copy).toHaveBeenCalledWith('U0B', 'deploy', 'U0A', undefined);
  });

  it('consumes a one-time grant after a successful gated copy', () => {
    h.allowed.mockReturnValue(true);
    gatedManageSkillCopy('U0A', 'Zhuge', 'deploy');
    expect(h.consume).toHaveBeenCalledWith('U0B', 'deploy', 'U0A');
  });

  it('rejects an unresolved source user', () => {
    const res = gatedManageSkillCopy('U0A', 'ghost', 'deploy');
    expect(res.ok).toBe(false);
    expect(h.copy).not.toHaveBeenCalled();
  });

  it('rejects copying your own skill', () => {
    const res = gatedManageSkillCopy('U0A', 'self', 'deploy');
    expect(res.ok).toBe(false);
    expect(h.copy).not.toHaveBeenCalled();
  });
});
