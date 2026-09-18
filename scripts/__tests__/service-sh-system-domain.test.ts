/**
 * Contract tests for the SYSTEM LaunchDaemon domain in `scripts/service.sh`.
 *
 * Measured 2026-09-18 on the headless Mac mini whose GitHub runner is itself a
 * System-session LaunchDaemon running as user `dd`:
 *
 *   launchctl kickstart -k gui/<uid>/<label>   → 125 (no Aqua seat to spawn into)
 *   launchctl bootstrap user/<uid> <plist>     → exit 5 (no permission)
 *   direct headless spawn                      → `spawn node EAGAIN` (runner coalition)
 *
 * So on that host the ONLY control path is the system domain, and the bot is
 * supervised by `/Library/LaunchDaemons/<label>.plist` (UserName dd) — which is
 * also why the leftover user LaunchAgent produced two supervisors for one label.
 * Root is reached through a narrow passwordless sudo rule the host carries in
 * /etc/sudoers.d/soma-work-<env>, which allows EXACTLY four argv forms:
 *
 *   /bin/launchctl print     system/<label>
 *   /bin/launchctl bootout   system/<label>
 *   /bin/launchctl bootstrap system /Library/LaunchDaemons/<label>.plist
 *   /bin/launchctl kickstart -k system/<label>
 *
 * These tests pin what follows from that:
 *   1. system mode is detected from the LaunchDaemon plist's existence, and
 *      every launchd interaction with the label then goes through
 *      `sudo -n /bin/launchctl …` in one of those four forms, byte-for-byte
 *      (an extra flag or a different path would not match the sudoers rule);
 *   2. status reads the pid out of the sudo `print`, and names the domain;
 *   3. stop boots the label out through sudo, and refuses to report a clean
 *      stop while the label still prints;
 *   4. a refused `sudo -n` is a hard failure naming the sudoers file — NOT a
 *      silent downgrade to gui/user/headless, which is what produced the
 *      double registration in the first place;
 *   5. install in system mode never writes or loads the user LaunchAgent, and
 *      fails with the exact plist path when the LaunchDaemon is absent
 *      (creating one needs root and is the operator's job).
 *
 * Strategy is the sibling suites': a fake `launchctl` AND a fake `sudo` on
 * PATH (the fake sudo records its full argv and dispatches to the fake
 * launchctl, so nothing here can reach real root or real launchd), a temp HOME,
 * and the SOMA_* overrides under SOMA_TEST_HARNESS=1 — including
 * SOMA_SYSTEM_DAEMON_PLIST_OVERRIDE, which points the system-mode detection at
 * a temp file instead of /Library/LaunchDaemons.
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

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  /** Every fake-launchctl invocation, `sudo `-prefixed when it came via sudo. */
  calls: string;
  /** Every fake-sudo invocation, as the full argv string after `sudo`. */
  sudoCalls: string;
}

let workDir: string;
const victims: number[] = [];

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'service-sh-system-test-'));
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

/** A real, killable grandchild process standing in for the supervised daemon. */
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

interface FakeOptions {
  /** Label already bootstrapped+running in system/ (status/stop fixtures). */
  alreadyRunning?: boolean;
  /** Pid the system job dictionary reports. */
  systemPid?: number;
  /** Pid the job reports after a kickstart. Defaults to `systemPid`. */
  pidAfterKickstart?: number;
  /** `sudo -n` answers the way it does with no matching sudoers rule. */
  sudoRefused?: boolean;
  /** `bootout system/<label>` drops the registration. Default: true. */
  bootoutWorks?: boolean;
  /** `bootstrap system <plist>` answers 37 (already bootstrapped). */
  bootstrapAlready?: boolean;
}

interface Fakes {
  bin: string;
  callsLog: string;
  sudoCallsLog: string;
  systemPlist: string;
}

/**
 * Fake `launchctl` + fake `sudo` shaped like the headless Mac mini.
 *
 * The registration is a marker FILE whose contents are the job's current pid
 * (absent = not bootstrapped), so a run that boots the job out and bootstraps it
 * again reads two different pids, the way it would against real launchd.
 *
 * Only the SYSTEM domain ever holds the label here: `gui/<uid>` and
 * `user/<uid>` answer the way a domain without the job does, which is what the
 * host measured on 2026-09-18 reports to a non-root process.
 */
