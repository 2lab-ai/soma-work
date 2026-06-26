/**
 * RED tests for cross-user skill copy (S1, S8).
 *
 * `copyUserSkill(sourceUid, skill, targetUid, targetName?)` installs another
 * user's skill into the caller's own skill set, embedding the ORIGINAL owner
 * via a `copied_from` frontmatter field so owner-relative refs keep resolving
 * to the origin owner (verified at the resolver layer; here we assert the
 * persisted attribution + verbatim body).
 *
 * `env-paths` is mocked so DATA_DIR points at a per-test temp dir.
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

describe('copyUserSkill', () => {
  const owner = 'U0OWNER0001';
  const copier = 'U0COPIER002';
  let store: typeof import('../user-skill-store');
  let fm: typeof import('../user-skill-frontmatter');

  const ownerSkill = [
    '---',
    'name: qa-dev',
    'description: "QA the dev env"',
    '---',
    '',
    'Run `$user:dev` then verify.',
  ].join('\n');

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-skill-copy-'));
    vi.resetModules();
    store = await import('../user-skill-store');
    fm = await import('../user-skill-frontmatter');
    store.createUserSkill(owner, 'qa-dev', ownerSkill);
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('copies another user’s skill into the caller’s skill set', () => {
    const res = store.copyUserSkill(owner, 'qa-dev', copier);
    expect(res.ok).toBe(true);
    expect(store.userSkillExists(copier, 'qa-dev')).toBe(true);
  });

  it('embeds the original owner via copied_from frontmatter', () => {
    store.copyUserSkill(owner, 'qa-dev', copier);
    const detail = store.getUserSkill(copier, 'qa-dev');
    expect(detail).not.toBeNull();
    expect(fm.extractCopiedFrom(detail!.content)).toEqual({ ownerUserId: owner, skillName: 'qa-dev' });
  });

  it('preserves the authored body verbatim (no ref rewrite)', () => {
    store.copyUserSkill(owner, 'qa-dev', copier);
    const detail = store.getUserSkill(copier, 'qa-dev');
    expect(detail!.content).toContain('Run `$user:dev` then verify.');
  });

  it('supports an optional target name', () => {
    const res = store.copyUserSkill(owner, 'qa-dev', copier, 'qa-dev-borrowed');
    expect(res.ok).toBe(true);
    expect(store.userSkillExists(copier, 'qa-dev-borrowed')).toBe(true);
    expect(store.userSkillExists(copier, 'qa-dev')).toBe(false);
  });

  it('keeps the TRUE origin owner when copying an already-copied skill', () => {
    // copier installs the owner’s skill, then a third user copies copier’s copy.
    store.copyUserSkill(owner, 'qa-dev', copier);
    const third = 'U0THIRD0003';
    store.copyUserSkill(copier, 'qa-dev', third);
    const detail = store.getUserSkill(third, 'qa-dev');
    expect(fm.extractCopiedFrom(detail!.content)?.ownerUserId).toBe(owner);
  });

  it('fails when the source skill does not exist', () => {
    const res = store.copyUserSkill(owner, 'does-not-exist', copier);
    expect(res.ok).toBe(false);
  });

  it('fails when the target name already exists', () => {
    store.copyUserSkill(owner, 'qa-dev', copier);
    const again = store.copyUserSkill(owner, 'qa-dev', copier);
    expect(again.ok).toBe(false);
  });
});
