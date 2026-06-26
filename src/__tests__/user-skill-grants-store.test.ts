/**
 * RED tests for the cross-user skill PERMISSION grants store.
 *
 * A user (B, the owner) grants another user (A, the requester) permission to
 * use B's personal skills. Three tiers:
 *   - one-time   (transient, in-memory, single-use, consumed at fulfillment)
 *   - per-skill  (persisted: A may use B's skill X)
 *   - all-skills (persisted: A may use any of B's skills)
 *
 * `isSkillUseAllowed` MUST be non-mutating (codex review): one-time grants are
 * consumed only via `consumeOneTimeGrant` at the actual fulfillment, never by a
 * probe/check.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempDir: string;

vi.mock('../env-paths', () => ({
  get DATA_DIR() {
    return tempDir;
  },
  IS_DEV: true,
}));

vi.mock('../logger', () => ({
  Logger: class {
    debug() {}
    info() {}
    warn() {}
    error() {}
  },
}));

describe('user-skill-grants-store', () => {
  const owner = 'U0OWNER0001';
  const requester = 'U0REQ00002';
  let store: typeof import('../user-skill-grants-store');

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-grants-'));
    vi.resetModules();
    store = await import('../user-skill-grants-store');
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('owner is always allowed to use their own skill', () => {
    expect(store.isSkillUseAllowed(owner, 'deploy', owner)).toBe(true);
  });

  it('denies a requester with no grant', () => {
    expect(store.isSkillUseAllowed(owner, 'deploy', requester)).toBe(false);
  });

  it('per-skill grant allows exactly that skill, not others', () => {
    store.grantSkill(owner, 'deploy', requester);
    expect(store.isSkillUseAllowed(owner, 'deploy', requester)).toBe(true);
    expect(store.isSkillUseAllowed(owner, 'qa', requester)).toBe(false);
  });

  it('all-skills grant allows any skill', () => {
    store.grantAllSkills(owner, requester);
    expect(store.isSkillUseAllowed(owner, 'deploy', requester)).toBe(true);
    expect(store.isSkillUseAllowed(owner, 'anything-else', requester)).toBe(true);
  });

  it('grants persist to disk and survive a fresh module load', async () => {
    store.grantSkill(owner, 'deploy', requester);
    vi.resetModules();
    const reloaded = await import('../user-skill-grants-store');
    expect(reloaded.isSkillUseAllowed(owner, 'deploy', requester)).toBe(true);
  });

  it('grants are idempotent (no duplicate requester entries)', () => {
    store.grantSkill(owner, 'deploy', requester);
    store.grantSkill(owner, 'deploy', requester);
    const grants = store.loadGrants(owner);
    expect(grants.perSkill.deploy).toEqual([requester]);
  });

  describe('one-time grants', () => {
    it('isSkillUseAllowed sees a one-time grant WITHOUT consuming it (non-mutating)', () => {
      store.addOneTimeGrant(owner, 'deploy', requester);
      expect(store.isSkillUseAllowed(owner, 'deploy', requester)).toBe(true);
      // A second check still passes — the check did not consume it.
      expect(store.isSkillUseAllowed(owner, 'deploy', requester)).toBe(true);
    });

    it('consumeOneTimeGrant removes the grant (strict single-use)', () => {
      store.addOneTimeGrant(owner, 'deploy', requester);
      expect(store.consumeOneTimeGrant(owner, 'deploy', requester)).toBe(true);
      // Now gone — no persisted grant remains.
      expect(store.isSkillUseAllowed(owner, 'deploy', requester)).toBe(false);
      // Consuming again returns false (nothing to consume).
      expect(store.consumeOneTimeGrant(owner, 'deploy', requester)).toBe(false);
    });

    it('one-time grant is scoped to the exact (owner, skill, requester)', () => {
      store.addOneTimeGrant(owner, 'deploy', requester);
      expect(store.isSkillUseAllowed(owner, 'qa', requester)).toBe(false);
      expect(store.isSkillUseAllowed(owner, 'deploy', 'U0OTHER')).toBe(false);
    });

    it('an expired one-time grant is not honored', () => {
      store.addOneTimeGrant(owner, 'deploy', requester, Date.now() - 1000);
      expect(store.isSkillUseAllowed(owner, 'deploy', requester)).toBe(false);
    });
  });
});
