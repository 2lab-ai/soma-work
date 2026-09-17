/**
 * Contract tests for `scripts/service.sh <env> stop`.
 *
 * Incident 2026-09-17, deploy run 35184945142, target work-m16:
 *   1. the Deploy step ran `service.sh main stop || true`;
 *   2. stop printed "Failed to stop service via LaunchAgent" — the label was
 *      registered in more than one launchd domain, so `launchctl unload
 *      <plist>` in the runner's session removed at most one registration and
 *      KeepAlive respawned the rest;
 *   3. the pidfile fallback matched nothing, so the supervisor tree from the
 *      PREVIOUS deploy (pid 61554, 4h old) kept running;
 *   4. `|| true` swallowed the failure and the Verify step then read that old
 *      pid out of `launchctl list` and reported "Service is RUNNING".
 * The job went green with the old code serving.
 *
 * The contracts pinned here:
 *   - a failed LaunchAgent unload is NOT the end of stop — it falls through and
 *     kills every live process whose cwd is $PROJECT_DIR;
 *   - stop exits non-zero when a process it targeted is still alive;
 *   - stop exits non-zero when a launchd domain still holds the label
 *     (`system/<label>` needs sudo — the deploy must fail loudly, not silently);
 *   - a clean host (nothing registered, nothing running) still exits 0, because
 *     deploy.yml no longer has `|| true`.
 *
 * Strategy follows service-sh-status.test.ts / service-sh-start.test.ts: a fake
 * `launchctl` on PATH plus the script's hermetic override envs
 * (SOMA_PID_FILE_OVERRIDE, SOMA_PROJECT_DIR_OVERRIDE,
 * SOMA_PROCESS_SCAN_OVERRIDE). No real launchd, no real process discovery.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SERVICE_SH = path.join(REPO_ROOT, 'scripts', 'service.sh');
const LABEL = 'ai.2lab.soma-work.dev';

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

let workDir: string;
const victims: number[] = [];

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'service-sh-stop-test-'));
});

afterEach(() => {
  for (const pid of victims.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  rmSync(workDir, { recursive: true, force: true });
});

interface LaunchctlOptions {
  /** Line `launchctl list` prints for the label; empty = not registered. */
  listLine?: string;
  /** `unload` exit code — 1 reproduces the incident's failed unload. */
  unloadExit?: number;
  /** Domains for which `launchctl print <domain>/<label>` succeeds. */
  heldDomains?: string[];
  /** Domains whose `bootout` fails and leaves the registration in place. */
  stickyDomains?: string[];
}

/**
 * Fake `launchctl` covering the four subcommands stop uses: list, unload,
 * print (domain probe) and bootout. A domain listed in `heldDomains` answers
 * `print` with 0; `bootout` drops it from the held set unless it is sticky
 * (the `system` domain without root).
 */
function installFakeLaunchctl(opts: LaunchctlOptions = {}): string {
  const fakeBin = path.join(workDir, 'bin');
  mkdirSync(fakeBin, { recursive: true });
  const heldDir = path.join(workDir, 'held');
  mkdirSync(heldDir, { recursive: true });

  const uid = process.getuid?.() ?? 0;
  const expand = (d: string) => d.replace('<uid>', String(uid));
  const held = (opts.heldDomains ?? []).map(expand);
  const sticky = (opts.stickyDomains ?? []).map(expand);
  // Domain names contain '/', so flatten them into marker file names.
  const marker = (domain: string) => path.join(heldDir, domain.replace(/\//g, '_'));
  for (const domain of held) writeFileSync(marker(domain), '');

  const script = `#!/bin/bash
HELD_DIR="${heldDir}"
STICKY="${sticky.join(' ')}"
marker() { printf '%s/%s' "$HELD_DIR" "\${1//\\//_}"; }
case "$1" in
  list)
    ${opts.listLine ? `printf '%s\\n' "${opts.listLine.replace(/"/g, '\\"')}"` : ':'}
    exit 0
    ;;
  unload)
    exit ${opts.unloadExit ?? 0}
    ;;
  print)
    target="$2"                 # <domain>/<label>
    domain="\${target%/*}"
    [[ -f "$(marker "$domain")" ]] && exit 0
    echo "Could not find service \\"$target\\"" >&2
    exit 113
    ;;
  bootout)
    target="$2"
    domain="\${target%/*}"
    for s in $STICKY; do
      if [[ "$s" == "$domain" ]]; then
        echo "Boot-out failed: 1: Operation not permitted" >&2
        exit 1
      fi
    done
    rm -f "$(marker "$domain")"
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`;
  const launchctl = path.join(fakeBin, 'launchctl');
  writeFileSync(launchctl, script);
  chmodSync(launchctl, 0o755);
  return fakeBin;
}

/**
 * Fake process scan (SOMA_PROCESS_SCAN_OVERRIDE): stands in for the real
 * `lsof -a -d cwd -c node` discovery. `livePid` mode mirrors lsof semantics —
 * a pid is only listed while it is actually alive, so the post-kill re-scan
 * goes empty once stop did its job. `always` mode simulates a survivor
 * (e.g. KeepAlive respawning from another domain).
 */
function installScanOverride(pids: number[], mode: 'while-alive' | 'always'): string {
  const scan = path.join(workDir, 'scan.sh');
  const body =
    mode === 'while-alive'
      ? pids.map((p) => `kill -0 ${p} 2>/dev/null && echo ${p}`).join('\n')
      : pids.map((p) => `echo ${p}`).join('\n');
  writeFileSync(scan, `#!/bin/bash\n# $1 = PROJECT_DIR\n${body}\nexit 0\n`);
  chmodSync(scan, 0o755);
  return scan;
}

