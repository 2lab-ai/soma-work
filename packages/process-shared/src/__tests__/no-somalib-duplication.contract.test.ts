import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Contract: `@soma/process-shared` must NOT keep byte-for-byte copies of the
 * shared library that already lives in `somalib/`.
 *
 * `somalib/` is the canonical source for code shared between the harness
 * (`src/`, which imports `somalib/*` directly) and the separately-built MCP
 * server processes (which import `@soma/process-shared/*`). To avoid drift and
 * a second source of truth, every `packages/process-shared/src` file that has a
 * `somalib` twin must be a thin re-export of that twin rather than a duplicate
 * implementation.
 *
 * This test fails RED while the duplicate implementations exist and turns GREEN
 * once each twin is collapsed into a `export ... from 'somalib/<path>'` shim.
 */

const psSrcDir = path.resolve(__dirname, '..');
const somalibDir = path.resolve(__dirname, '..', '..', '..', '..', 'somalib');

function listTsFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'dist' || entry.name === 'node_modules') {
          continue;
        }
        walk(full);
        continue;
      }
      if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && !entry.name.endsWith('.test.ts')) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

/** Files in process-shared that have a same-relative-path twin under somalib/. */
function twinnedFiles(): string[] {
  return listTsFiles(psSrcDir)
    .map((abs) => path.relative(psSrcDir, abs))
    .filter((rel) => fs.existsSync(path.join(somalibDir, rel)));
}

function normalize(src: string): string {
  return src.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
}

describe('process-shared has no duplicate copy of somalib', () => {
  const twins = twinnedFiles();

  it('finds the twinned files to guard', () => {
    expect(twins.length).toBeGreaterThan(0);
  });

  for (const rel of twins) {
    it(`process-shared/src/${rel} re-exports somalib instead of duplicating it`, () => {
      const psContent = fs.readFileSync(path.join(psSrcDir, rel), 'utf8');
      const somalibContent = fs.readFileSync(path.join(somalibDir, rel), 'utf8');

      // 1. Must not be a byte-for-byte (whitespace-insensitive) copy.
      expect(normalize(psContent)).not.toEqual(normalize(somalibContent));

      // 2. Must re-export the canonical somalib module.
      expect(psContent).toMatch(/from ['"]somalib\//);
    });
  }
});
