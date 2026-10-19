/**
 * `missingDependencyEntry` — the archive gate's per-dependency runtime check.
 *
 * A package.json is not a module: a dependency tree whose built files were
 * pruned keeps its manifest. Each case is one way a manifest declares its entry,
 * resolved in Node's order (exports → main → implicit index.js).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const { missingDependencyEntry, unresolvedFirstPartyRequires } = require('../smoke/package-archives.js') as {
  missingDependencyEntry: (dir: string, rel: string) => string | null;
  unresolvedFirstPartyRequires: (root: string) => string[];
};

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-entry-'));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

let n = 0;
function pkg(manifest: Record<string, unknown> | string, files: string[] = []): string {
  const dir = path.join(scratch, `p${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), '');
  }
  return dir;
}
const check = (dir: string) => missingDependencyEntry(dir, 'node_modules/x');

describe('missingDependencyEntry', () => {
  it('main: resolves with Node suffixes, refuses when pruned', () => {
    expect(check(pkg({ main: 'dist/index' }, ['dist/index.js']))).toBeNull();
    expect(check(pkg({ main: 'lib' }, ['lib/index.js']))).toBeNull();
    expect(check(pkg({ main: 'dist/index.js' }))).toBe('node_modules/x/dist/index.js');
  });

  it('exports-only: one concrete code target is enough, none is a refusal', () => {
    const exportsMap = {
      '.': { types: './dist/index.d.ts', import: './dist/esm/index.js', require: './dist/cjs/index.js' },
      './client': { import: './dist/esm/client.js', require: './dist/cjs/client.js' },
    };
    // Root target missing, a subpath present — the @modelcontextprotocol/sdk shape.
    expect(check(pkg({ exports: exportsMap }, ['dist/cjs/client.js']))).toBeNull();
    expect(check(pkg({ exports: exportsMap }, ['dist/index.d.ts']))).toBe('node_modules/x/dist/cjs/index.js');
  });

  it('the require condition decides: a surviving ESM build does not hide a pruned CJS build', () => {
    const exportsMap = { '.': { import: './dist/esm/index.js', require: './dist/cjs/index.js' } };
    expect(check(pkg({ exports: exportsMap }, ['dist/esm/index.js']))).toBe('node_modules/x/dist/cjs/index.js');
    expect(check(pkg({ exports: exportsMap }, ['dist/cjs/index.js']))).toBeNull();
  });

  it('an ESM-only package is checked on its import condition', () => {
    const manifest = { exports: { '.': { import: './index.mjs' } } };
    expect(check(pkg(manifest, ['index.mjs']))).toBeNull();
    expect(check(pkg(manifest))).toBe('node_modules/x/index.mjs');
  });

  it('exports targets must name the file exactly (Node does no index/extension lookup there)', () => {
    expect(check(pkg({ exports: { '.': './dist' } }, ['dist/index.js']))).toBe('node_modules/x/dist');
    expect(check(pkg({ exports: { '.': './dist/index.js' } }, ['dist/index.js']))).toBeNull();
  });

  it('a ./package.json export does not stand in for pruned code', () => {
    const manifest = { exports: { '.': './dist/index.js', './package.json': './package.json' } };
    expect(check(pkg(manifest))).toBe('node_modules/x/dist/index.js');
  });

  it('exports are consulted before main (a stale main does not refuse a working package)', () => {
    expect(check(pkg({ main: 'gone.js', exports: './dist/index.js' }, ['dist/index.js']))).toBeNull();
  });

  it('a stale main falls back to the root index.js, as Node does', () => {
    expect(check(pkg({ main: 'gone.js' }, ['index.js']))).toBeNull();
    expect(check(pkg({ main: 'gone.js' }))).toBe('node_modules/x/gone.js');
  });

  it('no main, no exports: the implicit index.js must exist', () => {
    expect(check(pkg({ name: 'x' }, ['index.js']))).toBeNull();
    expect(check(pkg({ name: 'x' }))).toBe('node_modules/x/index.js');
  });

  it('types-only packages declare no runtime entry', () => {
    expect(check(pkg({ name: '@types/x', types: 'index.d.ts' }, ['index.d.ts']))).toBeNull();
  });

  it('subpath-only exports with no code target declare no root requirement', () => {
    expect(check(pkg({ exports: { './package.json': './package.json' } }))).toBeNull();
  });

  it('an unreadable manifest is a refusal, not a pass', () => {
    expect(check(pkg('{ not json'))).toBe('node_modules/x/package.json (unreadable)');
  });
});

/**
 * `unresolvedFirstPartyRequires` — what the shipped code actually loads.
 *
 * The per-package entry check passes a package while any one subpath survives
 * (it must: `@modelcontextprotocol/sdk` ships a root target that does not
 * exist). Only the requiring code knows which subpath the runtime needs.
 */
