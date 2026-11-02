/**
 * Verification of 99f819c5 (astra P1 ×2): a skill delegation for the auto-mode
 * classifier is trusted only from what the OWNER did — the `$skill` tokens in
 * their own prose and the autoskills they registered. Never from skill bodies
 * or a skill's dependencies.
 */

import { describe, expect, it } from 'vitest';
import { type OwnerSkillDeps, ownerInvokedSkills } from '../owner-skill-invocations';

const OWNER = 'U0OWNER001';

function deps(over: Partial<{ autoskills: string[]; user: string[]; local: string[] }> = {}): OwnerSkillDeps {
  const user = new Set(over.user ?? []);
  const local = new Set(over.local ?? ['autoz', 'using-ssot', 'z']);
  return {
    autoskills: () => over.autoskills ?? [],
    // user → local, the order both the `$skill` handler and autoskill firing use
    resolveKey: (name, owner) =>
      owner && user.has(name) ? `user:${name}` : local.has(name) ? `local:${name}` : undefined,
  };
}

describe('ownerInvokedSkills', () => {
  it('reads the autoskills the owner registered', () => {
    expect(ownerInvokedSkills(OWNER, [], deps({ autoskills: ['using-ssot', 'autoz'] }))).toEqual([
      'local:using-ssot',
      'local:autoz',
    ]);
  });

  it('reads `$autoz` and `$local:autoz` typed by the owner', () => {
    expect(ownerInvokedSkills(OWNER, ['대시보드 개선 $autoz'], deps())).toEqual(['local:autoz']);
    expect(ownerInvokedSkills(OWNER, ['go $local:autoz'], deps())).toEqual(['local:autoz']);
  });

  it("an owner's own skill of the same name wins, as when it ran", () => {
    expect(ownerInvokedSkills(OWNER, ['$autoz'], deps({ user: ['autoz'] }))).toEqual(['user:autoz']);
  });

  it("another user's skill is never local:autoz, whatever its body references", () => {
    const keys = ownerInvokedSkills(OWNER, ['$<@UOTHER001>:notes 해줘', '$someone:notes'], deps());
    expect(keys).not.toContain('local:autoz');
  });

  it('ignores names that do not resolve and dedupes', () => {
    expect(ownerInvokedSkills(OWNER, ['$100 비용 $nope $autoz', '$autoz'], deps({ autoskills: ['autoz'] }))).toEqual([
      'local:autoz',
    ]);
  });

  it('nothing typed, nothing registered → no skills', () => {
    expect(ownerInvokedSkills(OWNER, ['PR 머지해줘'], deps())).toEqual([]);
  });
});
