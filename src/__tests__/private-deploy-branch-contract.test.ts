/**
 * The deploy bundle's staged-artifact check (scripts/smoke/setup-package.js, "private deployment branch") refuses
 * a bundle whose shipped files name the private deploy branch. It runs only in the deploy workflow's prepare step,
 * so a source that names it passes CI and then blocks every deploy (2026-11-02: #734's work-queue default stopped
 * the dev deploy of `6eab693d`). This contract runs the same pattern over the shipped sources, so CI stops it first.
 *
 * Shipped = what scripts/deploy/stage-bundle.sh copies: the sources of `dist` (src, including the prompt, persona
 * and local `.md` it copies), packages/<pkg>/src and assets, somalib, services, and the single files it lists —
 * minus tests and their inputs (`__tests__`, `__fixtures__`, `__mocks__`, `*.test.*`, src/test-utils), which it
 * prunes.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '..', '..');
// The same pattern as scripts/smoke/setup-package.js PRIVATE_IDENTITY_PATTERNS ("private deployment branch").
const PRIVATE_BRANCH = /\bdeploy\/dev2\b/i;
const SKIP_DIRS = new Set(['__tests__', '__fixtures__', '__mocks__', 'node_modules', 'dist', '__pycache__']);
// stage-bundle.sh copy_file, one by one.
const SHIPPED_FILES = [
  'package.json',
  'scripts/service.sh',
  'scripts/smoke/mcp-bins.js',
  'scripts/smoke/resvg-native.js',
  'scripts/deploy/sync-bundle.sh',
  'scripts/deploy/install-target.sh',
  'deploy/protected-paths.txt',
  'config.default.json',
  '.system.prompt.example',
  'infra/slack/slack-app-manifest.json',
];
const TEXT = /\.(ts|js|cjs|mjs|json|prompt|md|sh|txt|ya?ml|py|html|css)$/;

function shipped(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const sub = path.join(dir, entry.name);
      if (!SKIP_DIRS.has(entry.name) && sub !== path.join(ROOT, 'src', 'test-utils')) shipped(sub, out);
    } else if (TEXT.test(entry.name) && !/\.test\.[cm]?[jt]s$/.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

describe('no shipped source names the private deploy branch', () => {
  it('the sources of everything stage-bundle.sh ships are clean', () => {
    const packages = fs
      .readdirSync(path.join(ROOT, 'packages'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .flatMap((d) => [path.join(ROOT, 'packages', d.name, 'src'), path.join(ROOT, 'packages', d.name, 'assets')]);
    const roots = [path.join(ROOT, 'src'), path.join(ROOT, 'somalib'), path.join(ROOT, 'services'), ...packages];
    const files = [
      ...roots.flatMap((r) => shipped(r)),
      ...SHIPPED_FILES.map((f) => path.join(ROOT, f)).filter((f) => fs.existsSync(f)),
    ];
    const hits = files
      .filter((f) => PRIVATE_BRANCH.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f));
    expect(hits).toEqual([]);
  });
});
