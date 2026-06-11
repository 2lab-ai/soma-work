/**
 * Pins the `@anthropic-ai/claude-agent-sdk` version in package.json.
 *
 * Background:
 *   PR #922 bumped `^0.2.111 → ^0.2.140`. After deploy users reported the
 *   bot "running then halting" mid-turn with frequent post-abort
 *   hook_callback Stream-closed stderr noise, so it was rolled back to
 *   ^0.2.111. (The Stream-closed noise was later handled directly — see
 *   `classifyClaudeStderr` / PR #928 / #999 — but the mid-turn-halt
 *   behavioral regression was never unit-reproducible.)
 *
 *   Advanced to `^0.3.156` (bundles claude-code CLI 2.1.156) to fix the
 *   Opus-4.8 `thinking`/`redacted_thinking` "blocks ... cannot be modified"
 *   400 that was silently reported as "작업 완료". The SDK at 0.2.111
 *   (CLI 2.1.111) mutates signed thinking blocks on transcript resume/fork;
 *   CLI 2.1.156 CHANGELOG: "Fixed an issue when using Opus 4.8 where thinking
 *   blocks were modified, leading to API errors." Empty-text+signature blocks
 *   are replay-safe by API contract — the bug was SDK-side reconstruction, not
 *   `display:'omitted'`. typecheck + the full unit suite pass on 0.3.156.
 *
 *   RISK: this is a major (0.2 → 0.3) jump and the prior #922 regression was
 *   behavioral (mid-turn halt) — invisible to unit tests. This pin MUST be
 *   validated on the dev environment with real multi-turn + extended-thinking
 *   + tool-use turns before reaching production.
 *
 *   This test exists to prevent an accidental re-bump (e.g. a renovate /
 *   dependabot PR sneaking past review) from silently changing the SDK.
 *   When the time comes to advance the pin, update the expected version
 *   below and the rationale in the PR body.
 *
 *   This is a `^0.3.x` range pin, not exact-version — patch upgrades inside
 *   the 0.3.x line are still allowed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('@anthropic-ai/claude-agent-sdk version pin', () => {
  it('package.json pins ^0.3.156 (advanced from ^0.2.111 for the Opus-4.8 thinking-block fix)', () => {
    const pkgPath = path.join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const pinned = pkg.dependencies?.['@anthropic-ai/claude-agent-sdk'];
    // ^0.3.156 bundles CLI 2.1.156 (Opus-4.8 thinking-block fix). If the pin is
    // changed, this fails loudly so the change is intentional, not silent.
    expect(pinned).toBe('^0.3.156');
  });

  it('node_modules resolves to a 0.3.x version (>= 0.3.156)', () => {
    // Catches the case where the pin says ^0.3.x but lockfile/install drifted
    // to an older line (e.g., a stale lockfile from before the bump).
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
    expect(sdkPkg.version).toMatch(/^0\.3\./);
    const [, minor, patch] = sdkPkg.version.split('.').map((n) => Number.parseInt(n, 10));
    // The thinking-block fix landed in CLI 2.1.156 == npm 0.3.156. Guard the floor.
    expect(minor === 3 && patch >= 156).toBe(true);
  });
});
