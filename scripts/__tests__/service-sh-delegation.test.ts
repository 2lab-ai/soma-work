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
 *
 * ## Why every run() here is hermetic
 *
 * Half the cases in this file are NEGATIVE cases: the layout must NOT delegate,
 * so the script falls through to the source-tree implementation and really runs
 * `stop` / `status` / `install`. With the ambient environment that implementation
 * resolves `main` to /opt/soma-work/main, the real ~/Library/LaunchAgents and
 * the real `launchctl` — so running this suite on any host that runs the bot
 * killed the live service (observed 2026-09-17 during development: the dev bot
 * died at 14:31 and only KeepAlive brought it back), and `install` wrote a plist
 * and kickstarted the real LaunchAgent.
 *
 * Every run therefore gets the same stand-ins the stop/verify-restart tests use
 * — SOMA_PROJECT_DIR_OVERRIDE, SOMA_PID_FILE_OVERRIDE,
 * SOMA_PROCESS_SCAN_OVERRIDE, a fake `launchctl` on PATH and a temp HOME — and
 * the first test below is a guard that pins it: the fake launchctl, not the
 * host's, is the one `stop` talks to.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SERVICE_SH = path.join(REPO_ROOT, 'scripts', 'service.sh');

let workDir: string;
let host: HostStubs;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'service-sh-delegate-'));
  host = installHostStubs();
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** Everything a non-delegating run would otherwise take from the real host. */
interface HostStubs {
  /** Holds the fake `launchctl` — and deliberately no `somawork`. */
  binDir: string;
  /** One line per fake-launchctl invocation: `"$*"`. */
  launchctlLog: string;
  projectDir: string;
  pidFile: string;
  scan: string;
  home: string;
}

function installHostStubs(): HostStubs {
  const binDir = path.join(workDir, 'host-bin');
  mkdirSync(binDir, { recursive: true });

  // Records its argv (so the guard test can prove it, not /bin/launchctl, ran)
  // and answers the two probes the source-tree path makes: `list` prints
  // nothing (label not registered) and `print <domain>/<label>` fails (no
  // launchd domain holds it), which is the clean-host shape. Everything else
  // is a no-op 0 — nothing here loads, unloads, kickstarts or boots out.
  const launchctlLog = path.join(workDir, 'launchctl-argv.log');
  writeFileSync(launchctlLog, '');
  const launchctl = path.join(binDir, 'launchctl');
  writeFileSync(
    launchctl,
    `#!/bin/bash
printf '%s\\n' "$*" >> "${launchctlLog}"
case "$1" in
  print) exit 1 ;;
  *) exit 0 ;;
esac
`,
  );
  chmodSync(launchctl, 0o755);

  // SOMA_PROCESS_SCAN_OVERRIDE: stands in for the real `lsof -a -d cwd -c node`
  // discovery, reporting nothing — this file tests delegation, not killing.
  const scan = path.join(workDir, 'scan.sh');
  writeFileSync(scan, '#!/bin/bash\n# $1 = PROJECT_DIR. No process discovery in this suite.\nexit 0\n');
  chmodSync(scan, 0o755);

  const home = path.join(workDir, 'home');
  mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });

  return {
    binDir,
    launchctlLog,
    // Not created on purpose: `install` then stops at its PROJECT_DIR existence
    // check, which keeps it off the 25s headless-fallback spawn loop while
    // still proving the thing this file asserts — that it did not delegate.
    projectDir: path.join(workDir, 'project'),
    pidFile: path.join(workDir, 'nonexistent.pid'),
    scan,
    home,
  };
}

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
      env: {
        ...process.env,
        // The stub bin goes AFTER the caller's: a case that wants no controller
        // resolvable passes an empty binDir and must still get fake launchctl.
        PATH: `${binDir}:${host.binDir}:${tail}`,
        HOME: host.home,
        // Without this flag service.sh ignores the three overrides below, and
        // for this suite that would mean a real `main stop` against
        // /opt/soma-work/main — the exact host contact this file exists to
        // prevent.
        SOMA_TEST_HARNESS: '1',
        SOMA_PROJECT_DIR_OVERRIDE: host.projectDir,
        SOMA_PID_FILE_OVERRIDE: host.pidFile,
        SOMA_PROCESS_SCAN_OVERRIDE: host.scan,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? '' };
  }
}

describe('scripts/service.sh — this suite must not touch the host', () => {
  it('runs a non-delegating `main stop` against the fake launchctl and a temp PROJECT_DIR', () => {
    // The dangerous case, pinned: no release marker ⇒ no delegation ⇒ the
    // source-tree `stop` really executes. Before this file was made hermetic
    // that meant real launchctl + /opt/soma-work/main, i.e. stopping the live
    // bot of whoever ran `npx vitest`.
    const { binDir } = installFakeController();
    const target = fleetBundleLayout('guard-bundle');

    const result = run(target, ['main', 'stop'], binDir);

    const calls = readFileSync(host.launchctlLog, 'utf-8').trim().split('\n');
    // cmd_stop's first act is `launchctl list` (capture the supervised PID);
    // bootout_all_domains then probes each domain with `print`.
    expect(calls[0]).toBe('list');
    expect(calls.some((c) => c.startsWith('print '))).toBe(true);
    // Nothing destructive was asked of it.
    expect(calls.some((c) => /^(unload|bootout|kickstart|load) /.test(c))).toBe(false);
    // And the tree it operated on was the temp one, not the deployed root.
    expect(result.stdout).toContain(host.projectDir);
    expect(result.stdout).not.toContain('/opt/soma-work/main');
    expect(result.status).toBe(0);
  });
});

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