function installFakes(opts: FakeOptions = {}): Fakes {
  const fakeBin = path.join(workDir, 'bin');
  mkdirSync(fakeBin, { recursive: true });
  const callsLog = path.join(workDir, 'launchctl-calls.log');
  const sudoCallsLog = path.join(workDir, 'sudo-calls.log');
  writeFileSync(callsLog, '');
  writeFileSync(sudoCallsLog, '');

  const systemPid = opts.systemPid ?? process.pid;
  const kickstartPid = opts.pidAfterKickstart ?? systemPid;
  const bootoutWorks = opts.bootoutWorks ?? true;
  const marker = path.join(workDir, 'system-domain-running.marker');
  if (opts.alreadyRunning) writeFileSync(marker, String(systemPid));

  const launchctlScript = `#!/bin/bash
# FAKE_SUDO is exported by the fake sudo below, so the log distinguishes a call
# that went through sudo from one this script made directly.
printf '%s%s\\n' "\${FAKE_SUDO:+sudo }" "$*" >> "${callsLog}"
MARKER="${marker}"
case "$1" in
  list)
    exit 0
    ;;
  print)
    case "$2" in
      "system/${LABEL}")
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
  bootstrap)
    ${
      opts.bootstrapAlready
        ? 'echo "Bootstrap failed: 37: Operation already in progress" >&2; exit 37'
        : `printf '%s' "${systemPid}" > "$MARKER"; exit 0`
    }
    ;;
  kickstart)
    if [[ "$3" == "system/${LABEL}" ]]; then
      printf '%s' "${kickstartPid}" > "$MARKER"
      exit 0
    fi
    echo "Could not kickstart service \\"$3\\": 3: No such process" >&2
    exit 3
    ;;
  bootout)
    if [[ "$2" == "system/${LABEL}" ]]; then
      ${bootoutWorks ? 'rm -f "$MARKER"; exit 0' : 'echo "Boot-out failed: 1: Operation not permitted" >&2; exit 1'}
    fi
    echo "Boot-out failed: 113: Could not find specified service" >&2
    exit 113
    ;;
  load|unload)
    echo "Load failed: 5: Input/output error" >&2
    exit 1
    ;;
  *)
    exit 0
    ;;
esac
`;
  const launchctl = path.join(fakeBin, 'launchctl');
  writeFileSync(launchctl, launchctlScript);
  chmodSync(launchctl, 0o755);

  // The fake sudo accepts ONLY `-n /bin/launchctl …`: anything else is the
  // shape the sudoers rule would reject, and the test must see it as a failure
  // rather than silently working.
  const sudoScript = `#!/bin/bash
printf '%s\\n' "$*" >> "${sudoCallsLog}"
${opts.sudoRefused ? 'echo "sudo: a password is required" >&2\nexit 1' : ''}
[[ "$1" == "-n" ]] || { echo "sudo: refusing argv without -n: $*" >&2; exit 1; }
shift
cmd="$1"
shift
[[ "$cmd" == "/bin/launchctl" ]] || { echo "sudo: command not allowed: $cmd" >&2; exit 1; }
FAKE_SUDO=1 exec "${launchctl}" "$@"
`;
  const sudo = path.join(fakeBin, 'sudo');
  writeFileSync(sudo, sudoScript);
  chmodSync(sudo, 0o755);

  // Existence of this file is what turns system mode on (detection override).
  const systemPlist = path.join(workDir, `${LABEL}.plist`);
  writeFileSync(systemPlist, '<plist></plist>');

  return { bin: fakeBin, callsLog, sudoCallsLog, systemPlist };
}

