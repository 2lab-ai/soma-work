import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
const stageBundleScript = path.join(repoRoot, 'scripts', 'deploy', 'stage-bundle.sh');

// The gate's own inventory, not a second copy of it: the point of the services
// tests below is that the SAME function that fails a stage is the one that
// stops reporting problems once pruning runs. `setup-package.js` is CommonJS on
// purpose (`stage-bundle.sh` spawns it with bare `node`).
const { inventoryProblems } = require('../smoke/setup-package.js') as {
  inventoryProblems: (root: string) => string[];
};

const A2T_WORKER = 'services/a2t/worker.py';
const A2T_REQUIREMENTS = 'services/a2t/requirements.txt';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('deploy bundle contract', () => {
  it('keeps deploy workflow on script-based bundle sync instead of legacy split rsync', () => {
    const workflow = read('.github/workflows/deploy.yml');

    expect(workflow).toContain('npm run smoke:mcp-bins');
    expect(workflow).toContain('npm run smoke:assets');
    expect(workflow).toContain('bash scripts/deploy/stage-bundle.sh');
    expect(workflow).toContain('npm run smoke:deploy-bundle');
    expect(workflow).toContain('scripts/deploy/sync-bundle.sh');
    expect(workflow).toContain('scripts/deploy/install-target.sh');
    expect(workflow).not.toMatch(/rsync\s+-a\s+--delete\s+mcp-servers\//);
    expect(workflow).not.toMatch(/rsync\s+-a\s+--delete\s+somalib\//);
  });

  it('defines the deploy scripts and protected target paths used by bundle sync', () => {
    const requiredFiles = [
      'deploy/protected-paths.txt',
      'scripts/deploy/stage-bundle.sh',
      'scripts/deploy/sync-bundle.sh',
      'scripts/deploy/install-target.sh',
      'scripts/smoke/mcp-bins.js',
      'scripts/smoke/deploy-bundle.js',
    ];

    for (const file of requiredFiles) {
      expect(fs.existsSync(path.join(repoRoot, file)), file).toBe(true);
    }

    const protectedPaths = read('deploy/protected-paths.txt').split(/\r?\n/).filter(Boolean);
    expect(protectedPaths).toEqual(
      expect.arrayContaining([
        '.env',
        '.system.prompt',
        'config.json',
        'mcp-servers.json',
        'data/',
        'logs/',
        '.claude/',
      ]),
    );
  });

  // I-4: the credential/symlink gate used to live only in a SEPARATE npm
  // script, so `bash scripts/deploy/stage-bundle.sh` — which is what both the
  // deploy workflow and the release path run — exited 0 on a tree carrying a
  // planted symlink or token-shaped bytes. The gate is inseparable from
  // staging now, and this pins the wiring; `scripts/smoke/setup-package.js`
  // proves the behaviour against a real staged tree.
  it('runs the staged-artifact security gate as part of staging itself', () => {
    const script = read('scripts/deploy/stage-bundle.sh');

    expect(script).toContain('scripts/smoke/setup-package.js');
    expect(script).toContain('--inventory-only');
    expect(script).toMatch(/setup-package\.js"?\s+--inventory-only\s+"\$STAGE_DIR"/);
    // After the copy list and the layout assertions, not before them.
    expect(script.indexOf('--inventory-only')).toBeGreaterThan(script.indexOf('prune_non_runtime_artifacts\n'));
    expect(script.indexOf('--inventory-only')).toBeGreaterThan(script.indexOf('require_staged_file dist/cli/index.js'));
  });

  it('keeps `npm run stage:bundle` pointed at that script, so the gate cannot be bypassed', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['stage:bundle']).toContain('scripts/deploy/stage-bundle.sh');
    expect(pkg.scripts['smoke:setup-package']).toContain('scripts/smoke/setup-package.js');
  });
});

// ---------------------------------------------------------------------------
// The staged `services/` tree
// ---------------------------------------------------------------------------
//
// `copy_dir services` copies the WORKING TREE, so a developer who has run the
// a2t worker locally stages their `__pycache__` and their `.venv` along with
// the worker. Both are staging failures rather than cosmetic ones: `.pyc` files
// carry NUL bytes (the staged-artifact gate reports "unscannable" and exits 1)
// and a virtualenv is a tree of symlinks out of the runtime root (the gate
// refuses symlinks outright). Before pruning, whether a bundle could be staged
// at all depended on how dirty the checkout was.

/** Every path under `root`, relative and slash-joined, symlinks included. */
function listTree(root: string, base = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, base), { withFileTypes: true })) {
    const rel = base === '' ? entry.name : `${base}/${entry.name}`;
    out.push(rel);
    if (entry.isDirectory()) out.push(...listTree(root, rel));
  }
  return out;
}

