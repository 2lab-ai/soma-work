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
});
