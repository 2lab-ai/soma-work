/**
 * The deploy bundle's staged-artifact check (scripts/smoke/setup-package.js, "private deployment branch") refuses
 * a bundle whose shipped files name the private deploy branch. It runs only in the deploy workflow's prepare step,
 * so a source that names it passes CI and then blocks every deploy (2026-11-02: #734's work-queue default stopped
 * the dev deploy of `6eab693d`). This contract runs the same pattern over the shipped sources, so CI stops it first.
 *
 * Shipped = src, packages/<pkg>/src, somalib — minus tests and their inputs (`__tests__`, `__fixtures__`,
 * `__mocks__`, `*.test.*`), which stage-bundle.sh prunes. Documentation (`*.md` outside src/local) is not shipped.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '..', '..');
// The same pattern as scripts/smoke/setup-package.js PRIVATE_IDENTITY_PATTERNS ("private deployment branch").
const PRIVATE_BRANCH = /\bdeploy\/dev2\b/i;
const SKIP_DIRS = new Set(['__tests__', '__fixtures__', '__mocks__', 'node_modules', 'dist']);
const TEXT = /\.(ts|js|cjs|mjs|json|prompt|md|sh|txt|ya?ml)$/;

function shipped(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) shipped(path.join(dir, entry.name), out);
    } else if (TEXT.test(entry.name) && !/\.test\.[cm]?[jt]s$/.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

describe('no shipped source names the private deploy branch', () => {
  it('src, packages/*/src and somalib are clean', () => {
    const roots = [
      path.join(ROOT, 'src'),
      path.join(ROOT, 'somalib'),
      ...fs
        .readdirSync(path.join(ROOT, 'packages'), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(ROOT, 'packages', d.name, 'src')),
    ];
    const hits = roots
      .flatMap((r) => shipped(r))
      .filter((f) => PRIVATE_BRANCH.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f));
    expect(hits).toEqual([]);
  });
});
