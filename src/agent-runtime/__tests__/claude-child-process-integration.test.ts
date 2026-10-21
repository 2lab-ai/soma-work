import { fork } from 'node:child_process';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const harness = path.join(__dirname, 'fixtures', 'claude-child-lifecycle-harness.ts');
const survivorPids = new Set<number>();
const harnessPids = new Set<number>();

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function killIfAlive(pid: number): void {
  if (!isAlive(pid)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function runHarness(mode: 'tracked' | 'untracked'): Promise<number> {
  return await new Promise((resolve, reject) => {
    const parent = fork(harness, [mode], {
      cwd: path.join(__dirname, '..', '..', '..'),
      execArgv: ['--import', 'tsx'],
      silent: true,
    });
    if (parent.pid !== undefined) harnessPids.add(parent.pid);

    let childPid: number | undefined;
    let stderr = '';
    const timeout = setTimeout(() => {
      if (parent.pid !== undefined) killIfAlive(parent.pid);
      if (childPid !== undefined) killIfAlive(childPid);
      reject(new Error(`lifecycle harness timed out in ${mode} mode`));
    }, 4_000);
    timeout.unref?.();

    parent.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    parent.on('message', (message) => {
      const candidate = (message as { childPid?: unknown }).childPid;
      if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate <= 0) return;
      childPid = candidate;
      survivorPids.add(candidate);
    });
    parent.once('error', (error) => {
      clearTimeout(timeout);
      if (parent.pid !== undefined) killIfAlive(parent.pid);
      if (childPid !== undefined) killIfAlive(childPid);
      reject(error);
    });
    parent.once('exit', (code) => {
      clearTimeout(timeout);
      if (parent.pid !== undefined) harnessPids.delete(parent.pid);
      if (code !== 0) {
        if (childPid !== undefined) killIfAlive(childPid);
        reject(new Error(`lifecycle harness exited ${code}: ${stderr}`));
        return;
      }
      if (childPid === undefined) {
        reject(new Error('lifecycle harness exited without reporting its child pid'));
        return;
      }
      resolve(childPid);
    });
  });
}

async function waitForExit(pid: number, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !isAlive(pid);
}

afterEach(() => {
  for (const pid of survivorPids) killIfAlive(pid);
  survivorPids.clear();
  for (const pid of harnessPids) killIfAlive(pid);
  harnessPids.clear();
});

describe('Claude child process ownership integration', () => {
  it('reproduces an untracked stubborn child surviving its parent exit', async () => {
    const childPid = await runHarness('untracked');

    expect(isAlive(childPid)).toBe(true);
  });

  it('reaps a tracked stubborn child before its parent exits', async () => {
    const childPid = await runHarness('tracked');

    expect(await waitForExit(childPid)).toBe(true);
  });
});
