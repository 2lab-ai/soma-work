/**
 * Transitional contract for `scripts/service.sh` (Task 9).
 *
 * Two plist generators for the same machine is the failure mode this guards
 * against. Once a profile is *installed* (Homebrew payload, no source tree),
 * the TypeScript controller owns the LaunchAgent; the shell script must hand
 * the request over rather than write a second, `/opt`-centric plist beside it.
 *
 * The source-tree implementation survives untouched for an actual checkout —
 * that is what a developer running `./scripts/service.sh dev start` from the
 * repo still gets, and what Tasks 10/11 will validate before it is deleted.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SERVICE_SH = path.join(REPO_ROOT, 'scripts', 'service.sh');

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'service-sh-delegate-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** A `somawork` on PATH that records its argv instead of doing anything. */
function installFakeController(): { binDir: string; argvLog: string } {
  const binDir = path.join(workDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const argvLog = path.join(workDir, 'somawork-argv.log');
  writeFileSync(argvLog, '');
  const somawork = path.join(binDir, 'somawork');
  writeFileSync(somawork, `#!/bin/bash\nprintf '%s\\n' "$*" >> "${argvLog}"\nexit 0\n`);
  chmodSync(somawork, 0o755);
  return { binDir, argvLog };
}

/**
 * A Homebrew-style installed runtime root.
 *
 * The discriminator is the release marker `.somawork-package.json`, which
 * `scripts/release/package-somawork.sh` writes into every runtime payload and
 * `scripts/deploy/stage-bundle.sh` never writes. Building the fixture without it
 * would be building a fleet bundle, not an installed root.
 */
function installedLayout(name = 'installed'): string {
  const root = path.join(workDir, name);
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  mkdirSync(path.join(root, 'dist'), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), '{"name":"soma-work"}');
  writeFileSync(
    path.join(root, '.somawork-package.json'),
    JSON.stringify({ schemaVersion: 1, package: 'somawork', profile: 'production' }),
  );
  const target = path.join(root, 'scripts', 'service.sh');
  copyFileSync(SERVICE_SH, target);
  chmodSync(target, 0o755);
  return target;
}

/**
 * The fleet deploy bundle: `stage-bundle.sh` output.
 *
 * `package.json` and `dist/`, no `src/`, and — the load-bearing part — **no
 * release marker**.
 */
function fleetBundleLayout(name = 'fleet-bundle'): string {
  const root = path.join(workDir, name);
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  mkdirSync(path.join(root, 'dist'), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), '{"name":"soma-work"}');
  const target = path.join(root, 'scripts', 'service.sh');
  copyFileSync(SERVICE_SH, target);
  chmodSync(target, 0o755);
  return target;
}

function run(
  script: string,
  args: string[],
  binDir: string,
  opts: { restrictPath?: boolean } = {},
): { status: number; stdout: string } {
  const tail = opts.restrictPath ? '/usr/bin:/bin:/usr/sbin:/sbin' : (process.env.PATH ?? '');
  try {
    const stdout = execFileSync('bash', [script, ...args], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${binDir}:${tail}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? '' };
  }
}

describe('scripts/service.sh — installed-profile delegation', () => {
  it('maps dev to the preview profile and delegates exactly once', () => {
    const { binDir, argvLog } = installFakeController();
    const script = installedLayout();
    run(script, ['dev', 'status'], binDir);
    const calls = readFileSync(argvLog, 'utf-8').trim().split('\n');
    expect(calls).toEqual(['service status --profile preview']);
  });

  it('maps main to the production profile', () => {
    const { binDir, argvLog } = installFakeController();
    const script = installedLayout();
    run(script, ['main', 'restart'], binDir);
    expect(readFileSync(argvLog, 'utf-8').trim()).toBe('service restart --profile production');
  });

  it('delegates every public service action', () => {
    const { binDir, argvLog } = installFakeController();
    const script = installedLayout();
    for (const action of ['install', 'start', 'stop', 'restart', 'status']) {
      run(script, ['dev', action], binDir);
    }
    const calls = readFileSync(argvLog, 'utf-8').trim().split('\n');
    expect(calls).toEqual([
      'service install --profile preview',
      'service start --profile preview',
      'service stop --profile preview',
      'service restart --profile preview',
      'service status --profile preview',
    ]);
  });

  it('does not delegate a command outside the controller surface', () => {
    const { binDir } = installFakeController();
    const script = installedLayout();
    const result = run(script, ['dev', 'logs'], binDir);
    expect(result.status).not.toBe(127);
    expect(readFileSync(path.join(workDir, 'somawork-argv.log'), 'utf-8').trim()).toBe('');
  });

  it('keeps the source-tree implementation for an actual checkout', () => {
    const { binDir, argvLog } = installFakeController();
    // The real repo: package.json + src/ present.
    run(SERVICE_SH, ['dev', 'status'], binDir);
    expect(readFileSync(argvLog, 'utf-8').trim()).toBe('');
  });

  it('does not delegate when no controller is resolvable', () => {
    const binDir = path.join(workDir, 'empty-bin');
    mkdirSync(binDir, { recursive: true });
    const script = installedLayout();
    const result = run(script, ['dev', 'status'], binDir, { restrictPath: true });
    // Falls through to the source-tree status path, which reports STOPPED.
    expect(result.stdout).toContain('Service');
  });
});

describe('scripts/service.sh — installed payload shapes (M12)', () => {
  it('does NOT delegate from a fleet deploy bundle, even with a controller on PATH', () => {
    // The regression this pins. The old test was "package.json and no src/ ⇒
    // installed", which is exactly the shape `stage-bundle.sh` produces — so on
    // any host where `somawork` was also on PATH (the self-hosted runner runs
    // both the fleet deploy and the release workflow), the fleet's own `stop`,
    // `status` and `install` would operate on the Homebrew profile instead:
    // stopping the wrong daemon before an rsync, and verifying a deploy against
    // a service that was never deployed to.
    const { binDir, argvLog } = installFakeController();
    const target = fleetBundleLayout();

    for (const command of ['stop', 'status', 'install']) {
      run(target, ['main', command], binDir);
    }
    expect(readFileSync(argvLog, 'utf-8').trim()).toBe('');
  });

  it('delegates from an installed runtime root, which carries the release marker', () => {
    const { binDir, argvLog } = installFakeController();
    const target = installedLayout('payload-marked');

    run(target, ['main', 'status'], binDir);
    expect(readFileSync(argvLog, 'utf-8').trim()).toBe('service status --profile production');
  });

  it('treats the marker as the whole discriminator, not the absence of src/', () => {
    const { binDir, argvLog } = installFakeController();
    // A tree with BOTH a source directory and the marker still delegates: the
    // marker says it came out of a release archive, and nothing else does.
    const target = installedLayout('payload-marked-with-src');
    mkdirSync(path.join(path.dirname(path.dirname(target)), 'payload-marked-with-src', 'src'), { recursive: true });
    run(target, ['dev', 'start'], binDir);
    expect(readFileSync(argvLog, 'utf-8').trim()).toBe('service start --profile preview');
  });

  it('does not delegate from a source checkout', () => {
    const { binDir, argvLog } = installFakeController();
    const root = path.join(workDir, 'checkout');
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, 'package.json'), '{"name":"soma-work"}');
    const target = path.join(root, 'scripts', 'service.sh');
    copyFileSync(SERVICE_SH, target);
    chmodSync(target, 0o755);

    run(target, ['dev', 'start'], binDir);
    expect(readFileSync(argvLog, 'utf-8').trim()).toBe('');
  });
});
