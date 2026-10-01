/**
 * Contract tests for the launchd DOMAIN `scripts/service.sh` uses.
 *
 * Incident 2026-09-17, deploy run 35209063075, a headless Mac mini: the GitHub
 * runner is a System-session LaunchDaemon running as user `dd` and the host has
 * NO Aqua/GUI login session. On that host
 *
 *   launchctl kickstart -k gui/<uid>/<label>
 *     → "125: Domain does not support specified action"
 *   launchctl load ~/Library/LaunchAgents/<label>.plist
 *     → registers nothing
 *
 * so every deploy fell through to the headless direct-spawn — which then failed
 * too, and printed not one diagnostic line. Measured from an ssh (Background)
 * session on the same host, the per-user domain works:
 *
 *   launchctl bootstrap user/<uid> <plist>  +  kickstart -k user/<uid>/<label>
 *
 * These tests pin the six things that follow from that:
 *   1. gui first, then user/<uid> on a 125 (or when `print gui/<uid>` itself
 *      fails) — and a user-domain start counts as launchd-managed, not headless;
 *   2. status/get_pid see a user-domain registration (`launchctl print
 *      user/<uid>/<label>` → `pid = N`), including its STALE shape;
 *   3. verify-restart accepts a PID found in the user domain;
 *   4. when BOTH domains fail, the headless fallback's failure prints the reason
 *      and the tails of launchd.out.log / stderr.log instead of one dead line;
 *   5. reinstall and uninstall stop the service the way `stop` does — booting
 *      the label out of every domain — instead of `launchctl unload <plist>`,
 *      which reaches no domain at all here and made reinstall abort at step 1;
 *   6. uninstall reports the domains that refused instead of printing success
 *      over a registration that outlived its plist.
 *
 * Strategy is the one the sibling service-sh-* suites use: a fake `launchctl`
 * (and, where verify-restart needs it, a fake `ps`) on PATH, a temp HOME, and
 * the SOMA_* overrides under SOMA_TEST_HARNESS=1 so nothing here can reach the
 * host's real LaunchAgents or /opt tree.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SERVICE_SH = path.join(REPO_ROOT, 'scripts', 'service.sh');
const LABEL = 'ai.2lab.soma-work.dev';
const UID = process.getuid?.() ?? 0;
const VERSION = '0.26.1';

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  calls: string;
}

let workDir: string;
const victims: number[] = [];

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'service-sh-domain-test-'));
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

/**
 * A real, killable process standing in for the supervisor launchd is managing —
 * a GRANDchild, so the kill leaves no zombie that `kill -0` would still find
 * alive (same reasoning as service-sh-stop.test.ts).
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

interface LaunchctlOptions {
  /** `launchctl print gui/<uid>` succeeds (a logged-in Mac). Default: true. */
  guiDomainExists?: boolean;
  /** `bootstrap`/`kickstart` in user/<uid> succeed. Default: true. */
  userDomainWorks?: boolean;
  /** PID the user-domain job dictionary reports; 'none' = registered but dead. */
  userPid?: number | 'none';
  /** Start with the label already live in user/<uid> (for status/verify runs). */
  alreadyRunning?: boolean;
  /**
   * PID the job reports AFTER a kickstart, when launchd has (re)spawned it —
   * a restart gives the job a new pid, so a stop/start cycle must not be
   * describable by a single number. Defaults to `userPid`.
   */
  pidAfterKickstart?: number;
  /**
   * `launchctl bootout user/<uid>/<label>` drops the registration. Default:
   * true. False = the domain keeps the label (what stop/uninstall must report
   * instead of claiming success).
   */
  bootoutWorks?: boolean;
}

/**
 * Fake `launchctl` shaped like the headless Mac mini:
 *   - `list` prints nothing (the runner's session does not see the label)
 *   - `load` fails the way it does with no GUI seat
 *   - `kickstart -k gui/<uid>/<label>` exits 125
 *   - `bootstrap user/<uid>` + `kickstart -k user/<uid>/<label>` succeed and
 *     flip the label live, after which `print user/<uid>/<label>` answers with a
 *     real job dictionary (that is where get_pid reads `pid = N`).
 *   - `bootout user/<uid>/<label>` drops the registration again.
 *
 * The registration is a marker FILE whose contents are the job's current pid
 * (empty = registered but dead), so a run that stops and restarts the job reads
 * two different pids, the way it would against real launchd.
 */
