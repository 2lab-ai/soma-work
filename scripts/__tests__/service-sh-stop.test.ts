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
 *     deploy.yml no longer has `|| true`;
 *   - a domain that is merely still TERMINATING is waited out, not called stuck;
 *   - a stray-process scan that cannot run fails the stop instead of passing it.
 *
 * Strategy follows service-sh-status.test.ts / service-sh-start.test.ts: a fake
 * `launchctl` on PATH plus the script's hermetic override envs
 * (SOMA_PID_FILE_OVERRIDE, SOMA_PROJECT_DIR_OVERRIDE,
 * SOMA_PROCESS_SCAN_OVERRIDE), which service.sh honours only under
 * SOMA_TEST_HARNESS=1. Two cases deliberately drop the scan override and drive
 * a fake `lsof`/`ps` instead, because the parsing they pin (cwd comparison,
 * argv read) is what the override short-circuits. No real launchd, no real
 * process discovery.
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
  /**
   * A domain whose job is still TERMINATING: `print` answers 0 for the first
   * `probes` calls and 113 ("Could not find service") afterwards, and `bootout`
   * returns non-zero because launchd is already tearing the job down. This is
   * what a healthy host looks like while the supervisor works through its
   * 4s shutdown grace (src/run-with-rotating-logs.ts:631).
   */
  terminatingDomain?: { domain: string; probes: number };
  /**
   * A domain whose `print <domain>/<label>` answers with a real job dictionary
   * carrying `pid = N` (that is where get_pid reads a pid launchd never put in
   * `launchctl list` — the headless `user/<uid>` case). Only applies while the
   * domain is still held.
   */
  domainPid?: { domain: string; pid: number };
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

  const terminating = opts.terminatingDomain
    ? { domain: expand(opts.terminatingDomain.domain), probes: opts.terminatingDomain.probes }
    : undefined;
  const counterFile = path.join(workDir, 'print-probes');

  const pidDomain = opts.domainPid ? expand(opts.domainPid.domain) : '';

  const script = `#!/bin/bash
HELD_DIR="${heldDir}"
STICKY="${sticky.join(' ')}"
TERMINATING="${terminating?.domain ?? ''}"
TERMINATING_PROBES="${terminating?.probes ?? 0}"
COUNTER="${counterFile}"
PID_DOMAIN="${pidDomain}"
PID_VALUE="${opts.domainPid?.pid ?? ''}"
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
    if [[ -n "$TERMINATING" && "$domain" == "$TERMINATING" ]]; then
      n=$(cat "$COUNTER" 2>/dev/null || echo 0)
      n=$((n + 1))
      printf '%s\\n' "$n" > "$COUNTER"
      [[ "$n" -le "$TERMINATING_PROBES" ]] && exit 0
      echo "Could not find service \\"$target\\"" >&2
      exit 113
    fi
    if [[ -f "$(marker "$domain")" ]]; then
      if [[ -n "$PID_DOMAIN" && "$domain" == "$PID_DOMAIN" ]]; then
        printf '%s\\n' "${LABEL} = {" "\tstate = running" "\tpid = $PID_VALUE" "}"
      fi
      exit 0
    fi
    echo "Could not find service \\"$target\\"" >&2
    exit 113
    ;;
  bootout)
    target="$2"
    domain="\${target%/*}"
    if [[ -n "$TERMINATING" && "$domain" == "$TERMINATING" ]]; then
      # launchd is already tearing the job down; bootout says so and fails.
      echo "Boot-out failed: 36: Operation now in progress" >&2
      exit 36
    fi
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

interface StopOptions {
  /** $PROJECT_DIR for this run (default: a fresh temp tree). */
  projectDir?: string;
  /**
   * PATH tail appended after the fake bin. `/usr/sbin` is deliberately
   * omissible: that is where macOS keeps `lsof`, so leaving it out is how the
   * "scan tool missing" case is reproduced without touching the host.
   */
  pathTail?: string;
}

function runStop(extraPath: string, extraEnv: Record<string, string> = {}, opts: StopOptions = {}): RunResult {
  const homeStub = path.join(workDir, 'home');
  mkdirSync(path.join(homeStub, 'Library', 'LaunchAgents'), { recursive: true });
  const projectDir = opts.projectDir ?? path.join(workDir, 'project');
  mkdirSync(path.join(projectDir, 'data'), { recursive: true });
  try {
    const stdout = execFileSync('bash', [SERVICE_SH, 'dev', 'stop'], {
      env: {
        ...process.env,
        PATH: `${extraPath}:${opts.pathTail ?? process.env.PATH ?? ''}`,
        HOME: homeStub,
        // The overrides below are inert unless the harness flag is set
        // (service.sh resolve_env) — a production shell that happens to carry
        // them must still operate on the real tree.
        SOMA_TEST_HARNESS: '1',
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
 * Fake `lsof` + `ps` standing in for REAL process discovery (no
 * SOMA_PROCESS_SCAN_OVERRIDE), so the tests can exercise the parsing that the
 * override short-circuits: the cwd comparison and the argv filter.
 *
 * `lsof` prints the `-Fpn` pair for `pid` — with `cwd` as the *resolved*
 * (physical) path, which is what the real lsof reports — and only while that
 * pid is alive, so a re-scan after a successful kill comes back empty.
 * `ps` logs its own argv (the `-ww` assertion reads that log) and answers with
 * a supervisor-shaped command line.
 */
function installFakeLsof(pid: number, reportedCwd: string): { bin: string; psLog: string } {
  const fakeBin = path.join(workDir, 'bin');
  mkdirSync(fakeBin, { recursive: true });
  const psLog = path.join(workDir, 'ps-argv.log');
  writeFileSync(psLog, '');

  const lsof = path.join(fakeBin, 'lsof');
  writeFileSync(
    lsof,
    `#!/bin/bash
