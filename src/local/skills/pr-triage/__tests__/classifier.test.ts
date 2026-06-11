/**
 * Regression tests for `classify-prs.ts`. Each test pins one of the
 * load-bearing fixes from cycles 1-4. The classifier itself isn't exported,
 * so we exercise it via the CLI: spawn `npx tsx classify-prs.ts --prs <fixture>
 * --ci <fixture> --now <iso>`, parse the JSON output, assert.
 *
 * Why CLI-spawn rather than import? The script is `main()`-driven (top-level
 * call to main at file end). Importing it would invoke main() at import time
 * with the test process's argv. Spawning keeps the boundary clean.
 *
 * Each test writes its fixtures to a unique tmp dir to avoid test interference
 * under `vitest run --threads`.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = join(__dirname, '..', 'scripts', 'classify-prs.ts');

interface ClassifiedPRSummary {
  number: number;
  category: string;
  recommendedLabels: string[];
  removeLabels: string[];
  reasonHints: string[];
  parent: { number: number; category: string } | null;
  authorType: string;
  ageDays: number;
}

interface ClassifyResult {
  warnings: string[];
  byCategory: Record<string, number>;
  prs: ClassifiedPRSummary[];
}

function runClassify(prs: unknown[], ci: Record<string, unknown>, nowIso: string): ClassifyResult {
  const dir = mkdtempSync(join(tmpdir(), 'pr-triage-test-'));
  const prsPath = join(dir, 'prs.json');
  const ciPath = join(dir, 'ci.json');
  writeFileSync(prsPath, JSON.stringify(prs));
  writeFileSync(ciPath, JSON.stringify(ci));

  const r = spawnSync('npx', ['tsx', SCRIPT, '--prs', prsPath, '--ci', ciPath, '--now', nowIso], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0) {
    throw new Error(`classify-prs exited ${r.status}: ${r.stderr}`);
  }
  return JSON.parse(r.stdout) as ClassifyResult;
}

function pr(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    number: 1,
    title: 'test',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    baseRefName: 'main',
    headRefName: 'feat/x',
    reviewDecision: null,
    author: { __typename: 'User', login: 'tester' },
    createdAt: '2026-05-01T00:00:00Z',
    labels: [],
    commits: { nodes: [{ commit: { committedDate: '2026-05-01T00:00:00Z' } }] },
    comments: { nodes: [] },
    reviews: { nodes: [] },
    ...overrides,
  };
}

const NOW = '2026-05-08T00:00:00Z';

describe('classify-prs regression suite', () => {
  // ---- cycle 1 fix: BEHIND + approved active → behind-base, not approved-mergeable
  it('cycle-1: BEHIND + APPROVED + 1d → behind-base', () => {
    const out = runClassify(
      [
        pr({
          number: 1,
          mergeStateStatus: 'BEHIND',
          reviewDecision: 'APPROVED',
          createdAt: '2026-05-07T00:00:00Z',
          commits: { nodes: [{ commit: { committedDate: '2026-05-07T00:00:00Z' } }] },
          reviews: { nodes: [{ submittedAt: '2026-05-07T00:00:00Z' }] },
        }),
      ],
      { '1': { status: 'completed', conclusion: 'success', databaseId: 1 } },
      NOW,
    );
    expect(out.prs[0].category).toBe('behind-base');
    expect(out.prs[0].recommendedLabels).toContain('needs-rebase');
    expect(out.prs[0].recommendedLabels).not.toContain('stale');
  });

  // ---- cycle 4 fix: BEHIND + approved 6d → approved-stale w/ rebase hint AND label
  it('cycle-4: BEHIND + APPROVED + 6d → approved-stale + needs-rebase + rebase hint', () => {
    const out = runClassify(
      [
        pr({
          number: 1,
          mergeStateStatus: 'BEHIND',
          reviewDecision: 'APPROVED',
          createdAt: '2026-05-02T00:00:00Z',
          commits: { nodes: [{ commit: { committedDate: '2026-05-02T00:00:00Z' } }] },
          reviews: { nodes: [{ submittedAt: '2026-05-02T00:00:00Z' }] },
        }),
      ],
      { '1': { status: 'completed', conclusion: 'success', databaseId: 1 } },
      NOW,
    );
    expect(out.prs[0].category).toBe('approved-stale');
    expect(out.prs[0].recommendedLabels).toContain('needs-rebase');
    expect(out.prs[0].recommendedLabels).toContain('stale');
    expect(out.prs[0].reasonHints.join(' ')).toMatch(/rebase needed before merge/);
  });

  // ---- cycle 2 fix: grandchild via stack-stuck parent
  it('cycle-2: A→B→C→D, A stale → all of B/C/D stack-stuck (BFS parent-first)', () => {
    const old = '2026-04-13T00:00:00Z'; // 25d
    const out = runClassify(
      [
        pr({
          number: 1,
          headRefName: 'feat/A',
          createdAt: old,
          commits: { nodes: [{ commit: { committedDate: old } }] },
        }),
        pr({
          number: 2,
          baseRefName: 'feat/A',
          headRefName: 'feat/B',
          createdAt: old,
          commits: { nodes: [{ commit: { committedDate: old } }] },
        }),
        pr({
          number: 3,
          baseRefName: 'feat/B',
          headRefName: 'feat/C',
          createdAt: old,
          commits: { nodes: [{ commit: { committedDate: old } }] },
        }),
        pr({
          number: 4,
          baseRefName: 'feat/C',
          headRefName: 'feat/D',
          createdAt: old,
          commits: { nodes: [{ commit: { committedDate: old } }] },
        }),
      ],
      {
        '1': { status: 'completed', conclusion: 'success', databaseId: 1 },
        '2': { status: 'completed', conclusion: 'success', databaseId: 2 },
        '3': { status: 'completed', conclusion: 'success', databaseId: 3 },
        '4': { status: 'completed', conclusion: 'success', databaseId: 4 },
      },
      NOW,
    );
    const byNum = new Map(out.prs.map((p) => [p.number, p]));
    expect(byNum.get(1)?.category).toBe('awaiting-review-stale');
    expect(byNum.get(2)?.category).toBe('stack-stuck');
    expect(byNum.get(3)?.category).toBe('stack-stuck');
    expect(byNum.get(4)?.category).toBe('stack-stuck');
    expect(byNum.get(2)?.recommendedLabels).toContain('stale');
    expect(byNum.get(4)?.recommendedLabels).toContain('stale');
  });

  // ---- cycle 3 fix: UNKNOWN-mergeable transient (no labels) vs aged (labels apply)
  it('cycle-3: UNKNOWN-mergeable APPROVED 1d → category active, no stale label', () => {
    const out = runClassify(
      [
        pr({
          number: 1,
          mergeable: 'UNKNOWN',
          reviewDecision: 'APPROVED',
          createdAt: '2026-05-07T00:00:00Z',
          commits: { nodes: [{ commit: { committedDate: '2026-05-07T00:00:00Z' } }] },
          reviews: { nodes: [{ submittedAt: '2026-05-07T00:00:00Z' }] },
        }),
      ],
      { '1': { status: 'completed', conclusion: 'success', databaseId: 1 } },
      NOW,
    );
    expect(out.prs[0].category).toBe('approved-mergeable');
    expect(out.prs[0].recommendedLabels).not.toContain('stale');
    expect(out.prs[0].recommendedLabels).not.toContain('rotten');
  });

  it('cycle-3: UNKNOWN-mergeable APPROVED 6d (stale tier, within 7d grace) → no stale label, hint preserved', () => {
    const out = runClassify(
      [
        pr({
          number: 1,
          mergeable: 'UNKNOWN',
          reviewDecision: 'APPROVED',
          createdAt: '2026-05-02T00:00:00Z',
          commits: { nodes: [{ commit: { committedDate: '2026-05-02T00:00:00Z' } }] },
          reviews: { nodes: [{ submittedAt: '2026-05-02T00:00:00Z' }] },
        }),
      ],
      { '1': { status: 'completed', conclusion: 'success', databaseId: 1 } },
      NOW,
    );
    expect(out.prs[0].category).toBe('approved-stale');
    expect(out.prs[0].recommendedLabels).not.toContain('stale');
    expect(out.prs[0].reasonHints.join(' ')).toMatch(/merge engine still computing/);
  });

  it('cycle-3: UNKNOWN-mergeable APPROVED 8d (>7d grace) → labels apply', () => {
    const out = runClassify(
      [
        pr({
          number: 1,
          mergeable: 'UNKNOWN',
          reviewDecision: 'APPROVED',
          createdAt: '2026-04-30T00:00:00Z',
          commits: { nodes: [{ commit: { committedDate: '2026-04-30T00:00:00Z' } }] },
          reviews: { nodes: [{ submittedAt: '2026-04-30T00:00:00Z' }] },
        }),
      ],
      { '1': { status: 'completed', conclusion: 'success', databaseId: 1 } },
      NOW,
    );
    expect(out.prs[0].recommendedLabels.some((l) => l === 'stale' || l === 'rotten')).toBe(true);
    expect(out.prs[0].reasonHints.join(' ')).toMatch(/persisted >7d/);
  });

  // ---- cycle 3 fix: bot author → reasonHint + authorType
  it('cycle-3: __typename=Bot → authorType=bot, dedicated hint', () => {
    const out = runClassify(
      [
        pr({
          number: 1,
          author: { __typename: 'Bot', login: 'zhuge-liang-bot' },
          createdAt: '2026-04-22T00:00:00Z',
          commits: { nodes: [{ commit: { committedDate: '2026-04-22T00:00:00Z' } }] },
        }),
      ],
      { '1': { status: 'completed', conclusion: 'success', databaseId: 1 } },
      NOW,
    );
    expect(out.prs[0].authorType).toBe('bot');
    expect(out.prs[0].reasonHints.join(' ')).toMatch(/bot-author.*pings won't work/);
  });

  it('cycle-3: app/-prefixed login (no __typename) → bot via heuristic', () => {
    const out = runClassify(
      [
        pr({
          number: 1,
          author: { login: 'app/some-bot' },
          createdAt: '2026-04-22T00:00:00Z',
          commits: { nodes: [{ commit: { committedDate: '2026-04-22T00:00:00Z' } }] },
        }),
      ],
      { '1': { status: 'completed', conclusion: 'success', databaseId: 1 } },
      NOW,
    );
    expect(out.prs[0].authorType).toBe('bot');
  });

  it('cycle-3: ghost (deleted account) → authorType=ghost, deleted hint', () => {
    const out = runClassify(
      [
        pr({
          number: 1,
          author: null,
          createdAt: '2026-04-22T00:00:00Z',
          commits: { nodes: [{ commit: { committedDate: '2026-04-22T00:00:00Z' } }] },
        }),
      ],
      { '1': { status: 'completed', conclusion: 'success', databaseId: 1 } },
      NOW,
    );
    expect(out.prs[0].authorType).toBe('ghost');
    expect(out.prs[0].reasonHints.join(' ')).toMatch(/account deleted/);
  });

  // ---- cycle 2 fix: head-ref collision → ambiguous, drop from stack map, warn
  it('cycle-2: duplicate headRefName → ambiguousHeads warning + neither child stack-detected', () => {
    const old = '2026-04-22T00:00:00Z';
    const out = runClassify(
      [
        pr({
          number: 1,
          headRefName: 'feat/dup',
          createdAt: old,
          commits: { nodes: [{ commit: { committedDate: old } }] },
        }),
        pr({
          number: 2,
          headRefName: 'feat/dup',
          baseRefName: 'main',
          createdAt: old,
          commits: { nodes: [{ commit: { committedDate: old } }] },
        }),
        pr({
          number: 3,
          baseRefName: 'feat/dup',
          headRefName: 'feat/child',
          createdAt: old,
          commits: { nodes: [{ commit: { committedDate: old } }] },
        }),
      ],
      {
        '1': { status: 'completed', conclusion: 'success', databaseId: 1 },
        '2': { status: 'completed', conclusion: 'success', databaseId: 2 },
        '3': { status: 'completed', conclusion: 'success', databaseId: 3 },
      },
      NOW,
    );
    expect(out.warnings.join(' ')).toMatch(/Head ref "feat\/dup".*multiple/);
    const byNum = new Map(out.prs.map((p) => [p.number, p]));
    expect(byNum.get(3)?.category).not.toBe('stack-stuck');
    expect(byNum.get(3)?.category).not.toBe('stack-dependent');
  });

  // ---- exempt
  it('exempt: keep-open label suppresses stale labeling regardless of age', () => {
    const out = runClassify(
      [
        pr({
          number: 1,
          labels: [{ name: 'keep-open' }],
          createdAt: '2026-01-01T00:00:00Z',
          commits: { nodes: [{ commit: { committedDate: '2026-01-01T00:00:00Z' } }] },
        }),
      ],
      { '1': { status: 'completed', conclusion: 'success', databaseId: 1 } },
      NOW,
    );
    expect(out.prs[0].category).toBe('exempt');
    expect(out.prs[0].recommendedLabels).toEqual([]);
  });

  // ---- cycle 4 fix: corrupt input → corrupt category, never auto-rotten
  it('cycle-4: PR with no parseable timestamps → corrupt category, no labels', () => {
    const out = runClassify(
      [
        {
          number: 1,
          title: 'corrupt',
          isDraft: false,
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'CLEAN',
          baseRefName: 'main',
          headRefName: 'feat/c',
          reviewDecision: null,
          author: { __typename: 'User', login: 'tester' },
          createdAt: 'not-a-date',
          labels: [],
          commits: { nodes: [] },
          comments: { nodes: [] },
          reviews: { nodes: [] },
        },
      ],
      { '1': { status: 'completed', conclusion: 'success', databaseId: 1 } },
      NOW,
    );
    expect(out.prs[0].category).toBe('corrupt');
    expect(out.prs[0].recommendedLabels).toEqual([]);
    expect(out.prs[0].reasonHints.join(' ')).toMatch(/manual review/);
  });

  // ---- cycle 4 fix: --now NaN crashes parseArgs (validated)
  it('cycle-4: --now garbage → parseArgs throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-triage-test-'));
    const prsPath = join(dir, 'prs.json');
    writeFileSync(prsPath, '[]');
    const r = spawnSync('npx', ['tsx', SCRIPT, '--prs', prsPath, '--now', 'garbage'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--now must be ISO-8601/);
  });

  // ---- cycle 4 fix: --dry-run accepted as no-op
  it('cycle-4: --dry-run accepted by parseArgs (no-op pass-through)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-triage-test-'));
    const prsPath = join(dir, 'prs.json');
    writeFileSync(prsPath, '[]');
    const r = spawnSync('npx', ['tsx', SCRIPT, '--prs', prsPath, '--dry-run', '--now', NOW], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).prs).toEqual([]);
  });
});