function installFakeLaunchctl(opts: LaunchctlOptions = {}): { bin: string; callsLog: string } {
  const fakeBin = path.join(workDir, 'bin');
  mkdirSync(fakeBin, { recursive: true });
  const callsLog = path.join(workDir, 'launchctl-calls.log');
  writeFileSync(callsLog, '');

  const guiDomainExists = opts.guiDomainExists ?? true;
  const userDomainWorks = opts.userDomainWorks ?? true;
  const bootoutWorks = opts.bootoutWorks ?? true;
  const userPid = opts.userPid ?? process.pid;
  const marker = path.join(workDir, 'user-domain-running.marker');
  // An empty marker is the STALE shape: launchd knows the label, no process
  // behind it — the `pid = N` line get_pid parses is simply absent.
  if (opts.alreadyRunning) writeFileSync(marker, userPid === 'none' ? '' : String(userPid));
  const kickstartPid = opts.pidAfterKickstart ?? (userPid === 'none' ? '' : String(userPid));

  const script = `#!/bin/bash
printf '%s\\n' "$*" >> "${callsLog}"
MARKER="${marker}"
case "$1" in
  list)
    exit 0
    ;;
  print)
    case "$2" in
      "gui/${UID}")
        ${
          guiDomainExists
            ? `printf '%s\\n' "gui/${UID} = {"; exit 0`
            : `echo "Could not find domain for gui/${UID}" >&2; exit 113`
        }
        ;;
      "user/${UID}/${LABEL}")
        if [[ -f "$MARKER" ]]; then
          pid="$(cat "$MARKER")"
          printf '%s\\n' "${LABEL} = {" "\tstate = running"
          [[ -n "$pid" ]] && printf '\\tpid = %s\\n' "$pid"
          printf '%s\\n' "}"
          exit 0
        fi
        echo "Could not find service \\"$2\\"" >&2
        exit 113
        ;;
      *)
        echo "Could not find service \\"$2\\"" >&2
        exit 113
        ;;
    esac
    ;;
  kickstart)
    case "$3" in
      "gui/${UID}/${LABEL}")
        echo "Could not kickstart service \\"$3\\": 125: Domain does not support specified action" >&2
        exit 125
        ;;
      "user/${UID}/${LABEL}")
        ${userDomainWorks ? `printf '%s' "${kickstartPid}" > "$MARKER"; exit 0` : 'echo "Could not kickstart service \\"$3\\": 3: No such process" >&2; exit 3'}
        ;;
    esac
    exit 1
    ;;
  bootstrap)
    ${userDomainWorks ? 'exit 0' : 'echo "Bootstrap failed: 5: Input/output error" >&2; exit 5'}
    ;;
  bootout)
    # Only the per-user domain ever holds the label on this fake host; a bootout
    # there drops the registration (the marker file), which is what the print
    # branch above reads afterwards. The other domains answer the way a domain
    # with no such job does.
    if [[ "$2" == "user/${UID}/${LABEL}" ]]; then
      ${bootoutWorks ? 'rm -f "$MARKER"; exit 0' : 'echo "Boot-out failed: 1: Operation not permitted" >&2; exit 1'}
    fi
    echo "Boot-out failed: 113: Could not find specified service" >&2
    exit 113
    ;;
  load)
    echo "Load failed: 5: Input/output error" >&2
    exit 1
    ;;
  *)
    exit 0
    ;;
esac
`;
  const launchctl = path.join(fakeBin, 'launchctl');
  writeFileSync(launchctl, script);
  chmodSync(launchctl, 0o755);
  return { bin: fakeBin, callsLog };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** `ps -p <pid> -o lstart=` — the only ps call verify-restart makes. */
function installFakePs(bin: string, lstart: string): void {
  const ps = path.join(bin, 'ps');
  writeFileSync(ps, `#!/bin/bash\nprintf '%s\\n' "${lstart}"\nexit 0\n`);
  chmodSync(ps, 0o755);
}

/** Where run() puts the LaunchAgent plist for this test's temp HOME. */
function plistPath(): string {
  return path.join(workDir, 'home', 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

/**
 * Process-scan stand-in (SOMA_PROCESS_SCAN_OVERRIDE) that reports nothing. The
 * commands that go through cmd_stop (reinstall) would otherwise run the real
 * lsof discovery against the temp project dir; this keeps them hermetic and
 * makes "nothing survived the stop" the fixture, not an observation of the host.
 */
function installEmptyScan(): string {
  const scan = path.join(workDir, 'scan.sh');
  writeFileSync(scan, '#!/bin/bash\n# $1 = PROJECT_DIR\nexit 0\n');
  chmodSync(scan, 0o755);
  return scan;
}

function run(
  args: string[],
  bin: string,
  callsLog: string,
  projectDir?: string,
  extraEnv: Record<string, string> = {},
): RunResult {
  const homeStub = path.join(workDir, 'home');
  const agentsDir = path.join(homeStub, 'Library', 'LaunchAgents');
  mkdirSync(agentsDir, { recursive: true });
  // cmd_start refuses to run without a plist; the fake launchctl ignores it.
  writeFileSync(path.join(agentsDir, `${LABEL}.plist`), '<plist></plist>');

  let result: RunResult;
  try {
    const stdout = execFileSync('bash', [SERVICE_SH, 'dev', ...args], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HOME: homeStub,
        // The overrides are inert without this flag (service.sh resolve_env).
        SOMA_TEST_HARNESS: '1',
        // This suite is about the gui/user domains. Force system-daemon mode
        // off so an inherited SOMA_LAUNCHD_SYSTEM=1 (or, without the harness
        // flag, a real /Library/LaunchDaemons/<label>.plist) can never make a
        // unit test shell out to `sudo -n /bin/launchctl`.
        SOMA_LAUNCHD_SYSTEM: '0',
        SOMA_PID_FILE_OVERRIDE: path.join(workDir, 'soma-work.pid'),
        SOMA_PROJECT_DIR_OVERRIDE: projectDir ?? path.join(workDir, 'project'),
        ...extraEnv,
      },
      encoding: 'utf-8',
    });
    result = { status: 0, stdout, stderr: '', calls: '' };
  } catch (err: any) {
    result = {
      status: err.status ?? -1,
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? ''),
      calls: '',
    };
  }
  result.calls = readFileSync(callsLog, 'utf-8');
  return result;
}

