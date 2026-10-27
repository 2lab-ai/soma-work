import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Contract for local:pr-triage: a plugin skill that carries no identity of
 * its own — attribution comes from the session or repo that runs it.
 */

const md = readFileSync(resolve(__dirname, '..', 'SKILL.md'), 'utf8');
const frontmatter = md.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';

describe('local:pr-triage', () => {
  it('is named pr-triage and describes WHEN + Args in one quoted line', () => {
    expect(frontmatter).toMatch(/^name: pr-triage$/m);
    const description = frontmatter.match(/^description: "(.*)"$/m)?.[1] ?? '';
    expect(description).toContain('pr-triage');
    expect(description).toContain('Args');
  });

  it('names no fixed co-author; attribution follows the session or repo rule', () => {
    expect(md).not.toMatch(/Co-Authored-By/i);
    expect(md).toContain("follow the session's/repo's commit attribution rule");
  });
});