describe('unresolvedFirstPartyRequires', () => {
  function archive(sdkFiles: string[]): string {
    const root = path.join(scratch, `a${n++}`);
    const write = (rel: string, body = '') => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), body);
    };
    write(
      'dist/app.js',
      [
        "const server = require('sdk/server');",
        'const client = require("sdk/client");',
        "const fs = require('fs'); const p = require('node:path'); const local = require('./local');",
      ].join('\n'),
    );
    write('dist/local.js');
    write(
      'node_modules/sdk/package.json',
      JSON.stringify({
        exports: {
          '.': { require: './dist/cjs/index.js' },
          './server': { import: './dist/esm/server.js', require: './dist/cjs/server.js' },
          './client': { import: './dist/esm/client.js', require: './dist/cjs/client.js' },
        },
      }),
    );
    for (const file of sdkFiles) write(`node_modules/sdk/${file}`);
    // dependency code is not first-party: its own unresolved requires are not ours to judge
    write('node_modules/sdk/dist/cjs/optional.js', "try { require('not-installed') } catch {}");
    return root;
  }

  it('reports a required subpath whose CJS build was pruned while a sibling subpath survives', () => {
    const root = archive(['dist/cjs/client.js', 'dist/esm/server.js']);
    expect(unresolvedFirstPartyRequires(root)).toEqual(['dist/app.js: sdk/server']);
  });

  it('passes when every required subpath resolves, even if the unused root target is missing', () => {
    const root = archive(['dist/cjs/client.js', 'dist/cjs/server.js']);
    expect(unresolvedFirstPartyRequires(root)).toEqual([]);
  });
});

describe('unresolvedFirstPartyRequires — what the archive deliberately omits', () => {
  it('skips a require of a package the workspace itself declares as a devDependency', () => {
    // packages/test-utils is staged (its dist is a declared entry) but its mock
    // factories `require("vitest")`, which `npm ci --omit=dev` never installs.
    const root = path.join(scratch, `dev${n++}`);
    fs.mkdirSync(path.join(root, 'packages/tu/dist'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'packages/tu/package.json'),
      JSON.stringify({ name: '@x/tu', devDependencies: { vitest: '^4' } }),
    );
    fs.writeFileSync(path.join(root, 'packages/tu/dist/mock.js'), "const { vi } = require('vitest');");
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'root' }));
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist/app.js'), "require('vitest');");
    // the workspace's dev-only import is skipped; the root, which does not declare it, is not
    expect(unresolvedFirstPartyRequires(root)).toEqual(['dist/app.js: vitest']);
  });

  it('does not count a resolution that escapes the archive root', () => {
    const outer = path.join(scratch, `outer${n++}`);
    const root = path.join(outer, 'root');
    fs.mkdirSync(path.join(outer, 'node_modules/escapee'), { recursive: true });
    fs.writeFileSync(path.join(outer, 'node_modules/escapee/index.js'), '');
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist/app.js'), "require('escapee');");
    expect(unresolvedFirstPartyRequires(root)).toEqual(['dist/app.js: escapee']);
  });
});
