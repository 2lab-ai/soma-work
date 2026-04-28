/**
 * Tests for the in-process user-skill store.
 *
 * `env-paths` is mocked so DATA_DIR points at a per-test temp dir, and Logger
 * is silenced. Coverage:
 *   - shareUserSkill: happy / invalid name / not found (round-trip with
 *     dispatcher contract — see `somalib/model-commands/catalog.test.ts` for
 *     the 2500-char cap).
 *   - createUserSkill / updateUserSkill: verbatim persistence, name-length
 *     cap (create-only), and the validate-vs-store split (issue #750).
 *   - isSingleFileSkill: single-file detection, multi-file rejection,
 *     missing-skill / invalid-name fail-closed.
 *   - computeContentHash: stable 32-hex output that detects tiny diffs.
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

describe('user-skill-store', () => {
  const userId = 'U-test-share';
  let store: typeof import('../user-skill-store');
  let errors: typeof import('somalib/model-commands/skill-share-errors');

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-skill-test-'));
    vi.resetModules();
    store = await import('../user-skill-store');
    errors = await import('somalib/model-commands/skill-share-errors');
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  describe('shareUserSkill', () => {
    it('returns ok=true with persisted content when a valid skill exists', () => {
      const skillName = 'my-deploy';
      const content = [
        '---',
        'name: my-deploy',
        'description: Deploy the thing',
        '---',
        '',
        'Body of the skill goes here.',
      ].join('\n');
      const create = store.createUserSkill(userId, skillName, content);
      expect(create.ok).toBe(true);

      const result = store.shareUserSkill(userId, skillName);

      expect(result.ok).toBe(true);
      // createUserSkill persists content verbatim (issue #750), so the
      // round-trip MUST be byte-identical.
      expect(result.content).toBe(content);
      expect(result.message).toContain('my-deploy');
    });

    it('returns ok=false with invalidSkillNameMessage when the name violates kebab-case', () => {
      const badName = 'Bad_Name';

      const result = store.shareUserSkill(userId, badName);

      expect(result.ok).toBe(false);
      expect(result.content).toBeUndefined();
      expect(result.message).toBe(errors.invalidSkillNameMessage(badName));
    });

    it('returns ok=false with skillNotFoundMessage when a valid name has no SKILL.md', () => {
      const skillName = 'never-created';

      const result = store.shareUserSkill(userId, skillName);

      expect(result.ok).toBe(false);
      expect(result.content).toBeUndefined();
      expect(result.message).toBe(errors.skillNotFoundMessage(skillName));
    });
  });

  describe('listUserSkills', () => {
    it('returns each skill with isSingleFile=true when the dir has only SKILL.md', () => {
      store.createUserSkill(userId, 'a', '---\nname: a\n---\nbody');
      const list = store.listUserSkills(userId);
      expect(list).toHaveLength(1);
      expect(list[0].isSingleFile).toBe(true);
    });

    it('returns isSingleFile=false when the dir has a sibling file', () => {
      store.createUserSkill(userId, 'a', '---\nname: a\n---\nbody');
      const skillDir = path.join(tempDir, userId, 'skills', 'a');
      fs.writeFileSync(path.join(skillDir, 'reference.md'), 'extra', 'utf-8');
      const list = store.listUserSkills(userId);
      expect(list[0].isSingleFile).toBe(false);
    });
  });

  describe('userSkillExists', () => {
    it('returns true for a present skill', () => {
      store.createUserSkill(userId, 'a', '---\nname: a\n---\nbody');
      expect(store.userSkillExists(userId, 'a')).toBe(true);
    });

    it('returns false for a missing skill', () => {
      expect(store.userSkillExists(userId, 'never-created')).toBe(false);
    });

    it('returns false for an invalid skill name (no fs check needed)', () => {
      expect(store.userSkillExists(userId, '../etc/passwd')).toBe(false);
      expect(store.userSkillExists(userId, 'Bad_Name')).toBe(false);
    });
  });

  describe('isValidSkillName', () => {
    it('accepts kebab-case names', () => {
      expect(store.isValidSkillName('my-skill')).toBe(true);
      expect(store.isValidSkillName('a')).toBe(true);
      expect(store.isValidSkillName('skill-1')).toBe(true);
    });

    it('rejects names that violate kebab-case', () => {
      expect(store.isValidSkillName('Bad_Name')).toBe(false);
      expect(store.isValidSkillName('UPPERCASE')).toBe(false);
      expect(store.isValidSkillName('-leading-hyphen')).toBe(false);
    });

    it('rejects path-traversal payloads (defense in depth)', () => {
      expect(store.isValidSkillName('..')).toBe(false);
      expect(store.isValidSkillName('a/b')).toBe(false);
      expect(store.isValidSkillName('')).toBe(false);
    });
  });

  describe('createUserSkill / updateUserSkill verbatim persistence', () => {
    it('createUserSkill writes the original bytes (preserves trailing newline)', () => {
      const content = '---\nname: a\ndescription: x\n---\n\nbody\n\n\n';
      const result = store.createUserSkill(userId, 'a', content);
      expect(result.ok).toBe(true);

      const detail = store.getUserSkill(userId, 'a');
      expect(detail?.content).toBe(content);
    });

    it('updateUserSkill writes the original bytes (preserves trailing newline)', () => {
      const initial = '---\nname: a\ndescription: x\n---\n\noriginal';
      store.createUserSkill(userId, 'a', initial);
      const next = '---\nname: a\ndescription: x\n---\n\nupdated\n\n';
      const result = store.updateUserSkill(userId, 'a', next);
      expect(result.ok).toBe(true);
      const detail = store.getUserSkill(userId, 'a');
      expect(detail?.content).toBe(next);
    });

    it('createUserSkill rejects names longer than MAX_SKILL_NAME_LENGTH', () => {
      const longName = `a${'b'.repeat(store.MAX_SKILL_NAME_LENGTH)}`; // 1 + cap
      const result = store.createUserSkill(userId, longName, 'body');
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/too long/i);
    });

    it('createUserSkill accepts names exactly at MAX_SKILL_NAME_LENGTH', () => {
      // pattern is `[a-z0-9][a-z0-9-]*` — all lowercase alpha is fine.
      const exactly = 'a'.repeat(store.MAX_SKILL_NAME_LENGTH);
      const result = store.createUserSkill(userId, exactly, 'body');
      expect(result.ok).toBe(true);
    });

    it('updateUserSkill does NOT enforce the name-length cap on existing skills', () => {
      // Manually plant a SKILL.md whose dirname exceeds the cap so we can
      // verify update is forgiving toward legacy names.
      const longName = 'a'.repeat(store.MAX_SKILL_NAME_LENGTH + 8);
      const skillDir = path.join(tempDir, userId, 'skills', longName);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'old', 'utf-8');

      const result = store.updateUserSkill(userId, longName, 'new content');
      expect(result.ok).toBe(true);
    });

    it('createUserSkill rejects empty content (post-trim)', () => {
      const result = store.createUserSkill(userId, 'a', '   \n  \n');
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/empty/i);
    });

    it('updateUserSkill rejects empty content (post-trim)', () => {
      store.createUserSkill(userId, 'a', '---\nname: a\n---\nbody');
      const result = store.updateUserSkill(userId, 'a', '\n   \n');
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/empty/i);
    });
  });

  describe('isSingleFileSkill', () => {
    it('returns true when the dir contains exactly SKILL.md', () => {
      store.createUserSkill(userId, 'a', '---\nname: a\n---\nbody');
      expect(store.isSingleFileSkill(userId, 'a')).toBe(true);
    });

    it('returns false when a sibling file is present', () => {
      store.createUserSkill(userId, 'a', '---\nname: a\n---\nbody');
      const skillDir = path.join(tempDir, userId, 'skills', 'a');
      fs.writeFileSync(path.join(skillDir, 'reference.md'), 'extra', 'utf-8');
      expect(store.isSingleFileSkill(userId, 'a')).toBe(false);
    });

    it('returns false when a sub-directory is present (resources/ etc.)', () => {
      store.createUserSkill(userId, 'a', '---\nname: a\n---\nbody');
      const skillDir = path.join(tempDir, userId, 'skills', 'a');
      fs.mkdirSync(path.join(skillDir, 'resources'));
      expect(store.isSingleFileSkill(userId, 'a')).toBe(false);
    });

    it('returns false when SKILL.md is missing entirely', () => {
      const skillDir = path.join(tempDir, userId, 'skills', 'a');
      fs.mkdirSync(skillDir, { recursive: true });
      // No SKILL.md, only a stray file.
      fs.writeFileSync(path.join(skillDir, 'README.md'), 'x', 'utf-8');
      expect(store.isSingleFileSkill(userId, 'a')).toBe(false);
    });

    it('returns false when the skill directory does not exist', () => {
      expect(store.isSingleFileSkill(userId, 'never-created')).toBe(false);
    });

    it('returns false for invalid skill names (defense)', () => {
      expect(store.isSingleFileSkill(userId, '../etc')).toBe(false);
      expect(store.isSingleFileSkill(userId, 'Bad_Name')).toBe(false);
    });
  });

  describe('computeContentHash', () => {
    it('returns a stable 32-hex string for identical input', () => {
      const a = store.computeContentHash('hello world');
      const b = store.computeContentHash('hello world');
      expect(a).toBe(b);
      expect(a).toMatch(/^[0-9a-f]{32}$/);
    });

    it('returns a different hash for a tiny diff', () => {
      const a = store.computeContentHash('hello world');
      const b = store.computeContentHash('hello world\n');
      expect(a).not.toBe(b);
    });
  });

  // -------------------------------------------------------------------------
  // renameUserSkill (issue #774)
  // -------------------------------------------------------------------------
  //
  // Storage-layer contract:
  //   - happy:        valid src + valid dst → ok=true, byte-identical SKILL.md
  //   - same name:    src === dst         → ok=false, error='INVALID'
  //   - source gone:  no source dir       → ok=false, error='NOT_FOUND'
  //   - target taken: dst exists          → ok=false, error='EEXIST'
  //   - bad name:     pattern violation   → ok=false, error='INVALID'
  //   - length cap:   newName too long    → ok=false, error='INVALID'
  //   - case-only:    foo → foo-2         → ok=true (temp staging path exercised)
  //
  // The 32-byte path-segment safety predicate (`isSafePathSegment`) is shared
  // with the existing validator — we don't re-test traversal here because the
  // `isValidSkillName` test class above already covers it.
  describe('renameUserSkill', () => {
    function srcContent(): string {
      return ['---', 'name: old', 'description: ye olde', '---', '', 'body'].join('\n');
    }

    it('renames an existing skill — source dir disappears, target dir contains identical bytes', () => {
      const content = srcContent();
      store.createUserSkill(userId, 'old', content);

      const result = store.renameUserSkill(userId, 'old', 'new-name');

      expect(result.ok).toBe(true);
      expect(result.error).toBeUndefined();
      expect(fs.existsSync(path.join(tempDir, userId, 'skills', 'old'))).toBe(false);
      const dst = path.join(tempDir, userId, 'skills', 'new-name', 'SKILL.md');
      expect(fs.existsSync(dst)).toBe(true);
      expect(fs.readFileSync(dst, 'utf-8')).toBe(content);
    });

    it('returns INVALID when oldName === newName', () => {
      store.createUserSkill(userId, 'same', srcContent());

      const result = store.renameUserSkill(userId, 'same', 'same');

      expect(result.ok).toBe(false);
      expect(result.error).toBe('INVALID');
    });

    it('returns NOT_FOUND when source skill does not exist', () => {
      const result = store.renameUserSkill(userId, 'missing', 'new-name');
      expect(result.ok).toBe(false);
      expect(result.error).toBe('NOT_FOUND');
    });

    it('returns EEXIST when target name is already taken (no rollback needed)', () => {
      store.createUserSkill(userId, 'src', srcContent());
      store.createUserSkill(userId, 'dst', srcContent().replace('old', 'dst'));

      const result = store.renameUserSkill(userId, 'src', 'dst');

      expect(result.ok).toBe(false);
      expect(result.error).toBe('EEXIST');
      // Both dirs survive — the rename never touched disk.
      expect(fs.existsSync(path.join(tempDir, userId, 'skills', 'src'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, userId, 'skills', 'dst'))).toBe(true);
    });

    it('returns INVALID for a kebab-case-violating new name', () => {
      store.createUserSkill(userId, 'src', srcContent());
      const result = store.renameUserSkill(userId, 'src', 'Bad_Name');
      expect(result.ok).toBe(false);
      expect(result.error).toBe('INVALID');
    });

    it('returns INVALID for a too-long new name', () => {
      store.createUserSkill(userId, 'src', srcContent());
      const tooLong = 'a'.repeat(store.MAX_SKILL_NAME_LENGTH + 1);
      const result = store.renameUserSkill(userId, 'src', tooLong);
      expect(result.ok).toBe(false);
      expect(result.error).toBe('INVALID');
    });

    it('handles a case-only-style rename through a temp staging directory', () => {
      // Use a distinct case-only target to exercise the temp-staging path. On
      // case-insensitive filesystems plain fs.rename(src, dst) is a no-op when
      // src.toLowerCase() === dst.toLowerCase(); staging through a uuid-suffixed
      // temp dir makes the rename real. We can't lowercase-only here because
      // the kebab-case predicate rejects uppercase, so we use `foo` → `foo-2`.
      store.createUserSkill(userId, 'foo', srcContent());
      const result = store.renameUserSkill(userId, 'foo', 'foo-2');
      expect(result.ok).toBe(true);
      expect(fs.existsSync(path.join(tempDir, userId, 'skills', 'foo'))).toBe(false);
      expect(fs.existsSync(path.join(tempDir, userId, 'skills', 'foo-2', 'SKILL.md'))).toBe(true);
    });

    it('preserves multi-file siblings (non-SKILL.md files) through the rename', () => {
      // Issue #774 spec: "rename은 디렉터리 통째로" — multi-file skills must
      // keep their sibling resources after a rename.
      store.createUserSkill(userId, 'multi', srcContent());
      const skillDir = path.join(tempDir, userId, 'skills', 'multi');
      fs.writeFileSync(path.join(skillDir, 'reference.md'), 'sibling content', 'utf-8');

      const result = store.renameUserSkill(userId, 'multi', 'renamed');

      expect(result.ok).toBe(true);
      const newDir = path.join(tempDir, userId, 'skills', 'renamed');
      expect(fs.existsSync(path.join(newDir, 'SKILL.md'))).toBe(true);
      expect(fs.readFileSync(path.join(newDir, 'reference.md'), 'utf-8')).toBe('sibling content');
    });
  });

  // -------------------------------------------------------------------------
  // Prompt invalidation hook plumbing (issue #774)
  // -------------------------------------------------------------------------
  //
  // The store fires the registered invalidation hook on every mutation
  // (create/update/delete/rename) AND only on the happy path. Failures must
  // not fire the hook (the cached system prompt is still correct, and a
  // wasted rebuild would be observable as a perf regression in the dashboard).
  // share/list never fire — read-only.
  describe('prompt invalidation hook', () => {
    it('fires on createUserSkill success', () => {
      const calls: string[] = [];
      store.setSkillPromptInvalidationHook((u) => calls.push(u));

      store.createUserSkill(userId, 'a', '---\nname: a\n---\nbody');

      expect(calls).toEqual([userId]);
    });

    it('fires on updateUserSkill success', () => {
      const calls: string[] = [];
      store.createUserSkill(userId, 'a', '---\nname: a\n---\nbody');
      store.setSkillPromptInvalidationHook((u) => calls.push(u));

      store.updateUserSkill(userId, 'a', '---\nname: a\n---\nbody2');

      expect(calls).toEqual([userId]);
    });

    it('fires on deleteUserSkill success', () => {
      const calls: string[] = [];
      store.createUserSkill(userId, 'a', '---\nname: a\n---\nbody');
      store.setSkillPromptInvalidationHook((u) => calls.push(u));

      store.deleteUserSkill(userId, 'a');

      expect(calls).toEqual([userId]);
    });

    it('fires on renameUserSkill success', () => {
      const calls: string[] = [];
      store.createUserSkill(userId, 'old', '---\nname: old\n---\nbody');
      store.setSkillPromptInvalidationHook((u) => calls.push(u));

      store.renameUserSkill(userId, 'old', 'new-name');

      expect(calls).toEqual([userId]);
    });

    it('does NOT fire on createUserSkill failure (invalid name)', () => {
      const calls: string[] = [];
      store.setSkillPromptInvalidationHook((u) => calls.push(u));

      const result = store.createUserSkill(userId, 'Bad_Name', 'body');
      expect(result.ok).toBe(false);
      expect(calls).toEqual([]);
    });

    it('does NOT fire on renameUserSkill failure (target taken)', () => {
      store.createUserSkill(userId, 'a', '---\nname: a\n---\nbody');
      store.createUserSkill(userId, 'b', '---\nname: b\n---\nbody');
      const calls: string[] = [];
      store.setSkillPromptInvalidationHook((u) => calls.push(u));

      const result = store.renameUserSkill(userId, 'a', 'b');
      expect(result.ok).toBe(false);
      expect(result.error).toBe('EEXIST');
      expect(calls).toEqual([]);
    });

    it('does NOT fire on shareUserSkill (read-only)', () => {
      store.createUserSkill(userId, 'a', '---\nname: a\n---\nbody');
      const calls: string[] = [];
      store.setSkillPromptInvalidationHook((u) => calls.push(u));

      const result = store.shareUserSkill(userId, 'a');
      expect(result.ok).toBe(true);
      expect(calls).toEqual([]);
    });
  });
});