/** Where run() would put the user LaunchAgent plist for this test's temp HOME. */
function agentPlistPath(): string {
  return path.join(workDir, 'home', 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

/** Process-scan stand-in (SOMA_PROCESS_SCAN_OVERRIDE) that reports nothing. */
function installEmptyScan(): string {
  const scan = path.join(workDir, 'scan.sh');
  writeFileSync(scan, '#!/bin/bash\n# $1 = PROJECT_DIR\nexit 0\n');
  chmodSync(scan, 0o755);
  return scan;
}

function run(args: string[], fakes: Fakes, extraEnv: Record<string, string> = {}): RunResult {
  const homeStub = path.join(workDir, 'home');
  // The LaunchAgents dir exists (an operator's Mac always has one) but this
  // suite never writes a plist into it: whether service.sh does is the
  // double-registration assertion.
  mkdirSync(path.join(homeStub, 'Library', 'LaunchAgents'), { recursive: true });

  let result: RunResult;
  try {
    const stdout = execFileSync('bash', [SERVICE_SH, 'dev', ...args], {
      env: {
        ...process.env,
        PATH: `${fakes.bin}:${process.env.PATH ?? ''}`,
        HOME: homeStub,
        SOMA_TEST_HARNESS: '1',
        SOMA_PID_FILE_OVERRIDE: path.join(workDir, 'soma-work.pid'),
        SOMA_PROJECT_DIR_OVERRIDE: path.join(workDir, 'project'),
        SOMA_SYSTEM_DAEMON_PLIST_OVERRIDE: fakes.systemPlist,
        ...extraEnv,
      },
      encoding: 'utf-8',
    });
    result = { status: 0, stdout, stderr: '', calls: '', sudoCalls: '' };
  } catch (err: any) {
    result = {
      status: err.status ?? -1,
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? ''),
      calls: '',
      sudoCalls: '',
    };
  }
  result.calls = readFileSync(fakes.callsLog, 'utf-8');
  result.sudoCalls = readFileSync(fakes.sudoCallsLog, 'utf-8');
  return result;
}

/** The four argv forms /etc/sudoers.d/soma-work-dev allows, and nothing else. */
function allowedSudoForms(systemPlist: string): string[] {
  return [
    `-n /bin/launchctl print system/${LABEL}`,
    `-n /bin/launchctl bootout system/${LABEL}`,
    `-n /bin/launchctl bootstrap system ${systemPlist}`,
    `-n /bin/launchctl kickstart -k system/${LABEL}`,
  ];
}

function sudoLines(result: RunResult): string[] {
  return result.sudoCalls.split('\n').filter((l) => l.trim().length > 0);
}

describe('scripts/service.sh — system LaunchDaemon domain (headless runner, sudo-gated)', () => {
  it('start bootstraps + kickstarts through sudo, in exactly the sudoers argv forms', () => {
    const fakes = installFakes();

    const result = run(['start'], fakes);

    expect(result.sudoCalls).toContain(`-n /bin/launchctl bootstrap system ${fakes.systemPlist}`);
    expect(result.sudoCalls).toContain(`-n /bin/launchctl kickstart -k system/${LABEL}`);
    // Every sudo call is one of the four allowed forms — an extra flag or a
    // different binary path would be rejected by the real sudoers rule.
    for (const line of sudoLines(result)) {
      expect(allowedSudoForms(fakes.systemPlist)).toContain(line);
    }
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Service started \(PID: \d+\)/);
    expect(result.stdout).toContain('launchd: system');
    // No silent downgrade: the gui/user domains and the direct spawn are not
    // touched in system mode.
    expect(result.calls).not.toContain(`gui/${UID}/${LABEL}`);
    expect(result.calls).not.toContain(`user/${UID}/${LABEL}`);
    expect(result.stdout).not.toMatch(/headless/i);
  });

  it('tolerates an already-bootstrapped daemon (bootstrap exits 37) and still kickstarts', () => {
    // The normal answer on every start after the first: the label is already in
    // the system domain but its process is gone, so bootstrap says 37 and the
    // kickstart is what actually brings the daemon back.
    const fakes = installFakes({ bootstrapAlready: true });

    const result = run(['start'], fakes);

    expect(result.sudoCalls).toContain(`-n /bin/launchctl bootstrap system ${fakes.systemPlist}`);
    expect(result.sudoCalls).toContain(`-n /bin/launchctl kickstart -k system/${LABEL}`);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Service started \(PID: \d+\)/);
    // 37 is expected, not a failure to shout about.
    expect(result.stdout).not.toMatch(/bootstrap system .* failed/);
  });

  it('status reports RUNNING with the pid from the sudo print, and Domain: system', () => {
    const fakes = installFakes({ alreadyRunning: true });

    const result = run(['status'], fakes);

    expect(result.sudoCalls).toContain(`-n /bin/launchctl print system/${LABEL}`);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/RUNNING/);
    expect(result.stdout).toContain(String(process.pid));
    expect(result.stdout).toContain('Domain:  system');
  });

  it('stop boots the label out through sudo and reports a clean stop', () => {
    const running = spawnVictim();
    const fakes = installFakes({ alreadyRunning: true, systemPid: running });

    const result = run(['stop'], fakes, { SOMA_PROCESS_SCAN_OVERRIDE: installEmptyScan() });

    expect(result.sudoCalls).toContain(`-n /bin/launchctl bootout system/${LABEL}`);
    for (const line of sudoLines(result)) {
      expect(allowedSudoForms(fakes.systemPlist)).toContain(line);
    }
    expect(isAlive(running)).toBe(false);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Stopped: no live process/);
  }, 60_000);

  // Pays the full STOP_BOOTOUT_WAIT_SECONDS budget for the domain that refuses.
  it('stop refuses to report clean while the system domain still prints the label', () => {
    const running = spawnVictim();
    const fakes = installFakes({ alreadyRunning: true, systemPid: running, bootoutWorks: false });

    const result = run(['stop'], fakes, { SOMA_PROCESS_SCAN_OVERRIDE: installEmptyScan() });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(`still registered in: system/${LABEL}`);
  }, 60_000);

  it('a refused `sudo -n` fails loudly, names the sudoers file, and does not downgrade', () => {
    const fakes = installFakes({ sudoRefused: true });

    const result = run(['start'], fakes);

    expect(result.status).not.toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).toContain('/etc/sudoers.d/soma-work-dev');
    expect(output).toMatch(/sudo/i);
    // Neither the user domains nor the direct spawn may be used as a fallback.
    expect(result.calls).not.toContain(`gui/${UID}/${LABEL}`);
    expect(result.calls).not.toContain(`user/${UID}/${LABEL}`);
    // The refusal message may NAME the headless path it is refusing; what must
    // not appear is the path actually running.
    expect(result.stdout).not.toMatch(/headless (direct-spawn|fallback)/i);
    expect(existsSync(agentPlistPath())).toBe(false);
  });

  it('install does not write or load a user LaunchAgent in system mode', () => {
    const fakes = installFakes();
    const projectDir = path.join(workDir, 'project');
    mkdirSync(projectDir, { recursive: true });

    const result = run(['install'], fakes);

    // The double-registration source: a LaunchAgent plist beside the daemon.
    expect(existsSync(agentPlistPath())).toBe(false);
    expect(result.calls).not.toMatch(/^load /m);
    expect(result.calls).not.toMatch(/^sudo load /m);
    // …and the daemon is bootstrapped + kickstarted instead.
    expect(result.sudoCalls).toContain(`-n /bin/launchctl bootstrap system ${fakes.systemPlist}`);
    expect(result.sudoCalls).toContain(`-n /bin/launchctl kickstart -k system/${LABEL}`);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Service installed and started \(PID: \d+\)/);
  });

  it('install fails with the exact plist path when the LaunchDaemon is missing', () => {
    const fakes = installFakes();
    mkdirSync(path.join(workDir, 'project'), { recursive: true });
    // SOMA_LAUNCHD_SYSTEM=1 keeps system mode on while the plist is absent —
    // the operator-must-create-it case.
    const missing = path.join(workDir, 'absent', `${LABEL}.plist`);

    const result = run(['install'], fakes, {
      SOMA_SYSTEM_DAEMON_PLIST_OVERRIDE: missing,
      SOMA_LAUNCHD_SYSTEM: '1',
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(missing);
    expect(existsSync(agentPlistPath())).toBe(false);
    expect(result.sudoCalls).not.toContain('bootstrap');
  });

  it('verify-restart accepts the pid the system domain reports', () => {
    const since = Math.floor(Date.now() / 1000);
    const fakes = installFakes({ alreadyRunning: true });
    // `ps -p <pid> -o lstart=` is the only ps call verify-restart makes.
    const ps = path.join(fakes.bin, 'ps');
    writeFileSync(ps, `#!/bin/bash\nprintf '%s\\n' "${lstartFor(since + 5)}"\nexit 0\n`);
    chmodSync(ps, 0o755);

    const projectDir = path.join(workDir, 'project');
    mkdirSync(path.join(projectDir, 'logs'), { recursive: true });
    const iso = new Date((since + 9) * 1000).toISOString();
    writeFileSync(
      path.join(projectDir, 'logs', 'stdout.log'),
      `[${iso}] [INFO ] [Index] ⚡️ Claude Code Slack bot is running! [v0.26.1 (deadbee)]\n`,
    );

    const result = run(['verify-restart', '--since', String(since), '--version', '0.26.1', '--timeout', '0'], fakes);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Restart verified/);
    expect(result.stdout).toContain(String(process.pid));
  });
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
