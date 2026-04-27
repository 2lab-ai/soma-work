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
    // SkillFileStore.createSkill trims trailing whitespace on write — we read
    // back what was actually persisted. The CONTENT (post-trim) must be
    // identical to what was written, so both sides see the same SKILL.md.
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