function runStop(extraPath: string, extraEnv: Record<string, string> = {}): RunResult {
  const homeStub = path.join(workDir, 'home');
  mkdirSync(path.join(homeStub, 'Library', 'LaunchAgents'), { recursive: true });
  const projectDir = path.join(workDir, 'project');
  mkdirSync(path.join(projectDir, 'data'), { recursive: true });
  try {
    const stdout = execFileSync('bash', [SERVICE_SH, 'dev', 'stop'], {
      env: {
        ...process.env,
        PATH: `${extraPath}:${process.env.PATH ?? ''}`,
        HOME: homeStub,
        SOMA_PROJECT_DIR_OVERRIDE: projectDir,
        SOMA_PID_FILE_OVERRIDE: path.join(workDir, 'nonexistent.pid'),
        ...extraEnv,
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

/**
 * A real, killable process standing in for a stray supervisor tree.
 *
 * It is deliberately a GRANDchild (the `sh` that launches it exits at once, so
 * the sleeper is reparented to init): a direct child of the test process would
 * linger as an unreaped zombie after the kill, and `kill -0` on a zombie still
 * succeeds — the assertions would read "still alive" for a process stop had
 * already killed.
 */
function spawnVictim(): number {
  const out = execFileSync('/bin/sh', ['-c', 'nohup sleep 300 >/dev/null 2>&1 & echo $!'], {
    encoding: 'utf-8',
  });
  const pid = Number(out.trim());
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`failed to spawn victim process: ${out}`);
  victims.push(pid);
  return pid;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('scripts/service.sh stop — a failed unload is not the end of stop', () => {
  it('kills a live process under $PROJECT_DIR even when the LaunchAgent unload fails', () => {
    // Incident shape: registered (dead PID column), unload fails, and a
    // supervisor tree from the previous deploy is still running.
    const bin = installFakeLaunchctl({ listLine: `-\t0\t${LABEL}`, unloadExit: 1 });
    const victim = spawnVictim();
    const scan = installScanOverride([victim], 'while-alive');

    const result = runStop(bin, { SOMA_PROCESS_SCAN_OVERRIDE: scan });

    expect(isAlive(victim)).toBe(false);
    expect(result.stdout).toMatch(new RegExp(`pid=${victim}`));
    expect(result.status).toBe(0);
  });

  it('exits non-zero when a targeted process is still alive afterwards', () => {
    // A pid the scan keeps reporting after the kill attempt — what KeepAlive
    // respawning from a second launchd domain looks like to stop.
    const bin = installFakeLaunchctl({ listLine: `-\t0\t${LABEL}`, unloadExit: 1 });
    const scan = installScanOverride([999999], 'always');

    const result = runStop(bin, { SOMA_PROCESS_SCAN_OVERRIDE: scan });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/still-live process\(es\)/i);
    expect(result.stdout).toContain('999999');
  });

  it('exits non-zero when a launchd domain still holds the label (multi-domain refusal)', () => {
    // `launchctl print system/<label>` showed a live pid on work-m16: the label
    // was registered in a second domain that the session's plist unload never
    // touched, and only root can boot the system domain out.
    const bin = installFakeLaunchctl({
      listLine: '',
      heldDomains: ['system', 'gui/<uid>'],
      stickyDomains: ['system'],
    });
    const scan = installScanOverride([], 'while-alive');

    const result = runStop(bin, { SOMA_PROCESS_SCAN_OVERRIDE: scan });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(`system/${LABEL}`);
    expect(result.stdout).toMatch(/still registered in/i);
    // The removable domain must actually have been booted out, so the operator
    // is told about the ONE domain that refused, not all of them.
    expect(result.stdout).not.toMatch(new RegExp(`still registered in:.*gui/\\d+/${LABEL.replace(/\./g, '\\.')}`));
    expect(result.stdout).toMatch(/sudo launchctl bootout system/);
  });

  it('kills a process recorded only in the PID lock file', () => {
    const bin = installFakeLaunchctl({ listLine: '' });
    const victim = spawnVictim();
    const pidFile = path.join(workDir, 'soma-work.pid');
    writeFileSync(pidFile, `${victim}:1781668755147`);
    const scan = installScanOverride([], 'while-alive');

    const result = runStop(bin, {
      SOMA_PID_FILE_OVERRIDE: pidFile,
      SOMA_PROCESS_SCAN_OVERRIDE: scan,
    });

    expect(isAlive(victim)).toBe(false);
    expect(result.status).toBe(0);
  });

  it('clean host: nothing registered, nothing running → exit 0 (deploy.yml dropped `|| true`)', () => {
    const bin = installFakeLaunchctl({ listLine: '' });
    const scan = installScanOverride([], 'while-alive');

    const result = runStop(bin, { SOMA_PROCESS_SCAN_OVERRIDE: scan });

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/no live process/i);
  });
});