if kill -0 ${pid} 2>/dev/null; then
  printf 'p%s\\nn%s\\n' "${pid}" "${reportedCwd}"
  exit 0
fi
exit 1
`,
  );
  chmodSync(lsof, 0o755);

  const ps = path.join(fakeBin, 'ps');
  writeFileSync(
    ps,
    `#!/bin/bash
printf '%s\\n' "$*" >> "${psLog}"
printf '%s\\n' "node ${reportedCwd}/dist/run-with-rotating-logs.js dist/index.js"
exit 0
`,
  );
  chmodSync(ps, 0o755);

  return { bin: fakeBin, psLog };
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
  }, 20_000);

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

  // The sticky `system` domain is polled for the full bootout budget before it
  // is declared stuck, so this case pays that wall-clock wait.
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
  }, 40_000);

  it('waits for a TERMINATING domain to drop the label instead of declaring it stuck', () => {
    // A healthy stop: launchd accepted the bootout and the job is inside the
    // supervisor's 4s shutdown grace (src/run-with-rotating-logs.ts:631), so
    // `bootout` returns non-zero and `print` keeps answering 0 for a few more
    // seconds. A single 1s probe read that as "the domain refused" and failed
    // the deploy on every healthy host.
    const bin = installFakeLaunchctl({
      listLine: '',
      terminatingDomain: { domain: 'gui/<uid>', probes: 3 },
    });
    const scan = installScanOverride([], 'while-alive');

    const result = runStop(bin, { SOMA_PROCESS_SCAN_OVERRIDE: scan });

    // (The "Label still registered in … — booting out" progress line is
    // expected; what must NOT appear is the stuck-domain verdict.)
    expect(result.stdout).not.toMatch(/still holds the label/i);
    expect(result.stdout).not.toMatch(/label still registered in:/i);
    expect(result.status).toBe(0);
  }, 40_000);

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

  it('SIGTERMs the pid that only the user/<uid> job dictionary reports', () => {
    // Headless host (incident 2026-09-17, deploy run 35209063075): the label is
    // bootstrapped in `user/<uid>` and the runner session's `launchctl list`
    // shows NOTHING for it. stop used to read its pre-unload target straight out
    // of `list`, so it had no target at all, killed nothing, and still exited 0
    // while the supervisor kept serving. get_pid asks each domain directly.
    const victim = spawnVictim();
    const uid = process.getuid?.() ?? 0;
    const bin = installFakeLaunchctl({
      listLine: '',
      heldDomains: ['user/<uid>'],
      domainPid: { domain: 'user/<uid>', pid: victim },
    });
    // Empty scan: the ONLY route to this pid is the launchd domain read.
    const scan = installScanOverride([], 'while-alive');

    const result = runStop(bin, { SOMA_PROCESS_SCAN_OVERRIDE: scan });

    expect(result.stdout).toMatch(new RegExp(`SIGTERM to pid=${victim}`));
    expect(isAlive(victim)).toBe(false);
    expect(result.stdout).toContain(`Label still registered in user/${uid}`);
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

/**
 * The scan is the ONLY evidence stop has for "nothing is running out of this
 * tree" once the launchd registration is gone. A scan that cannot run must
 * therefore be an error, not a quiet "clean" — otherwise the deploy goes green
 * exactly when it has the least information, which is the 35184945142 shape
 * again (an unreported survivor serving the old bundle).
 */
describe('scripts/service.sh stop — the stray-process scan must not fail open', () => {
  it('exits non-zero when the scan itself fails, instead of reporting a clean stop', () => {
    const bin = installFakeLaunchctl({ listLine: '' });
    const scan = path.join(workDir, 'broken-scan.sh');
    writeFileSync(scan, '#!/bin/bash\necho "lsof: PID 1: Operation not permitted" >&2\nexit 2\n');
    chmodSync(scan, 0o755);

    const result = runStop(bin, { SOMA_PROCESS_SCAN_OVERRIDE: scan });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('stray-process scan unavailable — refusing to report a clean stop');
  });

  it("routes the scan's own diagnostics to stderr, never into the PID channel", () => {
    // `done < <(scan_project_pids)` consumes stdout as a list of PIDs, so a
    // warning printed there is swallowed by the numeric guard — the operator
    // never sees it and the parser silently drops a line.
    const bin = installFakeLaunchctl({ listLine: '' });
    const scan = path.join(workDir, 'broken-scan.sh');
    writeFileSync(scan, '#!/bin/bash\necho "lsof: PID 1: Operation not permitted" >&2\nexit 2\n');
    chmodSync(scan, 0o755);

    const result = runStop(bin, { SOMA_PROCESS_SCAN_OVERRIDE: scan });

    expect(result.stderr).toContain('lsof: PID 1: Operation not permitted');
    expect(result.stdout).not.toContain('Operation not permitted');
  });

  it('exits non-zero when lsof is not installed at all', () => {
    // No SOMA_PROCESS_SCAN_OVERRIDE: the real discovery path runs, with
    // /usr/sbin (where macOS keeps lsof) off PATH.
    const bin = installFakeLaunchctl({ listLine: '' });

    const result = runStop(bin, {}, { pathTail: '/usr/bin:/bin' });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('stray-process scan unavailable — refusing to report a clean stop');
    expect(result.stderr).toMatch(/lsof/);
  });

  it('matches a cwd reported through a symlinked $PROJECT_DIR', () => {
    // lsof reports the RESOLVED cwd. /opt/soma-work/* and every macOS temp dir
    // are reached through symlinks, so a raw string compare against
    // $PROJECT_DIR misses the very process stop exists to kill.
    const realProject = path.join(workDir, 'real-project');
    mkdirSync(path.join(realProject, 'data'), { recursive: true });
    const linkedProject = path.join(workDir, 'linked-project');
    symlinkSync(realProject, linkedProject);
    const physical = realpathSync(realProject);

    const victim = spawnVictim();
    installFakeLaunchctl({ listLine: '' });
    const { bin } = installFakeLsof(victim, physical);

    const result = runStop(bin, {}, { projectDir: linkedProject });

    expect(isAlive(victim)).toBe(false);
    expect(result.stdout).toMatch(new RegExp(`pid=${victim}`));
    expect(result.status).toBe(0);
  });

  it('reads the argv of a candidate PID with `ps -ww` so a long command line is not truncated', () => {
    // `ps -o command=` truncates at the terminal width; the argv filter
    // (…/dist/run-with-rotating-logs.js) sits at the END of the supervisor's
    // command line, so a truncated read drops the process from the kill list.
    const realProject = path.join(workDir, 'wide-project');
    mkdirSync(path.join(realProject, 'data'), { recursive: true });
    const physical = realpathSync(realProject);

    const victim = spawnVictim();
    installFakeLaunchctl({ listLine: '' });
    const { bin, psLog } = installFakeLsof(victim, physical);

    runStop(bin, {}, { projectDir: realProject });

    expect(readFileSync(psLog, 'utf-8')).toMatch(/-ww/);
  });
});
