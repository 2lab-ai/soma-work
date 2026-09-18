/**
 * Contract tests for `scripts/service.sh <env> verify-restart`.
 *
 * Incident 2026-09-17, deploy run 35184945142, target work-m16: the Verify step
 * ran `service.sh main status`, which took the PID out of `launchctl list` —
 * 61554, the process the PREVIOUS deploy had started four hours earlier — and
 * printed "Service is RUNNING". The job went green while the old bundle kept
 * serving. `status` answers "something is alive"; it cannot answer "the thing
 * we just shipped is the thing that is alive".
 *
 * verify-restart answers that with two independent pieces of evidence:
 *   (a) the live PID's start time (`ps -o lstart=`) is at/after --since, the
 *       clock reading the Deploy step took before stopping the old process;
 *   (b) logs/stdout.log carries THIS version's startup line
 *       "⚡️ Claude Code Slack bot is running! [v<version> (<sha>)]"
 *       (src/index.ts:923) with a log timestamp at/after --since.
 *
 * Strategy: fake `launchctl` (which PID is live) + fake `ps` (what start time
 * that PID reports) on PATH, and SOMA_PROJECT_DIR_OVERRIDE pointing logs/ at a
 * temp tree we write by hand. Failing cases pass `--timeout 0` (one poll, no
 * sleep) so the suite does not pay the production 180s socket-connect budget.
 * The overrides are honoured only under SOMA_TEST_HARNESS=1 (one case here
 * pins that gate), so every run sets it explicitly.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SERVICE_SH = path.join(REPO_ROOT, 'scripts', 'service.sh');
const LABEL = 'ai.2lab.soma-work.dev';
const VERSION = '0.26.1';

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'service-sh-verify-test-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** `ps -o lstart=` formatting, for an epoch, in local time (BSD then GNU). */
function lstartFor(epochSeconds: number): string {
  try {
    return execFileSync('date', ['-r', String(epochSeconds), '+%a %b %e %H:%M:%S %Y'], {
      encoding: 'utf-8',
    }).trim();
  } catch {
    return execFileSync('date', ['-d', `@${epochSeconds}`, '+%a %b %e %H:%M:%S %Y'], {
      encoding: 'utf-8',
    }).trim();
  }
}

/** The shared logger's line shape: "[<ISO>] [INFO ] [Index] <message>". */
function startupLine(epochSeconds: number, version: string, sha = 'abc1234'): string {
  const iso = new Date(epochSeconds * 1000).toISOString();
  return `[${iso}] [INFO ] [Index] ⚡️ Claude Code Slack bot is running! [v${version} (${sha})]`;
}

/**
 * Fake `launchctl` (a live PID for the label, or nothing) and fake `ps`
 * (the start time that PID reports). Both are what verify-restart reads;
 * neither is allowed to touch the host.
 */
function installFakes(opts: { livePid?: number; lstart?: string }): string {
  const fakeBin = path.join(workDir, 'bin');
  mkdirSync(fakeBin, { recursive: true });

  // Real tabs: `launchctl list` is tab-separated and get_pid takes awk field 1.
  const listLine = opts.livePid ? `${opts.livePid}\t0\t${LABEL}` : '';
  const launchctl = path.join(fakeBin, 'launchctl');
  writeFileSync(
    launchctl,
    `#!/bin/bash
case "$1" in
  list) ${listLine ? `printf '%s\\n' "${listLine}"` : ':'}; exit 0 ;;
  *) exit 0 ;;
esac
`,
  );
  chmodSync(launchctl, 0o755);

  // `ps -p <pid> -o lstart=` is the only ps call verify-restart makes.
  const ps = path.join(fakeBin, 'ps');
  writeFileSync(ps, `#!/bin/bash\nprintf '%s\\n' "${opts.lstart ?? ''}"\nexit 0\n`);
  chmodSync(ps, 0o755);

  return fakeBin;
}

function writeLog(lines: string[]): string {
  const projectDir = path.join(workDir, 'project');
  mkdirSync(path.join(projectDir, 'logs'), { recursive: true });
  writeFileSync(path.join(projectDir, 'logs', 'stdout.log'), `${lines.join('\n')}\n`);
  return projectDir;
}

