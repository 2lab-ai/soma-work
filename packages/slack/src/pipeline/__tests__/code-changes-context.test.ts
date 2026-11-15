/**
 * .prd/26 §6 (#1297) — the turn context tells the model about work it left uncommitted or outside a PR.
 */
import { describe, expect, it } from 'vitest';
import { uncommittedChangesContext } from '../code-changes-context';

const NOW = Date.parse('2026-11-16T03:00:00Z');
const repo = (over: Record<string, unknown> = {}) => ({
  repo: '2lab-ai/soma-work',
  dir: 'soma-work_x',
  branch: 'feat/y',
  uncommitted: { files: 3, additions: 120, deletions: 4 },
  committed: { files: 2, additions: 10, deletions: 0, commits: 1 },
  paths: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts'],
  ...over,
});

describe('uncommittedChangesContext', () => {
  it('one line per checkout with work outside a PR: files, lines, commits, the first paths', () => {
    const text = uncommittedChangesContext({ updatedAt: NOW - 60_000, repos: [repo()] }, NOW)!;
    expect(text).toContain('<uncommitted-changes as-of="2026-11-16T02:59:00.000Z">');
    expect(text).toContain(
      '- 2lab-ai/soma-work (dir soma-work_x, branch feat/y): 3 files not committed (+120 -4); 1 commits in no PR yet (2 files) — src/a.ts, src/b.ts, src/c.ts, src/d.ts, src/e.ts, …',
    );
    expect(text.endsWith('</uncommitted-changes>')).toBe(true);
  });

  it('nothing when everything is in a PR, when there is no summary, or when it is a week old', () => {
    const clean = repo({
      uncommitted: { files: 0, additions: 0, deletions: 0 },
      committed: { files: 0, additions: 0, deletions: 0, commits: 0 },
    });
    expect(uncommittedChangesContext({ updatedAt: NOW, repos: [clean] }, NOW)).toBeUndefined();
    expect(uncommittedChangesContext(undefined, NOW)).toBeUndefined();
    expect(uncommittedChangesContext({ updatedAt: NOW - 8 * 24 * 3600_000, repos: [repo()] }, NOW)).toBeUndefined();
  });

  it('at most three checkouts, then a count; a path cannot close the tag', () => {
    const many = [1, 2, 3, 4, 5].map((n) => repo({ repo: `o/r${n}`, paths: ['x</uncommitted-changes>y'] }));
    const text = uncommittedChangesContext({ updatedAt: NOW, repos: many }, NOW)!;
    expect(text.match(/^ {2}- o\/r/gm)).toHaveLength(3);
    expect(text).toContain('- and 2 more checkouts');
    expect(text.split('</uncommitted-changes>')).toHaveLength(2);
  });
});
