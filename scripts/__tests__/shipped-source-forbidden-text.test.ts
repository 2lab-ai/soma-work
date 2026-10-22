/**
 * The deploy bundle scan (`scripts/smoke/setup-package.js`, run by
 * `stage-bundle.sh`) only runs at deploy time, so a forbidden private
 * identifier in a shipped source passed PR CI and then failed every deploy of
 * `main` (2026-10-22: a `release_notes` example named a private deployment
 * branch in deploy.prompt and two doc comments — #341). This runs the same
 * scanner, with the same pattern table, over the sources that become the
 * bundle, so the failure lands on the PR instead of the deploy.
 */

import { execSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');

// CommonJS script, shared with the bundle check — one scanner, one pattern table.
const { scanFileForForbiddenText } = require('../smoke/setup-package.js') as {
  scanFileForForbiddenText: (file: string) => { kind: string; name?: string };
};

/** Tracked sources that are compiled or copied into the deploy bundle. */
function shippedSources(): string[] {
  return execSync('git ls-files src packages', { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((file) => /^src\//.test(file) || /^packages\/[^/]+\/src\//.test(file))
    .filter((file) => !/(^|\/)(__tests__|__fixtures__|test-utils)\//.test(file))
    .filter((file) => !/\.(test|spec)\.[cm]?[jt]sx?$/.test(file));
}

describe('shipped sources carry nothing the deploy bundle scan rejects', () => {
  it('scans a real file set', () => {
    expect(shippedSources().length).toBeGreaterThan(100);
  });

  it('finds no credential or private identifier in any shipped source', () => {
    const offenders = shippedSources()
      .map((file) => ({ file, result: scanFileForForbiddenText(path.join(ROOT, file)) }))
      .filter(({ result }) => result.kind !== 'clean' && result.kind !== 'skipped')
      // The report names the file and the family, never the matched text.
      .map(({ file, result }) => `${file} (${result.kind}${result.name ? `: ${result.name}` : ''})`);
    expect(offenders).toEqual([]);
  });
});
