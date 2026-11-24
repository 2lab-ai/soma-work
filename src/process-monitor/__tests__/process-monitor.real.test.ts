/**
 * The monitor against the real OS: a process tree spawned through the same SDK spawn hook a session's Claude Code
 * process uses, sampled with the real `ps`, paused and resumed with real signals. Runs on macOS and Linux (CI).
 */
import { type ChildProcess, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createTrackedClaudeProcessSpawner,
  getClaudeChildProcessRegistry,
} from '../../agent-runtime/claude-child-process-registry';
import { LocalProcessMonitor, parseProcStatCpuSeconds, readLinuxCpuSeconds, runReadOnly } from '../index';
import { parseCpuTime } from '../ps-table';
import type { SessionProcessDetail } from '../types';

const posix = process.platform === 'darwin' || process.platform === 'linux';
let child: ChildProcess | null = null;

afterEach(() => {
  if (child?.pid) {
    // The whole fixture tree: continue (a failed assertion may have left one stopped), then kill the children, then the
    // shell.
    for (const sig of ['-CONT', '-KILL']) {
      try {
        execFileSync('pkill', [sig, '-P', String(child.pid)], { stdio: 'ignore' });
      } catch {
        // none left
      }
    }
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {
      // gone
    }
  }
  // Descendants that outlived their shell (re-parented by the OS) carry the fixture's marker in their argv.
  for (const sig of ['-CONT', '-KILL']) {
    try {
      execFileSync('pkill', [sig, '-f', 'sleep 6[0-9][.]73519'], { stdio: 'ignore' });
    } catch {
      // none left
    }
  }
  child = null;
  getClaudeChildProcessRegistry().resetForTests();
});

const until = <T>(read: () => Promise<T | undefined>, timeout = 8_000): Promise<T> =>
  vi.waitUntil(read, { timeout, interval: 100 }) as Promise<T>;

