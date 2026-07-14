/**
 * Contract test for `scripts/service.sh start` — the agent must actually SPAWN.
 *
 * Background (deploy run 27553669625, oudwood-dev, 2026-06-15): the Deploy step
 * runs `service.sh <env> install`, which did `launchctl load "$PLIST"` and then
 * checked for a live PID. `launchctl load` only REGISTERS the LaunchAgent in the
 * user domain. When the deploy runs from a non-GUI/Aqua session — exactly the
 * case for a GitHub Actions self-hosted runner, which launchd starts as a
 * background job — the `RunAtLoad` spawn is deferred as "speculative" and the
 * process never actually starts (`launchctl print` showed runs=0, no live PID).
 * The deploy then failed with "registered but no live PID".
 *
 * Fix: after loading, explicitly `launchctl kickstart -k gui/<uid>/<label>` to
 * force launchd to spawn the job into the GUI domain. cmd_start / cmd_install /
 * cmd_reinstall all share this load+kickstart path.
 *
 * Strategy (mirrors service-sh-status.test.ts): a temp fake `launchctl` on PATH
 * records every subcommand and is STATEFUL — `list` reports the service dead
 * until `kickstart` is invoked, after which it reports a live PID. So:
 *   - pre-fix (load only): never kickstarted → stays dead → start exits non-zero
 *   - post-fix (load + kickstart): kickstart flips it live → start exits 0
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  calls: string;
}

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'service-sh-start-test-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * Stateful fake `launchctl`:
 *   - appends each invocation's args to $CALLS_LOG
 *   - `list` prints a live-PID line only once $STARTED_MARKER exists
 *   - `kickstart` creates $STARTED_MARKER (this is the spawn we assert on)
 * $LIVE_PID is a real, alive PID so service.sh's `kill -0` liveness check passes.
 */
function installFakeLaunchctl(): string {
  const fakeBin = path.join(workDir, 'bin');
  const launchctl = path.join(fakeBin, 'launchctl');
  const callsLog = path.join(workDir, 'launchctl-calls.log');
  const startedMarker = path.join(workDir, 'started.marker');
  const livePid = process.pid; // guaranteed alive while this test runs

  const script = `#!/bin/bash
printf '%s\\n' "$*" >> "${callsLog}"
case "$1" in
  list)
    if [[ -f "${startedMarker}" ]]; then
      printf '%s\\t0\\t${LABEL}\\n' "${livePid}"
    fi
    exit 0
    ;;
  kickstart)
    : > "${startedMarker}"
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`;
  execFileSync('mkdir', ['-p', fakeBin]);
  writeFileSync(launchctl, script);
  chmodSync(launchctl, 0o755);
  return fakeBin;
}

function runStart(env: string, extraPath: string): RunResult {
  const homeStub = path.join(workDir, 'home');
  const agentsDir = path.join(homeStub, 'Library', 'LaunchAgents');
  execFileSync('mkdir', ['-p', agentsDir]);
  // cmd_start requires the plist to already exist; contents are irrelevant
  // because our fake launchctl ignores them.
  writeFileSync(path.join(agentsDir, `${LABEL}.plist`), '<plist></plist>');

  let result: RunResult;
  try {
    const stdout = execFileSync('bash', [SERVICE_SH, env, 'start'], {
      env: {
        ...process.env,
        PATH: `${extraPath}:${process.env.PATH ?? ''}`,
        HOME: homeStub,
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
  result.calls = readFileSync(path.join(workDir, 'launchctl-calls.log'), 'utf-8');
  return result;
}

describe('scripts/service.sh start — must force the agent to spawn', () => {
  it('issues `launchctl kickstart` for the label after load', () => {
    const bin = installFakeLaunchctl();

    const result = runStart('dev', bin);

    // The spawn-forcing call must be present and target the service label.
    expect(result.calls).toMatch(/kickstart/);
    expect(result.calls).toMatch(new RegExp(`kickstart.*${LABEL.replace(/\./g, '\\.')}`));
  });

  it('ends with a live process → exit 0 + "started" (load alone is not enough)', () => {
    const bin = installFakeLaunchctl();

    const result = runStart('dev', bin);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/started|RUNNING/i);
  });
});
