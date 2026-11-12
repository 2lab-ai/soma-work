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
    expect(md).not.toMatch(/\/home\/[a-z]/);
    expect(md).not.toMatch(/mcp__llm__/);
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

  it('walks both layouts and pins each source once, before the user is asked', () => {
    expect(md).toContain('2-level layout → each directory is a');
    // The skill path keeps the source path: both defaults keep their skills under `skills/`.
    expect(md).toContain('skill path `<path>/<category>/<skill>`');
    expect(md).toContain('skill path `<path>/<skill>`');
    expect(md).toContain('git/trees/<dir sha>?recursive=1');
    expect(md).toMatch(
      /`truncated: true`, or a `commit` \(submodule\) or symlink entry in that tree → stop and report; never import a\s+partial file set\./,
    );
    expect(md).toContain('(not the value of `target=`)');
    const pin = md.indexOf('commits/HEAD --jq .sha');
    expect(pin).toBeGreaterThan(-1);
    expect(pin).toBeLessThan(md.indexOf('## Phase 4'));
    expect(md).toContain('never a new `HEAD`');
  });

  it('takes no license exception from a yes, and asks with the recommended choice first', () => {
    expect(md).toContain("The user's or the target owner's yes is not a license.");
    expect(md).toContain('**the recommended one first**');
  });

  it('pins the source commit, follows the vendoring contract and never merges', () => {
    expect(md).toContain('?ref=$SHA');
    expect(md).toContain('LICENSES/NOTICE.md');
    expect(md).toContain('Never auto-merge.');
    expect(md).toContain('never overwrite an existing skill');
  });

  it('the vendoring contract it follows is written down in the plugin CLAUDE.md', () => {
    expect(contract).toContain('## 벤더링 규약');
    expect(contract).toContain('가져오는 사람이나 이 저장소 오너의 승낙은 허락이 아니다');
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
