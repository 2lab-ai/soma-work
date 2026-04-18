/**
 * Pidfile + shutdown ordering tests — plan v8 tests 60-63.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { acquirePidfile } from './pidfile.js';
import { ChildRegistry } from './child-registry.js';
import { FileSessionStore } from './session-store.js';
import { ShutdownCoordinator } from './shutdown.js';
import type { LlmRuntime, Backend } from './types.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pidfile-int-'));
}

function makeFakeRuntime(name: Backend): LlmRuntime {
  return {
    name,
    capabilities: {
      supportsReview: false,
      supportsInterrupt: false,
      supportsResume: true,
      supportsEventStream: false,
    },
    ensureReady: async () => {},
    startSession: async () => ({
      backendSessionId: 'x',
      content: 'x',
      resolvedConfig: {},
    }),
    resumeSession: async () => ({ backendSessionId: 'x', content: 'x' }),
    shutdown: async () => {},
  };
}

describe('Pidfile + shutdown ordering', () => {
  let dir: string;
  let pidPath: string;

  beforeEach(() => {
    dir = tmpDir();
    pidPath = path.join(dir, 'llm-mcp-server.pid');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('first instance boots; second with live first → exit(1) (test 60)', async () => {
    // Spawn a real, different live process whose PID we can write into the
    // pidfile. acquirePidfile checks `oldPid !== myPid` before calling
    // process.exit, so we MUST use a PID that is not our own.
    const liveChild: ChildProcess = spawn('sleep', ['60'], { stdio: 'ignore' });
    // Wait for spawn to fully register before testing.
    await new Promise<void>((resolve, reject) => {
      liveChild.once('spawn', () => resolve());
      liveChild.once('error', reject);
    });
    const otherPid = liveChild.pid!;
    expect(otherPid).toBeGreaterThan(0);
    // Sanity check: the PID is alive from our process's perspective.
    expect(() => process.kill(otherPid, 0)).not.toThrow();
    try {
      fs.writeFileSync(pidPath, String(otherPid), 'utf8');

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`EXIT_${code ?? 0}`);
      }) as never);
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      expect(() => acquirePidfile(pidPath)).toThrow(/EXIT_1/);
      const emitted = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(emitted).toContain('llm.process.already-running');

      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    } finally {
      try { liveChild.kill('SIGKILL'); } catch { /* ignore */ }
    }
  });

  it('empty pidfile (racer just openSync\'d, not yet written) → fail-closed instead of unlink-steal (test 61a)', () => {
    // Simulates: a concurrent process called fs.openSync(path, 'wx') and won
    // the exclusive-create race, but has NOT yet written its PID. The file
    // exists but is empty. If acquirePidfile unlinks on empty read, the
    // racer and us both believe we hold the lock → split-brain.
    //
    // Correct behaviour: after the retry-read window (500ms) without a valid
    // PID, exit(1) rather than unlinking.
    fs.writeFileSync(pidPath, '', 'utf8');

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`EXIT_${code ?? 0}`);
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(() => acquirePidfile(pidPath)).toThrow(/EXIT_1/);
    const emitted = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(emitted).toContain('llm.process.pidfile-unreadable');
    // Crucially: we did NOT unlink the racer's file.
    expect(fs.existsSync(pidPath)).toBe(true);

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('malformed pidfile content (non-numeric) → fail-closed (test 61b)', () => {
    fs.writeFileSync(pidPath, 'not-a-pid\n', 'utf8');

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`EXIT_${code ?? 0}`);
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(() => acquirePidfile(pidPath)).toThrow(/EXIT_1/);
    const emitted = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(emitted).toContain('llm.process.pidfile-unreadable');
    expect(fs.existsSync(pidPath)).toBe(true);

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('stale pidfile (pid not running) → unlinked + proceed (test 61)', () => {
    // Definitely-dead PID: spawn+wait; by the time spawnSync returns the process is gone.
    const r = spawnSync('true', []);
    const deadPid = r.pid ?? 999999;
    fs.writeFileSync(pidPath, String(deadPid), 'utf8');

    const handle = acquirePidfile(pidPath);
    try {
      expect(handle.pid).toBe(process.pid);
      expect(fs.readFileSync(pidPath, 'utf8').trim()).toBe(String(process.pid));
    } finally {
      handle.release();
    }
  });

  it('lock-before-reap order: pidfile acquisition precedes childRegistry.replayAndReap (test 62)', async () => {
    // Simulate the boot sequence documented in llm-mcp-server bootstrap():
    //   1) acquirePidfile
    //   2) childRegistry.replayAndReap
    // If step 1 throws, step 2 must never be called.

    // Another live process owns the pidfile.
    const liveChild: ChildProcess = spawn('sleep', ['60'], { stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => {
      liveChild.once('spawn', () => resolve());
      liveChild.once('error', reject);
    });
    const otherPid = liveChild.pid!;
    try {
      fs.writeFileSync(pidPath, String(otherPid), 'utf8');

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`EXIT_${code ?? 0}`);
      }) as never);
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      const reg = new ChildRegistry(path.join(dir, 'children.jsonl'));
      const reapSpy = vi.spyOn(reg, 'replayAndReap');

      // The bootstrap contract: pidfile FIRST, then reap.
      let reapCalled = false;
      try {
        acquirePidfile(pidPath);
        await reg.replayAndReap();
        reapCalled = true;
      } catch {
        // expected: pidfile.acquirePidfile triggers process.exit which we spied to throw.
      }

      expect(reapCalled).toBe(false);
      expect(reapSpy).not.toHaveBeenCalled();

      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    } finally {
      try { liveChild.kill('SIGKILL'); } catch { /* ignore */ }
    }
  });

  it('graceful shutdown keeps pidfile until drain completes (test 63)', async () => {
    const handle = acquirePidfile(pidPath);
    expect(fs.existsSync(pidPath)).toBe(true);

    const sessionStore = new FileSessionStore(path.join(dir, 'sessions.jsonl'));
    const childRegistry = new ChildRegistry(path.join(dir, 'children.jsonl'), {
      captureFingerprint: () => ({ startTimeToken: 't', cmdFingerprint: 'f' }),
    });
    const runtimes: Record<Backend, LlmRuntime> = {
      codex: makeFakeRuntime('codex'),
      gemini: makeFakeRuntime('gemini'),
    };

    // Seed session store (trigger load).
    await sessionStore.prune();

    const coord = new ShutdownCoordinator({
      pidfile: handle,
      sessionStore,
      childRegistry,
      runtimes,
      drainTimeoutMs: 1_000,
    });

    // Track that pidfile still exists until after drain by intercepting drain.
    let pidfileExistsDuringDrain = true;
    const origDrain = sessionStore.writeQueue.drain.bind(sessionStore.writeQueue);
    vi.spyOn(sessionStore.writeQueue, 'drain').mockImplementation(async () => {
      pidfileExistsDuringDrain = fs.existsSync(pidPath);
      return origDrain();
    });

    await coord.graceful('programmatic');

    expect(pidfileExistsDuringDrain).toBe(true);
    expect(fs.existsSync(pidPath)).toBe(false);
  });

  it('track() rejects ABORTED after graceful() flips accepting (test 63c)', async () => {
    // Without this gate a chat call arriving during drain could mutate session
    // state after the WriteQueue drain barrier fired; the close-barrier would
    // then reject the inner write, leaving the caller with a failed chat and
    // a potentially corrupt partial record. The test ensures accepting=false
    // is observed by track() synchronously on the next invocation.
    const handle = acquirePidfile(pidPath);
    const sessionStore = new FileSessionStore(path.join(dir, 'sessions.jsonl'));
    const childRegistry = new ChildRegistry(path.join(dir, 'children.jsonl'), {
      captureFingerprint: () => ({ startTimeToken: 't', cmdFingerprint: 'f' }),
    });
    const runtimes: Record<Backend, LlmRuntime> = {
      codex: makeFakeRuntime('codex'),
      gemini: makeFakeRuntime('gemini'),
    };
    await sessionStore.prune();

    const coord = new ShutdownCoordinator({
      pidfile: handle,
      sessionStore,
      childRegistry,
      runtimes,
      drainTimeoutMs: 500,
    });

    expect(coord.accepting).toBe(true);
    const gracefulPromise = coord.graceful('programmatic');
    expect(coord.accepting).toBe(false);

    await expect(coord.track(async () => 'result')).rejects.toThrow(/Server shutting down/);
    try {
      await coord.track(async () => 'result');
    } catch (e: any) {
      expect(e.code).toBe('aborted');
    }
    await gracefulPromise;
  });

  it('graceful() executes steps in documented order (test 63d)', async () => {
    // Regression guard: silent reordering (e.g. pidfile.release() before
    // childRegistry.shutdownAll(), or runtime.shutdown() before drain) would
    // pass individual tests but break real shutdown semantics. Record every
    // step via spy and assert the sequence.
    const handle = acquirePidfile(pidPath);
    const sessionStore = new FileSessionStore(path.join(dir, 'sessions.jsonl'));
    const childRegistry = new ChildRegistry(path.join(dir, 'children.jsonl'), {
      captureFingerprint: () => ({ startTimeToken: 't', cmdFingerprint: 'f' }),
    });
    const codexRuntime = makeFakeRuntime('codex');
    const geminiRuntime = makeFakeRuntime('gemini');
    const runtimes: Record<Backend, LlmRuntime> = {
      codex: codexRuntime,
      gemini: geminiRuntime,
    };
    await sessionStore.prune();

    const order: string[] = [];
    vi.spyOn(childRegistry, 'shutdownAll').mockImplementation(async () => {
      order.push('childRegistry.shutdownAll');
    });
    const origSessionDrain = sessionStore.writeQueue.drain.bind(sessionStore.writeQueue);
    vi.spyOn(sessionStore.writeQueue, 'drain').mockImplementation(async () => {
      order.push('sessionStore.drain');
      return origSessionDrain();
    });
    const origChildDrain = childRegistry.writeQueue.drain.bind(childRegistry.writeQueue);
    vi.spyOn(childRegistry.writeQueue, 'drain').mockImplementation(async () => {
      order.push('childRegistry.drain');
      return origChildDrain();
    });
    const releaseSpy = vi.spyOn(handle, 'release').mockImplementation(() => {
      order.push('pidfile.release');
    });
    vi.spyOn(codexRuntime, 'shutdown').mockImplementation(async () => {
      order.push('runtime.codex.shutdown');
    });
    vi.spyOn(geminiRuntime, 'shutdown').mockImplementation(async () => {
      order.push('runtime.gemini.shutdown');
    });

    const coord = new ShutdownCoordinator({
      pidfile: handle,
      sessionStore,
      childRegistry,
      runtimes,
      drainTimeoutMs: 100,
    });
    await coord.graceful('programmatic');

    const childIdx = order.indexOf('childRegistry.shutdownAll');
    const sessionDrainIdx = order.indexOf('sessionStore.drain');
    const childDrainIdx = order.indexOf('childRegistry.drain');
    const releaseIdx = order.indexOf('pidfile.release');
    const runtimeIdxs = [
      order.indexOf('runtime.codex.shutdown'),
      order.indexOf('runtime.gemini.shutdown'),
    ];

    // 3 childRegistry.shutdownAll < 4 sessionStore.drain, childRegistry.drain < 5 pidfile.release < 6 runtime.shutdown
    expect(childIdx).toBeGreaterThanOrEqual(0);
    expect(childIdx).toBeLessThan(sessionDrainIdx);
    expect(childIdx).toBeLessThan(childDrainIdx);
    expect(sessionDrainIdx).toBeLessThan(releaseIdx);
    expect(childDrainIdx).toBeLessThan(releaseIdx);
    for (const i of runtimeIdxs) {
      expect(i).toBeGreaterThan(releaseIdx);
    }
    releaseSpy.mockRestore();

    // Clean up the pidfile manually since we stubbed release().
    try { fs.unlinkSync(pidPath); } catch { /* already gone */ }
  });

  it('concurrent graceful() calls share one drain (test 63b)', async () => {
    // Review fix: a second signal (or BaseMcpServer.run()'s own SIGINT/SIGTERM
    // handler falling through to our override) used to return immediately from
    // graceful(), letting the caller race process.exit() against a still-
    // running drain. Memoization means both awaiters see the same resolution.
    const handle = acquirePidfile(pidPath);
    const sessionStore = new FileSessionStore(path.join(dir, 'sessions.jsonl'));
    const childRegistry = new ChildRegistry(path.join(dir, 'children.jsonl'), {
      captureFingerprint: () => ({ startTimeToken: 't', cmdFingerprint: 'f' }),
    });
    const runtimes: Record<Backend, LlmRuntime> = {
      codex: makeFakeRuntime('codex'),
      gemini: makeFakeRuntime('gemini'),
    };
    await sessionStore.prune();

    const coord = new ShutdownCoordinator({
      pidfile: handle,
      sessionStore,
      childRegistry,
      runtimes,
      drainTimeoutMs: 1_000,
    });

    // Track drain start/finish. If memoization is broken, the second caller
    // resolves before the first finishes the drain.
    let drainCompleted = false;
    const origDrain = sessionStore.writeQueue.drain.bind(sessionStore.writeQueue);
    vi.spyOn(sessionStore.writeQueue, 'drain').mockImplementation(async () => {
      await origDrain();
      // Small delay to make the race visible if memoization were absent.
      await new Promise((r) => setTimeout(r, 50));
      drainCompleted = true;
    });

    const p1 = coord.graceful('SIGTERM');
    const p2 = coord.graceful('programmatic');
    // They must be the SAME promise (memoized), not two racers.
    expect(p1).toBe(p2);
    await Promise.all([p1, p2]);
    expect(drainCompleted).toBe(true);
    expect(fs.existsSync(pidPath)).toBe(false);
  });
});
