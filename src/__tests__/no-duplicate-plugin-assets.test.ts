import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

/**
 * Single-source-of-truth guard for plugin content.
 *
 * The deployed plugin content (skills / agents / hooks / prompts / personas) is
 * built exclusively from `src/{local,prompt,persona}` — the root `build` script
 * does `cp -r src/local dist/` (and the same for prompt/persona), and
 * `.claude-plugin/marketplace.json` ships the `zworkflow` plugin from
 * `./src/local`. The earlier packages-SRP refactor left a drifted, hand-mirrored
 * copy under `packages/extensions/assets/*` that nothing reads at runtime, which
 * forced PRs (e.g. #1103) to edit the same content twice. This test prevents that
 * duplicate tree (and the dead `@soma/extensions` package) from being
 * reintroduced.
 */
describe('plugin content has a single source of truth', () => {
  it('does not reintroduce the dead @soma/extensions asset mirror', () => {
    const duplicateAssetTree = path.join(repoRoot, 'packages/extensions/assets');
    expect(
      fs.existsSync(duplicateAssetTree),
      `${duplicateAssetTree} is a hand-mirrored copy of src/{local,prompt,persona} that nothing reads at runtime. ` +
        'Keep plugin content in src/ only; do not recreate this tree.',
    ).toBe(false);

    const deadPackage = path.join(repoRoot, 'packages/extensions');
    expect(
      fs.existsSync(deadPackage),
      `${deadPackage} (@soma/extensions) has no runtime consumers. Do not reintroduce it.`,
    ).toBe(false);
  });

  it('keeps executable bits on src/local plugin hooks', () => {
    const hooksDir = path.join(repoRoot, 'src/local/hooks');
    const hookFiles = fs
      .readdirSync(hooksDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.sh'))
      .map((entry) => path.join(hooksDir, entry.name));

    expect(hookFiles.length).toBeGreaterThan(0);
    for (const hookFile of hookFiles) {
      expect(fs.statSync(hookFile).mode & 0o111, hookFile).not.toBe(0);
    }
  });
});
