/**
 * Tests for shareUserSkill (in-process MANAGE_SKILL share storage layer).
 *
 * Mirrors src/__tests__/user-memory-store.test.ts: env-paths is mocked so
 * DATA_DIR points at a per-test temp dir, and Logger is silenced. Three
 * outcome classes per the share-action contract: happy / invalid name /
 * not found. The 2500-char dispatcher cap is exercised in
 * somalib/model-commands/catalog.test.ts — out of scope here.
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

describe('shareUserSkill', () => {
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
    // createUserSkill trims content on write; shareUserSkill reads back the
    // persisted bytes — the round-trip must be identical so any reader can
    // verify the install candidate matches what `create` would have stored.
    expect(result.content).toBe(content);
    expect(result.message).toContain('my-deploy');
  });

  it('returns ok=false with invalidSkillNameMessage when the name violates kebab-case', () => {
    const badName = 'Bad_Name';

    const result = store.shareUserSkill(userId, badName);

    expect(result.ok).toBe(false);
    expect(result.content).toBeUndefined();
    // Both storage layers MUST source this string from the shared module so
    // the in-process and standalone MCP layers cannot drift on user-facing
    // wording.
    expect(result.message).toBe(errors.invalidSkillNameMessage(badName));
  });

  it('returns ok=false with skillNotFoundMessage when a valid name has no SKILL.md', () => {
    const skillName = 'never-created';

    const result = store.shareUserSkill(userId, skillName);

    expect(result.ok).toBe(false);
    expect(result.content).toBeUndefined();
    // Disambiguating "invalid name" vs "not found" is the whole point of the
    // explicit isValidSkillName guard at the top of shareUserSkill — without
    // it, getUserSkill collapses both into `null`.
    expect(result.message).toBe(errors.skillNotFoundMessage(skillName));
  });
});
