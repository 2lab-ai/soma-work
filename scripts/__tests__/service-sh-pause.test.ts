/**
 * `scripts/service.sh` waits on launchd and on processes with real `sleep`s: a 15-second bootout
 * poll, a 25-second wait for the PID lock, `sleep 2` after each kickstart. Under test, launchctl
 * and the daemon are shims, so those waits are pure wall-clock — about 150 s of the merge gate's
 * single-runner test step went to them.
 *
 * Every wait goes through one helper, `pause`. It sleeps exactly the requested seconds, unless
 * the test harness flag (SOMA_TEST_HARNESS=1, the same second signal the script's other test
 * overrides need) is set together with SOMA_SERVICE_WAIT_SCALE, which then scales each wait. A
 * production shell that happens to carry SOMA_SERVICE_WAIT_SCALE waits the full time.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
const SERVICE_SH = path.join(repoRoot, 'scripts/service.sh');
const script = fs.readFileSync(SERVICE_SH, 'utf8');

/** The `pause` function exactly as service.sh defines it. */
function pauseSource(): string {
  const match = script.match(/^pause\(\) \{\n[\s\S]*?^\}\n/m);
  expect(match, 'service.sh defines no top-level `pause() {` function').not.toBeNull();
  return match?.[0] ?? '';
}

const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'service-pause-'));
afterAll(() => fs.rmSync(stubDir, { recursive: true, force: true }));
// A `sleep` that reports the duration it was asked for instead of sleeping.
fs.writeFileSync(path.join(stubDir, 'sleep'), '#!/bin/sh\necho "slept $1"\n', { mode: 0o755 });

function pause(seconds: string, env: Record<string, string>): string {
  return execFileSync('bash', ['-c', `${pauseSource()}\npause ${seconds}`], {
    encoding: 'utf8',
    env: { PATH: `${stubDir}:${process.env.PATH ?? ''}`, ...env },
  }).trim();
}

describe('service.sh pause', () => {
  it('is the only place the script sleeps', () => {
    const body = pauseSource();
    const outside = script
      .replace(body, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .filter((line) => /(^|[\s;&|(])sleep\s/.test(line));
    expect(outside).toEqual([]);
  });

  it('waits the full time in production', () => {
    expect(pause('2', {})).toBe('slept 2');
    expect(pause('15', {})).toBe('slept 15');
  });

  it('ignores the scale without the test harness flag', () => {
    expect(pause('2', { SOMA_SERVICE_WAIT_SCALE: '0.05' })).toBe('slept 2');
    expect(pause('2', { SOMA_SERVICE_WAIT_SCALE: '0.05', SOMA_TEST_HARNESS: '0' })).toBe('slept 2');
  });

  it('scales each wait under the test harness', () => {
    expect(pause('2', { SOMA_SERVICE_WAIT_SCALE: '0.05', SOMA_TEST_HARNESS: '1' })).toBe('slept 0.100');
    expect(pause('1', { SOMA_SERVICE_WAIT_SCALE: '0.05', SOMA_TEST_HARNESS: '1' })).toBe('slept 0.050');
  });

  it('falls back to the full wait on a missing or malformed scale', () => {
    expect(pause('2', { SOMA_TEST_HARNESS: '1' })).toBe('slept 2');
    expect(pause('2', { SOMA_TEST_HARNESS: '1', SOMA_SERVICE_WAIT_SCALE: 'fast' })).toBe('slept 2');
    expect(pause('2', { SOMA_TEST_HARNESS: '1', SOMA_SERVICE_WAIT_SCALE: '-1' })).toBe('slept 2');
  });

  it('is scaled down by every suite that drives service.sh through its long waits', () => {
    for (const suite of ['domain', 'stop', 'system-domain', 'start', 'delegation']) {
      const source = fs.readFileSync(path.join(__dirname, `service-sh-${suite}.test.ts`), 'utf8');
      expect(source, `service-sh-${suite}.test.ts`).toContain("SOMA_SERVICE_WAIT_SCALE: '0.05'");
    }
  });
});
