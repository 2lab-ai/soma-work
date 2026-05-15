/**
 * Pins the `@anthropic-ai/claude-agent-sdk` version in package.json.
 *
 * Background:
 *   PR #922 bumped `^0.2.111 → ^0.2.140`. After deploy users reported the
 *   bot "running then halting" mid-turn with frequent post-abort
 *   hook_callback Stream-closed stderr noise. Rolling back to ^0.2.111
 *   (the last known-good pin) until a behavioral root-cause is bisected
 *   and a safer intermediate version is identified.
 *
 *   This test exists to prevent an accidental re-bump (e.g. a renovate /
 *   dependabot PR sneaking past review) from re-introducing the
 *   regression. When the time comes to advance the pin, update the
 *   expected version below and the rollback rationale in the PR body.
 *
 *   This is a `^0.2.x` range pin, not exact-version. Patch upgrades inside
 *   the 0.2.x line are still allowed (CHANGELOG marks 0.2.113 as the only
 *   semver-breaking entry below 0.2.140, and we've already absorbed it).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('@anthropic-ai/claude-agent-sdk version pin', () => {
  it('package.json pins ^0.2.111 (rolled back from ^0.2.140)', () => {
    const pkgPath = path.join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const pinned = pkg.dependencies?.['@anthropic-ai/claude-agent-sdk'];
    // ^0.2.111 is the known-good pin. If the bump is reintroduced, this fails
    // loudly so the change is intentional, not silent.
    expect(pinned).toBe('^0.2.111');
  });

  it('node_modules resolves to a 0.2.x version (not 0.3.x)', () => {
    // Catches the case where the pin says ^0.2.x but lockfile/install drifted
    // to a 0.3.x (e.g., a stale lockfile from the original bump).
    const sdkPkgPath = path.join(
      __dirname,
      '..',
      '..',
      'node_modules',
      '@anthropic-ai',
      'claude-agent-sdk',
      'package.json',
    );
    const sdkPkg = JSON.parse(fs.readFileSync(sdkPkgPath, 'utf8')) as { version: string };
    expect(sdkPkg.version).toMatch(/^0\.2\./);
  });
});
