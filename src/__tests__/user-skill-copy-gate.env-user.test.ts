import { describe, expect, it, vi } from 'vitest';

vi.mock('../slack/commands/user-identity-resolver', () => ({
  resolveUserIdentifier: (t: string) => (t === 'acme-dev2' ? 'env:acme-dev2' : null),
}));
vi.mock('../env-users', () => ({ isEnvironmentUser: (u: string) => u === 'env:acme-dev2' }));
const copy = vi.hoisted(() => vi.fn(() => ({ ok: true, message: 'copied' })));
vi.mock('../user-skill-store', () => ({ copyUserSkill: copy }));
vi.mock('../user-skill-grants-store', () => ({ isSkillUseAllowed: () => true, consumeOneTimeGrant: vi.fn() }));

import { gatedManageSkillCopy } from '../user-skill-copy-gate';

describe('gatedManageSkillCopy — environment user', () => {
  it("never copies an environment user's skill, even with a grant", () => {
    const result = gatedManageSkillCopy('U1', 'acme-dev2', 'deploy');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('환경 유저');
    expect(copy).not.toHaveBeenCalled();
  });
});
