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
 * These tests pin the four things that follow from that:
 *   1. gui first, then user/<uid> on a 125 (or when `print gui/<uid>` itself
 *      fails) — and a user-domain start counts as launchd-managed, not headless;
 *   2. status/get_pid see a user-domain registration (`launchctl print
 *      user/<uid>/<label>` → `pid = N`), including its STALE shape;
 *   3. verify-restart accepts a PID found in the user domain;
 *   4. when BOTH domains fail, the headless fallback's failure prints the reason
 *      and the tails of launchd.out.log / stderr.log instead of one dead line.
 *
 * Strategy is the one the sibling service-sh-* suites use: a fake `launchctl`
 * (and, where verify-restart needs it, a fake `ps`) on PATH, a temp HOME, and
 * the SOMA_* overrides under SOMA_TEST_HARNESS=1 so nothing here can reach the
 * host's real LaunchAgents or /opt tree.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'service-sh-domain-test-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

interface LaunchctlOptions {
  /** `launchctl print gui/<uid>` succeeds (a logged-in Mac). Default: true. */
  guiDomainExists?: boolean;
  /** `bootstrap`/`kickstart` in user/<uid> succeed. Default: true. */
  userDomainWorks?: boolean;
  /** PID the user-domain job dictionary reports; 'none' = registered but dead. */
  userPid?: number | 'none';
  /** Start with the label already live in user/<uid> (for status/verify runs). */
  alreadyRunning?: boolean;
}

/**
 * Fake `launchctl` shaped like the headless Mac mini:
 *   - `list` prints nothing (the runner's session does not see the label)
 *   - `load` fails the way it does with no GUI seat
 *   - `kickstart -k gui/<uid>/<label>` exits 125
 *   - `bootstrap user/<uid>` + `kickstart -k user/<uid>/<label>` succeed and
 *     flip the label live, after which `print user/<uid>/<label>` answers with a
 *     real job dictionary (that is where get_pid reads `pid = N`).
 */
function installFakeLaunchctl(opts: LaunchctlOptions = {}): { bin: string; callsLog: string } {
  const fakeBin = path.join(workDir, 'bin');
  mkdirSync(fakeBin, { recursive: true });
  const callsLog = path.join(workDir, 'launchctl-calls.log');
  writeFileSync(callsLog, '');
  const marker = path.join(workDir, 'user-domain-running.marker');
  if (opts.alreadyRunning) writeFileSync(marker, '');

  const guiDomainExists = opts.guiDomainExists ?? true;
  const userDomainWorks = opts.userDomainWorks ?? true;
  const userPid = opts.userPid ?? process.pid;
  // The `pid = N` line is what get_pid parses; omitting it is the STALE shape
  // (launchd knows the label, no process behind it).
  const pidLine = userPid === 'none' ? '' : `\tpid = ${userPid}`;

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
          printf '%s\\n' "${LABEL} = {" "\tstate = running" "${pidLine}" "}"
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
        ${userDomainWorks ? ': > "$MARKER"; exit 0' : 'echo "Could not kickstart service \\"$3\\": 3: No such process" >&2; exit 3'}
        ;;
    esac
    exit 1
    ;;
  bootstrap)
    ${userDomainWorks ? 'exit 0' : 'echo "Bootstrap failed: 5: Input/output error" >&2; exit 5'}
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

/** `ps -p <pid> -o lstart=` — the only ps call verify-restart makes. */
function installFakePs(bin: string, lstart: string): void {
  const ps = path.join(bin, 'ps');
  writeFileSync(ps, `#!/bin/bash\nprintf '%s\\n' "${lstart}"\nexit 0\n`);
  chmodSync(ps, 0o755);
}

function run(args: string[], bin: string, callsLog: string, projectDir?: string): RunResult {
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
        SOMA_PID_FILE_OVERRIDE: path.join(workDir, 'soma-work.pid'),
        SOMA_PROJECT_DIR_OVERRIDE: projectDir ?? path.join(workDir, 'project'),
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
