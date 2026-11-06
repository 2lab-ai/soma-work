import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyGh, type GhPolicyContext } from './gh-policy.js';

/**
 * Every GitHub read the deploy workflow and the post-deploy QA skills prescribe must be one the
 * devops-tools `gh_read` classifier lets through. A doc that teaches a refused argv (a branch with
 * a `/` inside a `?query`, `%` encoding, a compare with short SHAs) sends every sandboxed QA run to
 * `missing: github` again (2026-11-06: QA ended "missing: github" on every sandboxed deploy).
 *
 * The docs spell a read in one of two ways, and this file extracts both:
 *  - a JSON input `{"account": "…", "args": ["api", …]}` (inline code or a fenced block);
 *  - prose: an inline-code `repos/…` path, optionally followed by ` with ` / ` and ` and an
 *    inline-code `"-f", "k=v", …` list, and by `filter `<jq>``.
 * Each read is classified as `api -X GET <path> [-f k=v …] [--jq <filter>]`, with and without
 * `--paginate`, after its placeholders are filled. The tests live in this package so they classify
 * with this checkout's gh-policy source, not a built copy.
 */

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const DOCS = [
  'src/prompt/workflows/deploy.prompt',
  'src/local/skills/deploy-qa/SKILL.md',
  'src/local/skills/qa-issue/SKILL.md',
] as const;
const readDoc = (doc: string) => readFileSync(resolve(REPO_ROOT, doc), 'utf8');

const ctx: GhPolicyContext = { allowedOwners: ['example-org'] };
const FULL_SHA = (digit: string) => digit.repeat(40);
const SHORT_SHA = 'abc1234';

/**
 * Placeholder → value. A branch gets a value with a `/` on purpose, so an inline `?branch=<target>`
 * is refused exactly as in production. A short-SHA placeholder gets 7 hex digits, so a compare
 * that uses one fails the full-SHA check. An unknown placeholder fails the test: map it here
 * consciously.
 */
const FILL: Record<string, string> = {
  account: 'member',
  'owner/repo': 'example-org/app',
  repo: 'example-org/app',
  path: 'repos/example-org/app/pulls',
  key: 'per_page',
  value: '100',
  filter: '.',
  'pr-number': '12',
  'run-id': '123456',
  id: '123456',
  N: '1',
  'CD workflow': 'deploy.yml',
  target: 'deploy/dev',
  branch: 'deploy/dev',
  source: 'deploy/dev',
  integrationBranch: 'deploy/dev',
  head_sha: FULL_SHA('a'),
  after_sha: FULL_SHA('b'),
  after: FULL_SHA('b'),
  before: FULL_SHA('c'),
  sha: FULL_SHA('d'),
  runningSha: FULL_SHA('e'),
  mergeSha: FULL_SHA('f'),
  'short sha': SHORT_SHA,
};

function fill(text: string): string {
  return text.replace(/<([^<>]+)>/g, (_, name: string) => {
    if (/7$/.test(name)) return SHORT_SHA;
    const value = FILL[name];
    if (value === undefined) throw new Error(`unknown placeholder <${name}> in ${JSON.stringify(text)}`);
    return value;
  });
}

interface DocRead {
  line: number;
  /** The read as the doc writes it, for failure messages. */
  source: string;
  path: string;
  pairs: string[];
  jq: string | null;
  /** Set when the doc gives the whole argv (a JSON `args` list). */
  args: string[] | null;
}

const JSON_INPUT_RE = /\{"account": "[^"]*", "args": \[[^\]]*\]\}/g;

