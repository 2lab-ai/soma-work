import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Contract for local:import-skills — vendors skills from other agent repos into a plugin.
 * Portable: no person, home path or harness call of its own; a dry run writes nothing; every import follows the
 * target plugin's vendoring contract, which src/local/CLAUDE.md now writes down.
 */

const md = readFileSync(resolve(__dirname, '..', 'SKILL.md'), 'utf8');
const frontmatter = md.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
const contract = readFileSync(resolve(__dirname, '..', '..', '..', 'CLAUDE.md'), 'utf8');

describe('local:import-skills', () => {
  it('is named import-skills and describes WHEN + triggers + Args (with --dry-run) in one quoted line', () => {
    expect(frontmatter).toMatch(/^name: import-skills$/m);
    const description = frontmatter.match(/^description: "(.*)"$/m)?.[1] ?? '';
    expect(description).toContain('import-skills');
    expect(description).toContain('Args');
    expect(description).toContain('--dry-run');
    expect(description.length).toBeLessThanOrEqual(420);
  });

  it('carries no fixed identity, home path or user-skill registration of its own', () => {
    expect(md).not.toMatch(/Co-Authored-By/i);
    expect(md).not.toMatch(/\/Users\/[a-z]/);
    expect(md).not.toMatch(/\b(MANAGE_SKILL|GET_SESSION|UPDATE_SESSION)\b/);
    expect(md).not.toContain('--personal');
    expect(md).toContain("follow the session's or the repository's commit rule");
  });

  it('a dry run stops at the candidate table and writes nothing', () => {
    expect(md).toContain(
      '`--dry-run` stops after the candidate table: no clone, branch, commit, push, PR or question.',
    );
    expect(md).toContain('**`--dry-run` ends here.**');
    expect(md.indexOf('**`--dry-run` ends here.**')).toBeLessThan(md.indexOf('## Phase 4'));
  });

  it('pins the source commit, follows the vendoring contract and never merges', () => {
    expect(md).toContain('commits/HEAD --jq .sha');
    expect(md).toContain('?ref=$SHA');
    expect(md).toContain('LICENSES/NOTICE.md');
    expect(md).toContain('Never auto-merge.');
    expect(md).toContain('never overwrite an existing skill');
  });

  it('the vendoring contract it follows is written down in the plugin CLAUDE.md', () => {
    expect(contract).toContain('## 벤더링 규약');
    for (const rule of [
      '원본 commit SHA',
      'LICENSES/NOTICE.md',
      '## Local changes',
      '<name>-skill.test.ts',
      'minor bump',
    ]) {
      expect(contract, rule).toContain(rule);
    }
  });
});