describe.skipIf(!posix)('process monitor on the real OS', () => {
  it('sees the session’s whole tree, pauses a child with SIGSTOP and resumes it', async () => {
    const spawn = createTrackedClaudeProcessSpawner(undefined, { sessionKey: 'real-session' });
    // A stand-in for Claude Code: a shell that starts two long children (like a Bash tool and an MCP server).
    child = spawn({
      command: '/bin/sh',
      args: ['-c', 'sleep 61.73519 & sleep 62.73519 & wait'],
      cwd: '/',
      env: { PATH: '/bin:/usr/bin' },
      signal: new AbortController().signal,
    } as never) as unknown as ChildProcess;

    const monitor = new LocalProcessMonitor({
      nodeId: 'test-node',
      roots: getClaudeChildProcessRegistry(),
      runPs: (args) => runReadOnly('ps', args),
      runCommand: runReadOnly,
    });

    const tree = await until<SessionProcessDetail>(async () => {
      const snap = await monitor.sample();
      const s = snap.sessions.find((x) => x.sessionKey === 'real-session');
      return s && s.processCount >= 3 ? s : undefined;
    });
    expect(tree.rootAlive).toBe(true);
    expect(tree.processes[0]).toMatchObject({ pid: child.pid, role: 'root', depth: 0, name: 'sh' });
    const sleeps = tree.processes.filter((p) => p.name === 'sleep');
    expect(sleeps).toHaveLength(2);
    expect(sleeps.every((p) => p.role === 'child' && p.depth === 1)).toBe(true);
    expect(tree.rssBytes).toBeGreaterThan(0);

    const target = sleeps[0];
    const paused = await monitor.control({
      sessionKey: 'real-session',
      pid: target.pid,
      startToken: target.startToken,
      action: 'pause',
    });
    expect(paused).toEqual({ ok: true, pid: target.pid, state: 'stopped' });
    expect((await monitor.fresh(0)).sessions[0].stoppedCount).toBe(1);

    const resumed = await monitor.control({
      sessionKey: 'real-session',
      pid: target.pid,
      startToken: target.startToken,
      action: 'resume',
    });
    expect(resumed.ok).toBe(true);
    expect(resumed.ok && resumed.state).not.toBe('stopped');

    // A pid with the wrong start time is never signalled.
    expect(
      await monitor.control({
        sessionKey: 'real-session',
        pid: target.pid,
        startToken: 'Thu Jan  1 00:00:00 1970',
        action: 'pause',
      }),
    ).toEqual({ ok: false, reason: 'stale' });
    // The daemon itself is not in any session's tree.
    expect(
      await monitor.control({ sessionKey: 'real-session', pid: process.pid, startToken: 'x', action: 'pause' }),
    ).toEqual({ ok: false, reason: 'not-found' });
  }, 20_000);

  it('an abort continues a paused Claude Code process so the kill can land', async () => {
    const controller = new AbortController();
    const spawn = createTrackedClaudeProcessSpawner(undefined, { sessionKey: 'abort-session' });
    child = spawn({
      command: '/bin/sh',
      args: ['-c', 'sleep 63.73519'],
      cwd: '/',
      env: { PATH: '/bin:/usr/bin' },
      signal: controller.signal,
    } as never) as unknown as ChildProcess;
    const exited = new Promise<void>((resolve) => child?.once('exit', () => resolve()));
    child.on('error', () => {});

    const monitor = new LocalProcessMonitor({
      nodeId: 'test-node',
      roots: getClaudeChildProcessRegistry(),
      runPs: (args) => runReadOnly('ps', args),
      runCommand: runReadOnly,
    });
    const root = await until(async () => {
      const s = (await monitor.sample()).sessions.find((x) => x.sessionKey === 'abort-session');
      return s?.processes.find((p) => p.role === 'root');
    });
    expect(
      await monitor.control({
        sessionKey: 'abort-session',
        pid: root.pid,
        startToken: root.startToken,
        action: 'pause',
      }),
    ).toMatchObject({ ok: true, state: 'stopped' });

    controller.abort();
    await expect(
      Promise.race([exited.then(() => 'exited'), new Promise((r) => setTimeout(() => r('stuck'), 5_000))]),
    ).resolves.toBe('exited');
  }, 20_000);

  it('the spawner alone continues a stopped Claude Code process on abort (no monitor involved)', async () => {
    const controller = new AbortController();
    const spawn = createTrackedClaudeProcessSpawner(undefined, { sessionKey: 'spawner-only' });
    // Like Claude Code, it handles SIGTERM. A handled signal waits while the process is stopped (an unhandled
    // SIGTERM would end even a stopped process, and prove nothing here).
    child = spawn({
      command: process.execPath,
      args: [
        '-e',
        "process.on('SIGTERM', () => process.exit(0)); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)",
      ],
      cwd: '/',
      env: { PATH: '/bin:/usr/bin' },
      signal: controller.signal,
    } as never) as unknown as ChildProcess;
    const exited = new Promise<void>((resolve) => child?.once('exit', () => resolve()));
    child.on('error', () => {});
    const pid = child.pid as number;
    // It says so once its SIGTERM handler is installed.
    await new Promise<void>((resolve) => child?.stdout?.on('data', (d) => String(d).includes('ready') && resolve()));
    // Stopped from outside — not by a monitor, so only the spawner's own SIGCONT can let the abort's SIGTERM land.
    process.kill(pid, 'SIGSTOP');
    await until(async () => {
      const stat = (await runReadOnly('ps', ['-o', 'stat=', '-p', String(pid)])).trim();
      return stat.startsWith('T') ? stat : undefined;
    });
    controller.abort();
    await expect(
      Promise.race([exited.then(() => 'exited'), new Promise((r) => setTimeout(() => r('stuck'), 5_000))]),
    ).resolves.toBe('exited');
  }, 20_000);

  it('an abort that comes after the Claude Code process already exited still reaches the monitor', async () => {
    const controller = new AbortController();
    const spawn = createTrackedClaudeProcessSpawner(undefined, { sessionKey: 'late-abort' });
    child = spawn({
      command: '/bin/sh',
      args: ['-c', 'exit 0'],
      cwd: '/',
      env: { PATH: '/bin:/usr/bin' },
      signal: controller.signal,
    } as never) as unknown as ChildProcess;
    await new Promise<void>((resolve) => child?.once('exit', () => resolve()));
    const seen: unknown[] = [];
    const off = getClaudeChildProcessRegistry().onAbort((r) => seen.push(r));
    try {
      controller.abort();
      expect(seen).toEqual([{ pid: child.pid, sessionKey: 'late-abort', turnId: expect.any(Number) }]);
    } finally {
      off();
    }
  });
  it('holds a task over its CPU cap to the cap: a spinning child at ~100% runs at about 50% under a 50% cap', async () => {
    const spawn = createTrackedClaudeProcessSpawner(undefined, { sessionKey: 'capped-session' });
    child = spawn({
      command: '/bin/sh',
      args: ['-c', `"${process.execPath}" -e "for(;;){}" & sleep 63.73519 & wait`],
      cwd: '/',
      env: { PATH: '/bin:/usr/bin' },
      signal: new AbortController().signal,
    } as never) as unknown as ChildProcess;
    const monitor = new LocalProcessMonitor({
      nodeId: 'test-node',
      roots: getClaudeChildProcessRegistry(),
      runPs: (args) => runReadOnly('ps', args),
      runCommand: runReadOnly,
      // As production wires it: Linux ps time has whole-second resolution, /proc ticks do not.
      readCpuSeconds: process.platform === 'linux' ? readLinuxCpuSeconds : undefined,
    });
    monitor.setCpuCaps(() => 50);
    const cpuOf = (pid: number): number => {
      if (process.platform === 'linux') return parseProcStatCpuSeconds(readFileSync(`/proc/${pid}/stat`, 'utf8')) ?? 0;
      return (
        parseCpuTime(
          execFileSync('ps', ['-o', 'time=', '-p', String(pid)])
            .toString()
            .trim(),
        ) ?? 0
      );
    };
    let spinnerPid = 0;
    try {
      // Two samples: the second measures the spinner at about one core — over the cap, so the cap starts holding it.
      const spinner = await until(async () => {
        const s = (await monitor.sample()).sessions.find((x) => x.sessionKey === 'capped-session');
        return s?.processes.find((p) => p.name === 'node');
      });
      spinnerPid = spinner.pid;
      await new Promise((r) => setTimeout(r, 1_200));
      const metered = (await monitor.sample()).sessions.find((x) => x.sessionKey === 'capped-session');
      expect(metered).toMatchObject({ cpuCapPercent: 50, throttling: true });
      // Let the share settle, then measure 4 s of the spinner's own CPU time.
      await new Promise((r) => setTimeout(r, 1_500));
      const t0 = Date.now();
      const c0 = cpuOf(spinner.pid);
      await new Promise((r) => setTimeout(r, 4_000));
      const rate = ((cpuOf(spinner.pid) - c0) / ((Date.now() - t0) / 1000)) * 100;
      expect(rate).toBeGreaterThan(20);
      expect(rate).toBeLessThan(75);
    } finally {
      monitor.dispose();
    }
    // Disposed: nothing is left held.
    expect(
      execFileSync('ps', ['-o', 'stat=', '-p', String(spinnerPid)])
        .toString()
        .trim(),
    ).not.toMatch(/^T/);
  }, 20_000);
});