/** Every GitHub read the text prescribes. */
function extractReads(text: string): DocRead[] {
  const reads: DocRead[] = [];
  text.split('\n').forEach((lineText, index) => {
    const line = index + 1;
    for (const match of lineText.matchAll(JSON_INPUT_RE)) {
      const input = JSON.parse(fill(match[0])) as { args: string[] };
      reads.push({ line, source: match[0], path: input.args[3] ?? '', pairs: [], jq: null, args: input.args });
    }
    let current: DocRead | null = null;
    let last = 0;
    for (const span of lineText.matchAll(/`([^`]+)`/g)) {
      const between = lineText.slice(last, span.index);
      last = (span.index ?? 0) + span[0].length;
      const code = span[1];
      if (code.startsWith('{"account"')) {
        current = null; // a JSON input, taken whole above
      } else if (code.startsWith('repos/')) {
        current = { line, source: code, path: fill(code), pairs: [], jq: null, args: null };
        reads.push(current);
      } else if (code.startsWith('"-f"')) {
        const pairs = JSON.parse(`[${fill(code)}]`) as string[];
        if (current !== null && /^\s*(with|and)\s*$/.test(between)) {
          current.pairs.push(...pairs);
          current.source += ` with ${code}`;
        } else {
          // A paging or query example on its own: check it against a plain listing.
          reads.push({ line, source: code, path: FILL.path, pairs, jq: null, args: null });
        }
      } else if (current !== null && /filter\s*$/.test(between)) {
        current.jq = code;
      }
    }
  });
  return reads;
}

function argvOf(read: DocRead): string[] {
  if (read.args !== null) return read.args;
  return ['api', '-X', 'GET', read.path, ...read.pairs, ...(read.jq === null ? [] : ['--jq', read.jq])];
}

/** Why the read would not run through gh_read as written; empty when it would. */
function problems(read: DocRead): string[] {
  const found: string[] = [];
  const argv = argvOf(read);
  for (const variant of [argv, [...argv, '--paginate']]) {
    const c = classifyGh(variant, ctx);
    if (c.kind !== 'read') found.push(`classifies as ${c.kind}: ${c.reason}`);
  }
  if (argv.some((word) => word.includes('%'))) found.push('uses % encoding');
  const endpoint = argv.find((word) => word.startsWith('repos/')) ?? '';
  const segments = endpoint.split('?')[0].split('/');
  if (segments[3] === 'compare' && !/^[0-9a-f]{40}\.\.\.[0-9a-f]{40}$/.test(segments[4] ?? '')) {
    found.push('compare without two full 40-character SHAs');
  }
  return found;
}

describe('every gh_read argv the deploy and QA docs prescribe classifies as read', () => {
  for (const doc of DOCS) {
    it(doc, () => {
      const reads = extractReads(readDoc(doc));
      expect(reads.length).toBeGreaterThan(5);
      const failures = reads.flatMap((read) => problems(read).map((p) => `${doc}:${read.line} ${read.source} — ${p}`));
      expect(failures).toEqual([]);
    });
  }

  it('extracts the reads that matter, with their -f pairs and filters', () => {
    const deploy = extractReads(readDoc(DOCS[0]));
    const deployQa = extractReads(readDoc(DOCS[1]));
    const qaIssue = extractReads(readDoc(DOCS[2]));
    const has = (reads: DocRead[], path: RegExp, pair?: string) =>
      reads.some((r) => path.test(argvOf(r).join(' ')) && (pair === undefined || argvOf(r).includes(pair)));
    // deploy.prompt: the JSON example, the CI poll's three lists, the CD listing by branch.
    expect(deploy.some((r) => r.args !== null)).toBe(true);
    expect(has(deploy, /\/commits\/a{40}\/check-runs /, 'filter=latest')).toBe(true);
    expect(has(deploy, /\/commits\/a{40}\/status /)).toBe(true);
    expect(has(deploy, /\/actions\/runs .*--jq /, `head_sha=${FULL_SHA('a')}`)).toBe(true);
    expect(has(deploy, /\/actions\/runs /, 'branch=deploy/dev')).toBe(true);
    // deploy-qa: the JSON form, the CD workflow runs by branch, both compares, the closed PRs by base.
    expect(deployQa.some((r) => r.args !== null)).toBe(true);
    expect(has(deployQa, /\/actions\/workflows\/deploy\.yml\/runs /, 'branch=deploy/dev')).toBe(true);
    expect(has(deployQa, /\/compare\/b{40}\.\.\.e{40} --jq \.status/)).toBe(true);
    expect(has(deployQa, /\/compare\/c{40}\.\.\.b{40} .*--jq /, 'page=1')).toBe(true);
    expect(has(deployQa, /\/pulls /, 'base=deploy/dev')).toBe(true);
    // qa-issue: the JSON form, the compare, the open-PR listing.
    expect(qaIssue.some((r) => r.args !== null)).toBe(true);
    expect(has(qaIssue, /\/compare\/f{40}\.\.\.e{40} --jq \.status/)).toBe(true);
    expect(has(qaIssue, /\/pulls /, 'state=open')).toBe(true);
  });

  it('fails a doc that reintroduces a refused form', () => {
    const bad = (line: string) => extractReads(line).flatMap(problems);
    // A branch (it holds a `/`) inside a ?query.
    expect(bad('a GitHub read of `repos/<owner/repo>/actions/runs?head_sha=<after_sha>&branch=<target>`')).not.toEqual(
      [],
    );
    // % encoding, in the path or in a -f value.
    expect(bad('a GitHub read of `repos/<owner/repo>/git/ref/heads/deploy%2Fdev`')).not.toEqual([]);
    expect(bad('a GitHub read of `repos/<owner/repo>/pulls` with `"-f", "base=deploy%2Fdev"`')).not.toEqual([]);
    // compare with short SHAs, as placeholders or literals, and in a JSON input.
    expect(bad('a GitHub read of `repos/<owner/repo>/compare/<before7>...<after7>`')).not.toEqual([]);
    expect(bad('a GitHub read of `repos/<owner/repo>/compare/abc1234...def5678`')).not.toEqual([]);
    expect(
      bad('`{"account": "<account>", "args": ["api", "repos/<owner/repo>/compare/<short sha>...<after>"]}`'),
    ).not.toEqual([]);
    // The same reads written the allowed way pass.
    expect(
      bad(
        'a GitHub read of `repos/<owner/repo>/actions/runs` with `"-f", "head_sha=<after_sha>", "-f", "branch=<target>"`',
      ),
    ).toEqual([]);
    expect(bad('a GitHub read of `repos/<owner/repo>/compare/<before>...<after>` (filter `.status`)')).toEqual([]);
  });

  it('refuses an unknown placeholder instead of guessing a value', () => {
    expect(() => extractReads('a GitHub read of `repos/<owner/repo>/pulls/<pull>`')).toThrow(
      /unknown placeholder <pull>/,
    );
  });
});
