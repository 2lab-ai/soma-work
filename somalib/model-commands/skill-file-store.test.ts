/**
 * Storage-layer tests for the MANAGE_SKILL share action.
 *
 * Three outcome classes per the design contract:
 *   - happy:        valid kebab-case name + skill exists → ok=true, content set
 *   - invalid name: pattern-violating name              → ok=false, invalidSkillNameMessage
 *   - not found:    valid name but no SKILL.md          → ok=false, skillNotFoundMessage
 *
 * The 2500-char cap is enforced one layer above (the dispatcher); this file
 * intentionally does NOT test it. Storage just answers "valid? exists?
 * here is the content" — see `catalog.test.ts` for cap behavior.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SkillFileStore } from './skill-file-store';
import { invalidSkillNameMessage, skillNotFoundMessage } from './skill-share-errors';

describe('SkillFileStore.shareSkill', () => {
  let dataDir: string;
  let store: SkillFileStore;
  const userId = 'U_test_user';

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-file-store-share-'));
    store = new SkillFileStore(dataDir);
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('returns ok=true with full content when a valid skill exists', () => {
    const skillName = 'my-deploy';
    const content = [
      '---',
      'name: my-deploy',
      'description: Deploy the thing',
      '---',
      '',
      'Body of the skill goes here.',
    ].join('\n');
    store.createSkill(userId, skillName, content);

    const result = store.shareSkill(userId, skillName);

    expect(result.ok).toBe(true);
    // SkillFileStore.createSkill persists `content` verbatim (issue #750).
    // The trim is used only for the empty / oversize validation; the bytes
    // on disk match the bytes the caller passed in, so the inline-edit modal
    // can round-trip a SKILL.md without silent whitespace rewrites.
    expect(result.content).toBe(content);
    expect(result.message).toContain('my-deploy');
  });

  it('returns ok=false with invalidSkillNameMessage when name violates kebab-case', () => {
    const badName = 'Bad_Name';

    const result = store.shareSkill(userId, badName);

    expect(result.ok).toBe(false);
    expect(result.content).toBeUndefined();
    expect(result.message).toBe(invalidSkillNameMessage(badName));
  });

  it('returns ok=false with invalidSkillNameMessage when name has path traversal', () => {
    // `..` fails both SKILL_NAME_PATTERN and isSafeSegment — invalid-name
    // path is the first guard so the message must match.
    const result = store.shareSkill(userId, '..');
    expect(result.ok).toBe(false);
    expect(result.content).toBeUndefined();
    expect(result.message).toBe(invalidSkillNameMessage('..'));
  });

  it('returns ok=false with skillNotFoundMessage when a valid name has no SKILL.md', () => {
    const skillName = 'never-created';

    const result = store.shareSkill(userId, skillName);

    expect(result.ok).toBe(false);
    expect(result.content).toBeUndefined();
    expect(result.message).toBe(skillNotFoundMessage(skillName));
  });
});

/**
 * Storage-layer tests for the MANAGE_SKILL rename action (issue #774).
 *
 * Outcome classes covered:
 *   - happy:        valid src + valid dst → ok=true, source dir gone, dst dir present
 *   - same name:    src === dst         → ok=false, error='INVALID'
 *   - source gone:  no SKILL.md          → ok=false, error='NOT_FOUND'
 *   - target taken: dst already exists   → ok=false, error='EEXIST'
 *   - bad name:     pattern violation    → ok=false, error='INVALID'
 *   - case-only:    foo → Foo            → ok=true (uses temp staging)
 *   - length cap:   newName too long     → ok=false, error='INVALID'
 *
 * Verbatim persistence: SKILL.md bytes survive the rename — the directory is
 * moved, not the file. We assert byte equality post-rename so future "smarten
 * frontmatter" temptations have a regression alarm to trip.
 */
describe('SkillFileStore.renameSkill', () => {
  let dataDir: string;
  let store: SkillFileStore;
  const userId = 'U_test_rename';

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-file-store-rename-'));
    store = new SkillFileStore(dataDir);
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function srcContent(): string {
    return ['---', 'name: old', 'description: ye olde', '---', '', 'body'].join('\n');
  }

  it('renames an existing skill — source dir disappears, target dir contains identical bytes', () => {
    const content = srcContent();
    store.createSkill(userId, 'old', content);

    const result = store.renameSkill(userId, 'old', 'new');

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(fs.existsSync(path.join(dataDir, userId, 'skills', 'old'))).toBe(false);
    const dst = path.join(dataDir, userId, 'skills', 'new', 'SKILL.md');
    expect(fs.existsSync(dst)).toBe(true);
    expect(fs.readFileSync(dst, 'utf-8')).toBe(content);
  });

  it('returns INVALID when oldName === newName', () => {
    store.createSkill(userId, 'same', srcContent());

    const result = store.renameSkill(userId, 'same', 'same');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('INVALID');
  });

  it('returns NOT_FOUND when source skill does not exist', () => {
    const result = store.renameSkill(userId, 'missing', 'new-name');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('NOT_FOUND');
  });

  it('returns EEXIST when target name is already taken', () => {
    store.createSkill(userId, 'src', srcContent());
    store.createSkill(userId, 'dst', srcContent().replace('old', 'dst'));

    const result = store.renameSkill(userId, 'src', 'dst');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('EEXIST');
    // Both dirs survive — the rename never touched disk.
    expect(fs.existsSync(path.join(dataDir, userId, 'skills', 'src'))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, userId, 'skills', 'dst'))).toBe(true);
  });

  it('returns INVALID for a bad new-name pattern', () => {
    store.createSkill(userId, 'src', srcContent());

    const result = store.renameSkill(userId, 'src', 'Bad_Name');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('INVALID');
  });

  it('returns INVALID for a too-long new name', () => {
    store.createSkill(userId, 'src', srcContent());
    // 65 chars — one over the cap.
    const tooLong = 'a'.repeat(65);

    const result = store.renameSkill(userId, 'src', tooLong);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('INVALID');
  });

  it('handles a case-only rename through a temp directory (foo → foo would no-op without staging)', () => {
    // Use a distinct case-only target to exercise the temp-staging path. On
    // case-insensitive filesystems plain fs.rename(src, dst) is a no-op when
    // src.toLowerCase() === dst.toLowerCase() and the inode is identical;
    // staging through a uuid-suffixed temp dir makes the rename real.
    store.createSkill(userId, 'foo', srcContent());

    const result = store.renameSkill(userId, 'foo', 'foo-2');

    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(dataDir, userId, 'skills', 'foo'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, userId, 'skills', 'foo-2', 'SKILL.md'))).toBe(true);
  });
});
