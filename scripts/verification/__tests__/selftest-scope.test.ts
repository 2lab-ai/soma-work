/**
 * Checks on `scripts/verification/selftest-scope.sh`, which decides whether Lean Verify runs the
 * gate's `--selftest` for an event.
 *
 * The self-test exercises the gate (scripts/verification/, the Lean tree under verification/, the
 * Lean workflow), so a pull request that touches none of those skips it; a push, or any doubt
 * about the diff, runs it. Each case builds a throwaway git repository with a base commit and a
 * head commit and runs the script there with the same environment the workflow gives it.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const script = path.join(repoRoot, 'scripts/verification/selftest-scope.sh');

const dirs: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
    },
  }).trim();
}

/** A repository whose HEAD changes `changed` relative to the returned base SHA. */
function repoWithChange(changed: string[]): { dir: string; base: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selftest-scope-'));
  dirs.push(dir);
  git(dir, 'init', '--quiet');
  fs.writeFileSync(path.join(dir, 'README.md'), 'base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '--quiet', '-m', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  for (const file of changed) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), 'changed\n');
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '--quiet', '--allow-empty', '-m', 'head');
  return { dir, base };
}

function scope(cwd: string, env: Record<string, string>): { verdict: string; stdout: string; output: string } {
  const outputFile = path.join(cwd, '.github-output');
  fs.rmSync(outputFile, { force: true });
  const result = spawnSync('bash', [script], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GITHUB_OUTPUT: outputFile, ...env },
  });
  expect(result.status, result.stderr).toBe(0);
  const output = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8') : '';
  const verdict = output.match(/^selftest=(true|false)$/m)?.[1] ?? '';
  return { verdict, stdout: result.stdout, output };
}

afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

// Each case spawns several git processes; on a loaded host that exceeds vitest's 5 s default.
describe('selftest-scope.sh', { timeout: 30_000 }, () => {
  it('runs the self-test on a push, whatever changed', () => {
    const { dir, base } = repoWithChange(['src/app.ts']);
    expect(scope(dir, { EVENT_NAME: 'push', BASE_SHA: base }).verdict).toBe('true');
  });

  it('skips the self-test for a pull request that touches no gate input', () => {
    const { dir, base } = repoWithChange(['src/app.ts', 'packages/slack/src/x.ts', '.github/workflows/ci.yml']);
    const result = scope(dir, { EVENT_NAME: 'pull_request', BASE_SHA: base });
    expect(result.verdict).toBe('false');
    expect(result.output).toBe('selftest=false\n');
  });

  it.each([
    'verification/lean/SomaVerify/ToolPolicy/Model.lean',
    'verification/lean/lean-toolchain',
    'verification/vectors/tool-policy.json',
    'scripts/verification/lean-verify.sh',
    'scripts/verification/extract-import-graph.cjs',
    '.github/workflows/lean-verify.yml',
  ])('runs the self-test for a pull request that changes %s', (file) => {
    const { dir, base } = repoWithChange(['src/app.ts', file]);
    const result = scope(dir, { EVENT_NAME: 'pull_request', BASE_SHA: base });
    expect(result.verdict).toBe('true');
    expect(result.stdout).toContain(file);
  });

  it('runs the self-test when a gate file is moved out of verification/ or deleted', () => {
    // Rename detection would report only the new path (outside the gate) for a move; the diff
    // must see the deletion under verification/ as well.
    const seed = 'theorem probe : True := trivial\n'.repeat(40);
    const moved = repoWithChange([]);
    fs.mkdirSync(path.join(moved.dir, 'verification/lean'), { recursive: true });
    fs.writeFileSync(path.join(moved.dir, 'verification/lean/Probe.lean'), seed);
    git(moved.dir, 'add', '-A');
    git(moved.dir, 'commit', '--quiet', '-m', 'seed');
    const base = git(moved.dir, 'rev-parse', 'HEAD');
    fs.mkdirSync(path.join(moved.dir, 'src'), { recursive: true });
    git(moved.dir, 'mv', 'verification/lean/Probe.lean', 'src/Probe.lean');
    git(moved.dir, 'commit', '--quiet', '-m', 'move');
    expect(scope(moved.dir, { EVENT_NAME: 'pull_request', BASE_SHA: base }).verdict).toBe('true');

    git(moved.dir, 'rm', '--quiet', 'src/Probe.lean');
    git(moved.dir, 'commit', '--quiet', '-m', 'drop');
    expect(scope(moved.dir, { EVENT_NAME: 'pull_request', BASE_SHA: base }).verdict).toBe('true');
  });

  it('runs the self-test when the diff itself fails after the base was found', () => {
    // A `git` that resolves the base like the real one but fails `git diff`.
    const { dir, base } = repoWithChange(['src/app.ts']);
    const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const bin = path.join(dir, '.stub-bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, 'git'),
      `#!/bin/sh\nif [ "$1" = diff ]; then echo "fatal: simulated" >&2; exit 128; fi\nexec "${realGit}" "$@"\n`,
      { mode: 0o755 },
    );
    const result = scope(dir, {
      EVENT_NAME: 'pull_request',
      BASE_SHA: base,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
    });
    expect(result.verdict).toBe('true');
    expect(result.stdout).toContain('diff against');
  });

  it('does not mistake a look-alike path for a gate input', () => {
    const { dir, base } = repoWithChange(['src/verification/notes.ts', 'docs/scripts/verification/x.md']);
    expect(scope(dir, { EVENT_NAME: 'pull_request', BASE_SHA: base }).verdict).toBe('false');
  });

  it('runs the self-test when the base SHA is missing', () => {
    const { dir } = repoWithChange(['src/app.ts']);
    expect(scope(dir, { EVENT_NAME: 'pull_request', BASE_SHA: '' }).verdict).toBe('true');
  });

  it('runs the self-test when the base commit cannot be found or fetched', () => {
    const { dir } = repoWithChange(['src/app.ts']);
    const result = scope(dir, { EVENT_NAME: 'pull_request', BASE_SHA: 'f'.repeat(40) });
    expect(result.verdict).toBe('true');
    expect(result.stdout).toContain('not fetchable');
  });
});
