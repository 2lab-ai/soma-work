import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// The adapter and sync tests spawn python3; the 5 s default is too tight on a loaded runner.
vi.setConfig({ testTimeout: 60_000 });

const SKILL_ROOT = resolve(__dirname, '..');
const OMD = resolve(SKILL_ROOT, 'references', 'omd');
const ADAPTER = resolve(SKILL_ROOT, 'scripts', 'designmd_tokens.py');

interface OmdEntry {
  name: string;
  path: string;
  family: string;
  format: string;
  default: boolean;
  source: string;
}

const index = () =>
  JSON.parse(readFileSync(resolve(OMD, 'index.json'), 'utf8')) as {
    upstream: { repo: string; commit: string };
    references: OmdEntry[];
  };
const handKept = () =>
  (
    JSON.parse(readFileSync(resolve(SKILL_ROOT, 'references', 'index.json'), 'utf8')) as {
      references: { name: string }[];
    }
  ).references;

function dirSize(dir: string): number {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : statSync(p).size;
  }
  return total;
}

describe('local:ui-ux — oh-my-design reference set (format design-md-v3)', () => {
  it('vendors every archive reference as omd-<id>, generated from one pinned upstream commit', () => {
    const ix = index();
    expect(ix.upstream.repo).toBe('https://github.com/kwakseongjae/oh-my-design');
    expect(ix.upstream.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(readFileSync(resolve(OMD, 'UPSTREAM'), 'utf8').trim()).toBe(ix.upstream.commit);
    // Pinned upstream c71ca8d has exactly 521 design-md references; a re-sync must update this number.
    if (ix.upstream.commit.startsWith('c71ca8d')) expect(ix.references.length).toBe(521);
    expect(ix.references.length).toBeGreaterThanOrEqual(500);
    const names = ix.references.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    for (const e of ix.references) {
      expect(e.name).toMatch(/^omd-[a-z0-9-]+$/);
      expect(e.family).toBe('oh-my-design');
      expect(e.format).toBe('design-md-v3');
      expect(e.default).toBe(false);
      expect(existsSync(resolve(SKILL_ROOT, e.path)), e.path).toBe(true);
    }
  });

  it('never shadows a hand-kept reference name and adds no bare brand name', () => {
    const omd = new Set(index().references.map((e) => e.name));
    for (const r of handKept()) expect(omd.has(r.name), r.name).toBe(false);
    expect(handKept().some((r) => r.name === 'toss')).toBe(false);
  });

  it('ships tokens only: frontmatter verbatim + an attribution stub, no prose, logos, fonts or sidecars', () => {
    expect(dirSize(OMD)).toBeLessThan(5 * 1024 * 1024);
    for (const id of readdirSync(OMD, { withFileTypes: true }).filter((e) => e.isDirectory())) {
      const files = readdirSync(resolve(OMD, id.name));
      expect(files, id.name).toEqual(['DESIGN.md']);
      const md = readFileSync(resolve(OMD, id.name, 'DESIGN.md'), 'utf8');
      expect(md.startsWith('---\n'), id.name).toBe(true);
      expect(md).toMatch(/Tokens only/);
      expect(md).toMatch(/belongs to /);
      expect(md.split('\n---\n')[1].split('\n').filter(Boolean).length, id.name).toBeLessThanOrEqual(3);
    }
  }, 60_000);

  it('carries the MIT licence, a NOTICE and a per-file sha256 manifest that matches the files', () => {
    expect(readFileSync(resolve(OMD, 'LICENSE'), 'utf8')).toMatch(/MIT License/);
    const notice = readFileSync(resolve(OMD, 'NOTICE.md'), 'utf8');
    expect(notice).toMatch(/oh-my-design/);
    expect(notice).toMatch(/belongs to that company|각 사|own/i);
    const manifest = JSON.parse(readFileSync(resolve(OMD, 'MANIFEST.json'), 'utf8')) as {
      commit: string;
      files: Record<string, string>;
    };
    expect(manifest.commit).toBe(index().upstream.commit);
    const ids = index().references.map((e) => e.path.replace('references/omd/', ''));
    expect(Object.keys(manifest.files).sort()).toEqual(ids.sort());
    for (const [rel, sha] of Object.entries(manifest.files)) {
      expect(
        createHash('sha256')
          .update(readFileSync(resolve(OMD, rel)))
          .digest('hex'),
        rel,
      ).toBe(sha);
    }
  }, 60_000);
});

describe('local:ui-ux — designmd_tokens.py adapter', () => {
  const run = (rel: string) => {
    const r = spawnSync('python3', [ADAPTER, resolve(OMD, rel), '--format', 'json'], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout) as {
      tokens: Record<string, string>;
      provenance: Record<string, { from?: string; derived?: string }>;
      contrast: Record<string, number>;
      fonts: { layers: { family: string; layer: string }[] };
    };
  };

  it('records a source path or a derivation reason for every output token', () => {
    const r = run('toss/DESIGN.md');
    for (const k of Object.keys(r.tokens)) {
      const p = r.provenance[k];
      expect(p, k).toBeDefined();
      expect(Boolean(p.from) !== Boolean(p.derived), k).toBe(true);
    }
    expect(r.provenance['--color-bg'].from).toBe('colors.canvas');
  });

  it('every reference yields text, muted, accent-text and button-label pairs at 4.5:1 or more', () => {
    const script = `
import os, sys, json
sys.path.insert(0, ${JSON.stringify(resolve(SKILL_ROOT, 'scripts'))})
from designmd_tokens import build
root = ${JSON.stringify(OMD)}
bad = []
for d in sorted(os.listdir(root)):
    p = os.path.join(root, d, 'DESIGN.md')
    if os.path.isfile(p):
        r = build(p)
        if min(r['contrast'].values()) < 4.5: bad.append(d)
print(json.dumps(bad))`;
    const r = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([]);
  }, 120_000);

  it('labels font layers: a proprietary brand face is named but not loaded, substitutes are labelled', () => {
    const r = run('toss/DESIGN.md');
    const brand = r.fonts.layers.find((l) => l.layer === 'brand face');
    expect(brand?.family).toBe('Toss Product Sans');
    expect(r.fonts.layers.some((l) => l.layer === 'substitute')).toBe(true);
    // The safe default stays its own layer even when a substitute exists.
    expect(r.fonts.layers.some((l) => l.layer === 'safe default')).toBe(true);
    const order = r.fonts.layers.map((l) => l.layer);
    expect(order.indexOf('brand face')).toBeLessThan(order.indexOf('substitute'));
    expect(order.indexOf('substitute')).toBeLessThan(order.indexOf('safe default'));
  });
});

describe('local:ui-ux — omd sync.py safety', () => {
  it('refuses an upstream that would silently drop vendored references, before touching any file', () => {
    const up = mkdtempSync(resolve(tmpdir(), 'omd-up-'));
    try {
      mkdirSync(resolve(up, 'design-md', 'toss'), { recursive: true });
      writeFileSync(resolve(up, 'LICENSE'), 'MIT License\n');
      writeFileSync(
        resolve(up, 'design-md', 'toss', 'DESIGN.md'),
        "---\nname: Toss\ncolors:\n  primary: '#3182f6'\n---\n",
      );
      const git = (...a: string[]) => spawnSync('git', ['-C', up, ...a], { encoding: 'utf8' });
      git('init', '-q');
      git('add', '-A');
      git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'one');
      const before = readFileSync(resolve(OMD, 'MANIFEST.json'), 'utf8');
      const r = spawnSync('python3', [resolve(OMD, 'sync.py'), up], { encoding: 'utf8' });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/no longer has 520 vendored references/);
      expect(readFileSync(resolve(OMD, 'MANIFEST.json'), 'utf8')).toBe(before);
    } finally {
      rmSync(up, { recursive: true, force: true });
    }
  });

  it('every stub links the prose at the pinned commit, never the mutable site', () => {
    const commit = index().upstream.commit;
    const md = readFileSync(resolve(OMD, 'toss', 'DESIGN.md'), 'utf8');
    expect(md).toContain(`https://github.com/kwakseongjae/oh-my-design/blob/${commit}/design-md/toss/DESIGN.md`);
    expect(md).not.toMatch(/oh-my-design\.kr/);
  });
});
