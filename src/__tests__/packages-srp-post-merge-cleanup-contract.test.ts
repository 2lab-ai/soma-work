import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Post-merge cleanup contract for PR #960 (packages SRP refactor).
//
// After the SRP refactor moved code into packages-star, several artifacts
// left behind continue to corrupt CI signal or shadow the new layout:
//
//   - The original mcp-servers directory at the repo root is no longer a
//     workspace and is no longer referenced by src/mcp-config-builder.ts or
//     src/internal-mcp-server-resolver.ts. Phase 0 already outlaws it for
//     production paths, but vitest.config.ts still collects its dead test
//     files, producing a false-green CI signal.
//   - packages/process-shared/src/env-paths.ts is a 3-line duplicate of the
//     canonical packages/common/src/env-paths.ts and has zero importers.
//   - biome.json and package.json lint commands omit packages-star, leaving
//     roughly half of the new code unlinted.
//   - vitest.config.ts does not pick up tests under packages-star, so the
//     test files in packages/process-shared/src/model-commands and the
//     packages/mcp-servers/* tree never run via npm test.
//   - The _shared MCP-server helpers were migrated into
//     packages/process-shared/src/mcp but the matching tests were not
//     carried across; they only exist under the dead root tree today.
//
// Each `it` below pins one of those invariants. They assert ONLY the cleanup
// invariants and do not re-state boundaries that earlier phase contracts
// already enforce.

const repoRoot = path.resolve(__dirname, '..', '..');

function read(relative: string): string {
  return fs.readFileSync(path.join(repoRoot, relative), 'utf8');
}

describe('packages SRP post-merge cleanup contract', () => {
  it('removes the dead root mcp-servers/ directory', () => {
    const legacyRoot = path.join(repoRoot, 'mcp-servers');
    expect(fs.existsSync(legacyRoot), `${legacyRoot} should not exist`).toBe(false);
  });

  it('vitest collects packages/ tests and skips the dead root mcp-servers tree', () => {
    const config = read('vitest.config.ts');
    expect(config).toContain("'packages/**/*.test.ts'");
    expect(config).not.toMatch(/['"]mcp-servers\/\*\*\/\*\.test\.ts['"]/);
  });

  it('biome includes cover packages/', () => {
    const biome = JSON.parse(read('biome.json')) as { files?: { includes?: string[] } };
    expect(biome.files?.includes).toEqual(expect.arrayContaining(['packages/**/*.ts']));
  });

  it('package.json check / lint / format scripts target packages/', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    for (const name of ['check', 'lint', 'format', 'format:check']) {
      const cmd = scripts[name] ?? '';
      expect(cmd, `package.json scripts.${name} should mention packages/ — got: ${cmd}`).toContain('packages/');
    }
  });

  it('removes duplicate env-paths in @soma/process-shared', () => {
    const dup = path.join(repoRoot, 'packages/process-shared/src/env-paths.ts');
    expect(fs.existsSync(dup), `${dup} should not exist`).toBe(false);
  });

  it('migrates the two _shared mcp tests into @soma/process-shared', () => {
    const baseTest = path.join(repoRoot, 'packages/process-shared/src/mcp/base-mcp-server.test.ts');
    const cacheTest = path.join(repoRoot, 'packages/process-shared/src/mcp/config-cache.test.ts');
    expect(fs.existsSync(baseTest), `${baseTest} should exist`).toBe(true);
    expect(fs.existsSync(cacheTest), `${cacheTest} should exist`).toBe(true);
  });

  it('archives completed packages-srp-refactor plan docs', () => {
    const archivedCurrent = path.join(repoRoot, 'docs/archive/plans/packages-srp-refactor');
    expect(fs.existsSync(archivedCurrent), `${archivedCurrent} should exist`).toBe(true);

    const stillCurrent = path.join(repoRoot, 'docs/current/plans/packages-srp-refactor');
    expect(fs.existsSync(stillCurrent), `${stillCurrent} should not exist anymore`).toBe(false);

    const stillStale = path.join(repoRoot, 'docs/stale-plans/review-needed/packages-srp-refactor');
    expect(fs.existsSync(stillStale), `${stillStale} should not exist anymore`).toBe(false);
  });
});