/**
 * A staged `services/` tree exactly as a dirty checkout hands it over: real
 * worker payload plus the residue of a local run.
 */
function stageServicesFixture(): string {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-bundle-services-'));
  const write = (rel: string, body: string | Buffer): void => {
    const target = path.join(stageDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  };

  // Runtime payload. Every one of these must survive pruning.
  write(A2T_WORKER, '#!/usr/bin/env python3\nprint("a2t worker")\n');
  write(A2T_REQUIREMENTS, 'faster-whisper==1.0.3\n');
  write('services/a2t/lib/audio_utils.py', 'def resample(frames):\n    return frames\n');

  // Residue: compiled bytecode. The leading bytes are a CPython magic number,
  // and the NUL is what makes the credential scan report it unscannable.
  const bytecode = Buffer.from([0x6f, 0x0d, 0x0d, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x41]);
  write('services/a2t/__pycache__/worker.cpython-311.pyc', bytecode);
  write('services/a2t/lib/__pycache__/audio_utils.cpython-311.pyc', bytecode);
  write('services/a2t/legacy.pyo', bytecode);

  // Residue: local virtualenvs, under both conventional names and at two
  // depths. `bin/python3` is a symlink to an interpreter outside the tree.
  for (const venv of ['services/a2t/.venv', 'services/venv']) {
    write(`${venv}/pyvenv.cfg`, 'home = /opt/homebrew/opt/python@3.11/bin\n');
    write(`${venv}/lib/python3.11/site-packages/faster_whisper/__init__.py`, 'VERSION = "1.0.3"\n');
    fs.mkdirSync(path.join(stageDir, venv, 'bin'), { recursive: true });
    fs.symlinkSync('/opt/homebrew/opt/python@3.11/bin/python3', path.join(stageDir, venv, 'bin', 'python3'));
  }

  return stageDir;
}

/**
 * Run the real `prune_non_runtime_artifacts` against a fixture tree.
 *
 * `STAGE_BUNDLE_LIB=1` makes the script stop after its function definitions —
 * before the `rm -rf "$STAGE_DIR"` that starts a real stage — so this exercises
 * the shipped pruning code rather than a re-implementation of it, without
 * needing a built repo.
 */
function pruneStagedTree(stageDir: string): void {
  execFileSync(
    'bash',
    [
      '-c',
      'set -euo pipefail; STAGE_BUNDLE_LIB=1 . "$1"; STAGE_DIR="$2"; prune_non_runtime_artifacts',
      'bash',
      stageBundleScript,
      stageDir,
    ],
    { stdio: 'pipe' },
  );
}

describe('staged services tree', () => {
  it('prunes local python residue while keeping the worker and its sources', () => {
    const stageDir = stageServicesFixture();
    try {
      const before = listTree(stageDir);
      expect(before).toContain('services/a2t/__pycache__/worker.cpython-311.pyc');
      expect(before).toContain('services/a2t/.venv/bin/python3');

      pruneStagedTree(stageDir);
      const after = listTree(stageDir);

      // Payload survives, including ordinary `.py` source: the rule matches
      // cache/venv shape, never a python file because it is a python file.
      expect(after).toContain(A2T_WORKER);
      expect(after).toContain(A2T_REQUIREMENTS);
      expect(after).toContain('services/a2t/lib/audio_utils.py');

      // Residue is gone, at every depth and under both venv names.
      expect(after.filter((rel) => rel.split('/').includes('__pycache__'))).toEqual([]);
      expect(after.filter((rel) => /\.py[co]$/.test(rel))).toEqual([]);
      expect(after.filter((rel) => rel.split('/').some((part) => part === '.venv' || part === 'venv'))).toEqual([]);
    } finally {
      fs.rmSync(stageDir, { recursive: true, force: true });
    }
  });

  it('turns a residue-carrying services tree from a failing staged artifact into a clean one', () => {
    const stageDir = stageServicesFixture();
    try {
      // Scoped to `services/`: the fixture is a services tree, not a whole
      // bundle, so every other inventory rule has nothing to say about it.
      const before = inventoryProblems(stageDir).filter((problem) => problem.includes('services/'));
      expect(before.some((problem) => problem.includes('forbidden symlink'))).toBe(true);
      expect(before.some((problem) => problem.includes('unscannable'))).toBe(true);

      pruneStagedTree(stageDir);

      expect(inventoryProblems(stageDir).filter((problem) => problem.includes('services/'))).toEqual([]);
    } finally {
      fs.rmSync(stageDir, { recursive: true, force: true });
    }
  });

  // The worker is the program; `requirements.txt` is what the target builds its
  // interpreter environment from. A bundle carrying one without the other is a
  // runtime whose python side cannot be provisioned, so both are inventory
  // requirements rather than files that happen to be copied along.
  it.each([A2T_WORKER, A2T_REQUIREMENTS])('pins %s in the staged inventory, not only in the staging script', (rel) => {
    const stageDir = stageServicesFixture();
    try {
      pruneStagedTree(stageDir);
      expect(inventoryProblems(stageDir)).not.toContain(`missing required staged file: ${rel}`);

      fs.rmSync(path.join(stageDir, rel));
      expect(inventoryProblems(stageDir)).toContain(`missing required staged file: ${rel}`);
    } finally {
      fs.rmSync(stageDir, { recursive: true, force: true });
    }
  });

  it('keeps a local a2t virtualenv out of git, scoped to services rather than repo-wide', () => {
    // `git check-ignore` rather than a substring of `.gitignore`: the question
    // is whether the pattern MATCHES, and a pattern that reads right and matches
    // nothing is the failure mode a text assertion cannot see. These paths need
    // not exist.
    const ignored = (rel: string): boolean =>
      spawnSync('git', ['check-ignore', '-q', rel], { cwd: repoRoot }).status === 0;

    expect(ignored('services/a2t/.venv/bin/python3')).toBe(true);
    expect(ignored('services/venv/pyvenv.cfg')).toBe(true);
    expect(ignored('services/a2t/__pycache__/worker.cpython-311.pyc')).toBe(true);
    expect(ignored('services/a2t/legacy.pyo')).toBe(true);

    // Scope, stated as a contract: the worker is tracked payload, and a
    // virtualenv anywhere else in the repository is somebody else's decision.
    expect(ignored(A2T_WORKER)).toBe(false);
    expect(ignored('.venv/bin/python3')).toBe(false);
  });

  it("keeps upstream's explicit staging assertion and its exact failure message", () => {
    const script = read('scripts/deploy/stage-bundle.sh');

    expect(script).toContain('copy_dir services');
    expect(script).toContain('echo "Missing $1 in staged deploy bundle" >&2');
    for (const rel of [A2T_WORKER, A2T_REQUIREMENTS]) {
      expect(script, rel).toContain(`require_staged_file ${rel}`);
      // The assertion fires on the staged tree, so it must come after pruning.
      expect(script.indexOf(`require_staged_file ${rel}`), rel).toBeGreaterThan(
        script.indexOf('prune_non_runtime_artifacts\n'),
      );
    }
  });
});
