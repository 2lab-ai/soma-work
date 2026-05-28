/**
 * Contract tests for `scripts/service.sh status` exit codes.
 *
 * Background (PR #988): the CI Deploy workflow's Verify step runs
 *
 *   bash scripts/service.sh "$ENV" status
 *
 * and treats exit 0 as "deploy succeeded". The previous implementation hit
 * `is_running()` which only checked `launchctl list | grep` — i.e. whether
 * the LaunchAgent label was registered. macOS reports a dead-but-registered
 * service as `-  0  ai.2lab.soma-work.dev` (first column = PID, `-` means
 * "no live process"), and `cmd_status` still printed
 * `[SUCCESS] Service is RUNNING (PID: -)` and exited 0 — CI marked the
 * deploy green even though the node process never came back. Real incident
 * 2026-05-28T08:54Z, dev runtime was dead for ~2h with CI green.
 *
 * These tests pin three exit-code contracts the Verify step relies on:
 *   1. live process (numeric PID + kill -0 ok) → exit 0
 *   2. registered but dead (PID == `-`)        → exit non-zero  ← REGRESSION GUARD
 *   3. not registered at all                   → exit non-zero
 *
 * Strategy: a temp fake `launchctl` script on PATH lets us script every
 * combination from a single test process without touching real launchd.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SERVICE_SH = path.join(REPO_ROOT, 'scripts', 'service.sh');

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'service-sh-test-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * Drop a fake `launchctl` binary on PATH. `listLine` is the exact line
 * `launchctl list` should print when grepping for the service label (or
 * empty string to simulate "not registered").
 *
 * Real macOS output format (3 columns, tab-separated):
 *   <PID>\t<LastExitStatus>\t<Label>
 * where PID is numeric for live, `-` for dead.
 */
function installFakeLaunchctl(listLine: string): string {
  const fakeBin = path.join(workDir, 'bin');
  const launchctl = path.join(fakeBin, 'launchctl');
  // Bash heredoc handles quoting + control over what `list` prints. Other
  // subcommands (load/unload/print/kickstart) are stubbed to exit 0 so we
  // don't need separate fixtures for them.
  const script = `#!/bin/bash
case "$1" in
  list)
    if [[ -n "${listLine.replace(/"/g, '\\"')}" ]]; then
      printf '%s\\n' "${listLine.replace(/"/g, '\\"')}"
    fi
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`;
  // mkdir -p
  execFileSync('mkdir', ['-p', fakeBin]);
  writeFileSync(launchctl, script);
  chmodSync(launchctl, 0o755);
  return fakeBin;
}

function runStatus(env: string, extraPath: string): RunResult {
  // PATH prepended with fake bin so service.sh sees our launchctl first.
  // HOME points at workDir so plist path lookups don't hit the real
  // ~/Library/LaunchAgents and pollute the test machine.
  const homeStub = path.join(workDir, 'home');
  execFileSync('mkdir', ['-p', path.join(homeStub, 'Library', 'LaunchAgents')]);
  try {
    const stdout = execFileSync('bash', [SERVICE_SH, env, 'status'], {
      env: {
        ...process.env,
        PATH: `${extraPath}:${process.env.PATH ?? ''}`,
        HOME: homeStub,
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

describe('scripts/service.sh status — exit-code contract', () => {
  it('alive: numeric PID + label present → exit 0 + "RUNNING"', () => {
    // Use this test process's PID — guaranteed alive when service.sh runs
    // `kill -0` for liveness verification.
    const livePid = process.pid;
    const bin = installFakeLaunchctl(`${livePid}\t0\tai.2lab.soma-work.dev`);

    const result = runStatus('dev', bin);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/RUNNING/);
    expect(result.stdout).toContain(String(livePid));
  });

  it('STALE (the bug): registered but PID `-` → exit non-zero, NOT "[SUCCESS] RUNNING"', () => {
    // This is the exact macOS launchctl output for a LaunchAgent whose
    // process died but whose label is still loaded. Pre-fix, cmd_status
    // emitted "[SUCCESS] Service is RUNNING (PID: -)" with exit 0 — the
    // CI Verify step then marked a dead deploy as green.
    const bin = installFakeLaunchctl('-\t0\tai.2lab.soma-work.dev');

    const result = runStatus('dev', bin);

    expect(result.status).not.toBe(0);
    // Must NOT claim success.
    expect(result.stdout).not.toMatch(/\[SUCCESS\] Service is RUNNING \(PID: -\)/);
    // Should surface the dead-but-registered state clearly so CI logs
    // tell the operator what to look at.
    expect(result.stdout).toMatch(/STALE|DEAD|NOT RUNNING|registered but no live/i);
  });

  it('STOPPED: not registered at all → exit non-zero + "STOPPED"', () => {
    const bin = installFakeLaunchctl(''); // empty `launchctl list` output

    const result = runStatus('dev', bin);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/STOPPED|not.*running/i);
  });
});