describe('scripts/service.sh — launchd domain fallback (headless host, no Aqua session)', () => {
  it('falls back to user/<uid> when the gui kickstart answers 125, and reports launchd-managed', () => {
    const { bin, callsLog } = installFakeLaunchctl();

    const result = run(['start'], bin, callsLog);

    // gui was tried first…
    expect(result.calls).toContain(`kickstart -k gui/${UID}/${LABEL}`);
    // …then the working path: bootstrap into the per-user domain, then kickstart.
    expect(result.calls).toMatch(new RegExp(`bootstrap user/${UID} \\S+\\.plist`));
    expect(result.calls).toContain(`kickstart -k user/${UID}/${LABEL}`);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`launchd-managed in the user/${UID} domain`);
    expect(result.stdout).toMatch(/Service started \(PID: \d+\)/);
    // launchd owns it — the direct-spawn path must not have been used.
    expect(result.stdout).not.toMatch(/headless/i);
  });

  it('uses user/<uid> when `launchctl print gui/<uid>` itself fails (no GUI domain at all)', () => {
    const { bin, callsLog } = installFakeLaunchctl({ guiDomainExists: false });

    const result = run(['start'], bin, callsLog);

    // No point kickstarting a domain that does not exist.
    expect(result.calls).not.toContain(`kickstart -k gui/${UID}/${LABEL}`);
    expect(result.calls).toContain(`kickstart -k user/${UID}/${LABEL}`);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`launchd-managed in the user/${UID} domain`);
  });

  it('status reports RUNNING with the user-domain PID (launchctl list shows nothing)', () => {
    const { bin, callsLog } = installFakeLaunchctl({ alreadyRunning: true });

    const result = run(['status'], bin, callsLog);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/RUNNING/);
    expect(result.stdout).toContain(String(process.pid));
    expect(result.stdout).toContain(`Domain:  user/${UID}`);
  });

  it('status reports STALE when the user domain holds the label with no pid', () => {
    const { bin, callsLog } = installFakeLaunchctl({ alreadyRunning: true, userPid: 'none' });

    const result = run(['status'], bin, callsLog);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/STALE/);
    // The operator is told the command that actually works on this host.
    expect(result.stdout).toContain(`launchctl kickstart -k user/$(id -u)/${LABEL}`);
  });

  it('verify-restart accepts a PID found in the user domain', () => {
    const since = Math.floor(Date.now() / 1000);
    const { bin, callsLog } = installFakeLaunchctl({ alreadyRunning: true });
    installFakePs(bin, lstartFor(since + 5));

    const projectDir = path.join(workDir, 'project');
    mkdirSync(path.join(projectDir, 'logs'), { recursive: true });
    const iso = new Date((since + 9) * 1000).toISOString();
    writeFileSync(
      path.join(projectDir, 'logs', 'stdout.log'),
      `[${iso}] [INFO ] [Index] ⚡️ Claude Code Slack bot is running! [v${VERSION} (deadbee)]\n`,
    );

    const result = run(
      ['verify-restart', '--since', String(since), '--version', VERSION, '--timeout', '0'],
      bin,
      callsLog,
      projectDir,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Restart verified/);
    expect(result.stdout).toContain(String(process.pid));
  });

  it('reinstall gets past step 1 when the label lives in user/<uid> (unload cannot reach it)', () => {
    // Step 1 used to be `launchctl unload <plist>` + is_registered. On this
    // host shape unload reaches NO domain — the registration is a `user/<uid>`
    // bootstrap — so is_registered stayed true and reinstall aborted with
    // "Failed to stop service" on exactly the hosts the user-domain fallback
    // exists for. Step 1 is now the same stop everything else uses.
    // The running job is a real process the stop has to kill; the restart comes
    // back under a new pid (this test process, which is certainly alive).
    const running = spawnVictim();
    const { bin, callsLog } = installFakeLaunchctl({
      alreadyRunning: true,
      userPid: running,
      pidAfterKickstart: process.pid,
    });
    const projectDir = path.join(workDir, 'project');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      path.join(projectDir, 'package.json'),
      JSON.stringify({ name: 'service-sh-domain-fixture', private: true, scripts: { build: 'true' } }),
    );

    const result = run(['reinstall'], bin, callsLog, projectDir, {
      SOMA_PROCESS_SCAN_OVERRIDE: installEmptyScan(),
    });

    // Step 1 actually removed the registration, in the domain that held it,
    // and killed the process behind it…
    expect(result.calls).toContain(`bootout user/${UID}/${LABEL}`);
    expect(isAlive(running)).toBe(false);
    // …and the run reached the build instead of dying at "[1/4]".
    expect(result.stdout).toContain('[2/4] Building project');
    expect(result.stdout).not.toMatch(/Failed to stop service/);
    // …through to a service launchd manages again, in the same domain.
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Reinstall completed!/);
  }, 60_000);

  it('uninstall boots the label out of every domain before removing the plist', () => {
    // `launchctl unload <plist>` cannot drop a user/<uid> bootstrap, so the old
    // uninstall deleted the plist and left the label registered — a
    // registration with no file left to unload it with.
    const { bin, callsLog } = installFakeLaunchctl({ alreadyRunning: true });

    const result = run(['uninstall'], bin, callsLog);

    expect(result.calls).toContain(`bootout user/${UID}/${LABEL}`);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Plist removed/);
    expect(result.stdout).toMatch(/Service uninstalled/);
    expect(existsSync(plistPath())).toBe(false);
  });

  // Pays the full STOP_BOOTOUT_WAIT_SECONDS budget for the domain that refuses.
  it('uninstall does not claim success while a domain still holds the label', () => {
    const { bin, callsLog } = installFakeLaunchctl({ alreadyRunning: true, bootoutWorks: false });

    const result = run(['uninstall'], bin, callsLog);

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toMatch(/\[SUCCESS\] Service uninstalled/);
    expect(result.stdout).toContain(`still registered in: user/${UID}/${LABEL}`);
  }, 40_000);

  // Pays the headless fallback's real 25s pidfile wait: that loop is the
  // production timing, and faking it would test something else.
  it('prints the reason and the log tails when BOTH domains and the headless fallback fail', () => {
    const { bin, callsLog } = installFakeLaunchctl({ userDomainWorks: false });

    const result = run(['start'], bin, callsLog);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/Failed to start service \(launchd \+ headless fallback both failed\)/);
    // WHY it failed, not just THAT it failed.
    expect(result.stdout).toMatch(/reason: no pidfile at .*soma-work\.pid/);
    // The spawn's own output — here node cannot find the (absent) bundle.
    expect(result.stdout).toMatch(/Last 20 lines of .*launchd\.out\.log/);
    expect(result.stdout).toMatch(/Cannot find module/);
    // stderr.log never got written by a process that died pre-init; say so.
    expect(result.stdout).toMatch(/No .*stderr\.log to read\./);
  }, 60_000);
});

/** `ps -o lstart=` formatting for an epoch, in local time (BSD then GNU). */
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
