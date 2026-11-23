import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parseProcStatCpuSeconds, runReadOnly } from '../index';

describe('parseProcStatCpuSeconds (Linux /proc/<pid>/stat)', () => {
  it('reads utime + stime after the parenthesised name, which may hold spaces and parentheses', () => {
    // pid (comm) state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime …
    const stat = '4242 (node (worker) x) S 1 4242 4242 0 -1 4194560 1200 0 3 0 250 37 0 0 20 0 11 0 9999 1 2';
    expect(parseProcStatCpuSeconds(stat)).toBeCloseTo(2.87);
    expect(parseProcStatCpuSeconds(stat, 1000)).toBeCloseTo(0.287);
  });

  it('answers null for anything else', () => {
    expect(parseProcStatCpuSeconds('')).toBeNull();
    expect(parseProcStatCpuSeconds('1 (x) S 1')).toBeNull();
  });
});

describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('runReadOnly (real ps)', () => {
  it('a -p pid that is gone is an empty answer, not an error', async () => {
    const gone = spawnSync('/usr/bin/true').pid;
    await expect(runReadOnly('ps', ['-o', 'pid=', '-p', String(gone)])).resolves.toBe('');
  });

  it('ps refusing its arguments is an error, not an empty answer', async () => {
    await expect(runReadOnly('ps', ['-o', 'no-such-column-xyz=', '-p', String(process.pid)])).rejects.toBeTruthy();
  });
});
