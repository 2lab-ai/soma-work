import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Contract for local:pr-triage: a plugin skill that carries no identity of
 * its own — attribution comes from the session or repo that runs it — and
 * never acts on a truncated PR listing.
 */

const md = readFileSync(resolve(__dirname, '..', 'SKILL.md'), 'utf8');
const frontmatter = md.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';

describe('local:pr-triage', () => {
  it('is named pr-triage and describes WHEN + Args + NOT in one quoted line', () => {
    expect(frontmatter).toMatch(/^name: pr-triage$/m);
    const description = frontmatter.match(/^description: "(.*)"$/m)?.[1] ?? '';
    expect(description).toContain('pr-triage');
    expect(description).toContain('Args');
    expect(description).toContain('NOT for an approval-gated sweep');
  });

  it('names no fixed co-author; attribution follows the session or repo rule', () => {
    expect(md).not.toMatch(/Co-Authored-By/i);
    expect(md).toContain("follow the session's/repo's commit attribution rule");
  });

  it('lists open PRs with --limit 1000 and stops on a listing that hit the limit', () => {
    const lists = md.split('\n').filter((l) => l.includes('gh pr list'));
    expect(lists.length).toBeGreaterThanOrEqual(2);
    for (const l of lists) expect(l, l).toContain('--limit 1000');
    expect(md).toContain('Do not triage a truncated list.');
    expect(md).toContain('Reconcile by PR number against the step-1 list, not only by counts.');
  });

  it('registers the clone folder with the same directive as the pr-review workflow', () => {
    expect(md).toContain(
      '{"type": "source_working_dir", "action": "add", "path": "<absolute path of the created working folder>"}',
    );
    expect(md).toContain('$WORKING_DIR/');
  });

  it('uses the session GitHub identity and never switches it', () => {
    expect(md).toContain('do not switch identity');
    expect(md).not.toContain('GITHUB_TOKEN');
  });
});