function runVerify(
  args: string[],
  extraPath: string,
  projectDir: string,
  opts: { withoutHarnessFlag?: boolean } = {},
): RunResult {
  const homeStub = path.join(workDir, 'home');
  mkdirSync(path.join(homeStub, 'Library', 'LaunchAgents'), { recursive: true });
  const harness = opts.withoutHarnessFlag ? {} : { SOMA_TEST_HARNESS: '1' };
  try {
    const stdout = execFileSync('bash', [SERVICE_SH, 'dev', 'verify-restart', ...args], {
      env: {
        ...process.env,
        PATH: `${extraPath}:${process.env.PATH ?? ''}`,
        HOME: homeStub,
        // Force system-daemon mode OFF for every run in this suite, harness
        // flag or not. The harness gate hides SOMA_SYSTEM_DAEMON_PLIST_OVERRIDE
        // but not the real /Library/LaunchDaemons/<label>.plist, so on a host
        // that actually carries it the withoutHarnessFlag case below would fire
        // `sudo -n /bin/launchctl print system/<label>` at real root from a
        // unit test (and exit 1 before verify-restart ever ran).
        SOMA_LAUNCHD_SYSTEM: '0',
        ...harness,
        SOMA_PROJECT_DIR_OVERRIDE: projectDir,
        SOMA_PID_FILE_OVERRIDE: path.join(workDir, 'nonexistent.pid'),
      },
      encoding: 'utf-8',
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err: any) {
    return {
      status: err.status ?? -1,
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? ''),
    };
  }
}

describe('scripts/service.sh verify-restart — the deploy must prove the restart', () => {
  it('FAILS when the live PID predates --since (the exact 35184945142 false green)', () => {
    const since = Math.floor(Date.now() / 1000);
    // The incident: launchctl reports a live pid started 4 hours ago.
    const bin = installFakes({ livePid: process.pid, lstart: lstartFor(since - 4 * 3600) });
    // The log even carries a matching startup line — from that old start.
    const projectDir = writeLog([startupLine(since + 1, VERSION)]);

    const result = runVerify(['--since', String(since), '--version', VERSION, '--timeout', '0'], bin, projectDir);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/Restart NOT verified/);
    expect(result.stdout).toMatch(/BEFORE --since|OLD process/);
  });

  it('FAILS when the version line predates --since (old start, nothing new logged)', () => {
    const since = Math.floor(Date.now() / 1000);
    const bin = installFakes({ livePid: process.pid, lstart: lstartFor(since + 5) });
    const projectDir = writeLog([startupLine(since - 3600, VERSION)]);

    const result = runVerify(['--since', String(since), '--version', VERSION, '--timeout', '0'], bin, projectDir);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/predates --since/);
  });

  it('FAILS when the running version is not the deployed one', () => {
    const since = Math.floor(Date.now() / 1000);
    const bin = installFakes({ livePid: process.pid, lstart: lstartFor(since + 5) });
    // Fresh restart, but it came up on the previous bundle.
    const projectDir = writeLog([startupLine(since + 6, '0.26.0')]);

    const result = runVerify(['--since', String(since), '--version', VERSION, '--timeout', '0'], bin, projectDir);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/no 'bot is running! \[v0\.26\.1 \(/);
  });

  it('FAILS when there is no live process at all', () => {
    const since = Math.floor(Date.now() / 1000);
    const bin = installFakes({}); // launchctl list prints nothing
    const projectDir = writeLog([startupLine(since + 6, VERSION)]);

    const result = runVerify(['--since', String(since), '--version', VERSION, '--timeout', '0'], bin, projectDir);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/no live process/);
  });

  it('PASSES when both the PID start time and the version line are newer than --since', () => {
    const since = Math.floor(Date.now() / 1000);
    const bin = installFakes({ livePid: process.pid, lstart: lstartFor(since + 5) });
    const projectDir = writeLog([
      startupLine(since - 7200, VERSION), // the previous deploy's line, still in the file
      '[2026-09-17T05:31:20.001Z] [INFO ] [Slack] Slack socket connected',
      startupLine(since + 9, VERSION, 'deadbee'),
    ]);

    const result = runVerify(['--since', String(since), '--version', VERSION, '--timeout', '0'], bin, projectDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Restart verified/);
    // The matched evidence line must be printed, not just asserted about.
    expect(result.stdout).toContain(`[v${VERSION} (deadbee)]`);
  });

  it('accepts the tag form of --version (v-prefixed)', () => {
    const since = Math.floor(Date.now() / 1000);
    const bin = installFakes({ livePid: process.pid, lstart: lstartFor(since + 5) });
    const projectDir = writeLog([startupLine(since + 9, VERSION)]);

    const result = runVerify(['--since', String(since), '--version', `v${VERSION}`, '--timeout', '0'], bin, projectDir);

    expect(result.status).toBe(0);
  });

  it('waits 180s by default — measured cold starts on fable took 88–129s to log the line', () => {
    // The old 60s default was shorter than a measured cold start, so a deploy
    // that DID restart correctly would fail its own verification.
    const since = Math.floor(Date.now() / 1000);
    const bin = installFakes({ livePid: process.pid, lstart: lstartFor(since + 5) });
    const projectDir = writeLog([startupLine(since + 9, VERSION)]);

    // No --timeout: the banner prints the default before the first poll, and
    // this fixture satisfies both conditions immediately so nothing is waited on.
    const result = runVerify(['--since', String(since), '--version', VERSION], bin, projectDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/timeout 180s/);
  });

  it('parses a `ps -o lstart=` day that is space-padded ("Sep  3")', () => {
    // BSD ps pads single-digit days with a space, so the string carries a
    // double space that the date parser must not choke on — otherwise every
    // deploy on days 1–9 reports "could not read start time".
    const epoch = Math.floor(new Date(2026, 8, 3, 1, 2, 3).getTime() / 1000);
    const lstart = lstartFor(epoch);
    expect(lstart).toContain('Sep  3'); // the fixture must really be padded
    const bin = installFakes({ livePid: process.pid, lstart });
    const projectDir = writeLog([startupLine(epoch + 1, VERSION)]);

    const result = runVerify(['--since', String(epoch - 5), '--version', VERSION, '--timeout', '0'], bin, projectDir);

    expect(result.stdout).not.toMatch(/could not read start time/);
    expect(result.status).toBe(0);
  });

  it('ignores the test-only overrides unless SOMA_TEST_HARNESS=1 is set', () => {
    // The overrides repoint PROJECT_DIR (and with it the process scan that
    // `stop` kills from) at a temp tree. A stray export in an operator's shell
    // must not silently redirect a production command at that tree; the flag is
    // what makes the redirect deliberate.
    const since = Math.floor(Date.now() / 1000);
    const bin = installFakes({});
    const projectDir = writeLog([startupLine(since + 9, VERSION)]);

    const result = runVerify(['--since', String(since), '--version', VERSION, '--timeout', '0'], bin, projectDir, {
      withoutHarnessFlag: true,
    });

    expect(result.status).not.toBe(0);
    // The real env path, not the override: proof the override was ignored.
    expect(result.stdout).toContain('/opt/soma-work/dev/logs/stdout.log');
    expect(result.stdout).not.toContain(projectDir);
    expect(result.stderr).toMatch(/SOMA_TEST_HARNESS/);
  });

  it('refuses to run without --since / --version instead of vacuously passing', () => {
    const since = Math.floor(Date.now() / 1000);
    const bin = installFakes({ livePid: process.pid, lstart: lstartFor(since + 5) });
    const projectDir = writeLog([startupLine(since + 9, VERSION)]);

    const noSince = runVerify(['--version', VERSION], bin, projectDir);
    expect(noSince.status).not.toBe(0);
    expect(noSince.stdout).toMatch(/requires --since/);

    const noVersion = runVerify(['--since', String(since)], bin, projectDir);
    expect(noVersion.status).not.toBe(0);
    expect(noVersion.stdout).toMatch(/requires --version/);
  });
});
