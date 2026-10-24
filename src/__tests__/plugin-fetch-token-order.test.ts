/**
 * GitHub App token must be live before plugins are fetched.
 *
 * `PluginManager.initialize()` fetches marketplace plugins by shelling out to
 * `gh api` with the daemon's `process.env`. A private marketplace repo is only
 * readable with the GitHub App installation token, and that token reaches
 * `GITHUB_TOKEN` only once `startAutoRefresh()` has run. If plugin init runs
 * first, `gh` falls back to the host keyring account, gets a 404, and the
 * plugin is skipped with no cache to fall back on; public marketplaces still
 * work, which hides the failure.
 *
 * `src/index.ts` cannot be imported in a unit test (it opens Slack sockets, a
 * web server, and a PID lock at import time), so this pins the ORDER of the
 * calls in the production source, as `daemon-readiness-seam.test.ts` does.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf-8');

/** Byte offset of `needle`, asserted unique so a rename cannot silently pass. */
function offsetOf(needle: string): number {
  const first = SOURCE.indexOf(needle);
  expect(first, `expected to find ${JSON.stringify(needle)} in src/index.ts`).toBeGreaterThanOrEqual(0);
  expect(SOURCE.indexOf(needle, first + 1), `expected ${JSON.stringify(needle)} to be unique`).toBe(-1);
  return first;
}

describe('plugin fetch vs GitHub App token order in src/index.ts', () => {
  it('starts GitHub App token auto-refresh before plugins are initialized', () => {
    const autoRefresh = offsetOf('await githubAuth.startAutoRefresh();');
    const pluginInit = offsetOf('await pluginManager.initialize();');
    expect(autoRefresh).toBeLessThan(pluginInit);
  });

  it('discovers GitHub App installations before plugins are initialized', () => {
    const discover = offsetOf('await discoverInstallations();');
    const pluginInit = offsetOf('await pluginManager.initialize();');
    expect(discover).toBeLessThan(pluginInit);
  });
});
