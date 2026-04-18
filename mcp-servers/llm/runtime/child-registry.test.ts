/**
 * ChildRegistry tests — plan v8 tests 53-59d.
 *
 * Uses real spawned `sleep` children for liveness-based tests (55, 56).
 * Uses `process.pid` as a stable "always alive, never kill" proxy with a
 * process.kill spy for unkillable-survivor tests (57, 58).
 * Uses captureFingerprint injection for PID-reuse tests (59b, 59c, 59d).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { ChildRegistry, captureFingerprint, type Fingerprint } from './child-registry.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'child-registry-test-'));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}

/** Spawn a detached sleep process; returns {pid, cleanup}. */
function spawnSleep(seconds: number): { pid: number; proc: ChildProcess } {
  const proc = spawn('sleep', [String(seconds)], { stdio: 'ignore', detached: false });
  if (!proc.pid) throw new Error('failed to spawn sleep');
  return { pid: proc.pid, proc };
}

function writeRawJsonl(filePath: string, records: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
  fs.writeFileSync(filePath, body, 'utf8');
}

describe('ChildRegistry', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = tmpDir();
    filePath = path.join(dir, 'llm-children.jsonl');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('append then remove → file reflects live children (test 53)', async () => {
    const reg = new ChildRegistry(filePath, {
      captureFingerprint: () => ({ startTimeToken: 'token-A', cmdFingerprint: 'fp-A' }),
    });
    await reg.append(12345, 'codex');
    await reg.append(67890, 'gemini');
    expect(reg.getRecords()).toHaveLength(2);

    await reg.remove(12345);
    const records = reg.getRecords();
    expect(records).toHaveLength(1);
    expect(records[0].pid).toBe(67890);

    // Persistence — reload.
    const reg2 = new ChildRegistry(filePath);
    expect(reg2.getRecords().map((r) => r.pid)).toEqual([67890]);
  });

  it('100 concurrent append+remove pairs → no lost entries (test 54)', async () => {
    const reg = new ChildRegistry(filePath, {
      captureFingerprint: (pid) => ({
        startTimeToken: `t-${pid}`,
        cmdFingerprint: `fp-${pid}`,
      }),
    });
    const ops: Promise<void>[] = [];
    for (let i = 0; i < 100; i++) {
      ops.push(reg.append(10000 + i, 'codex'));
    }
    await Promise.all(ops);
    expect(reg.getRecords()).toHaveLength(100);

    // Remove every other one concurrently.
    const removes: Promise<void>[] = [];
    for (let i = 0; i < 100; i += 2) {
      removes.push(reg.remove(10000 + i));
    }
    await Promise.all(removes);
    expect(reg.getRecords()).toHaveLength(50);

    // Verify file is consistent on reload.
    const reg2 = new ChildRegistry(filePath);
    expect(reg2.getRecords()).toHaveLength(50);
  });

  it('replayAndReap: dead pid → record dropped (test 55)', async () => {
    // Use a pid that is definitely dead: spawn then wait for exit.
    const { pid, proc } = spawnSleep(0);
    await new Promise<void>((r) => proc.once('exit', () => r()));
    // Give the OS a moment to free the PID.
    await sleep(50);

    writeRawJsonl(filePath, [{
      pid,
      backend: 'codex',
      spawnedAt: new Date().toISOString(),
      startTimeToken: '',
      cmdFingerprint: '',
    }]);

    const reg = new ChildRegistry(filePath);
    await reg.replayAndReap();
    expect(reg.getRecords()).toHaveLength(0);
  });

  it('replayAndReap: live pid → SIGTERM confirmed dead → dropped (test 56)', async () => {
    const { pid, proc } = spawnSleep(60);
    try {
      writeRawJsonl(filePath, [{
        pid,
        backend: 'codex',
        spawnedAt: new Date().toISOString(),
        startTimeToken: '',
        cmdFingerprint: '',
      }]);

      const reg = new ChildRegistry(filePath);
      await reg.replayAndReap();

      expect(reg.getRecords()).toHaveLength(0);
      // Process should be gone.
      let alive = true;
      try { process.kill(pid, 0); } catch { alive = false; }
      expect(alive).toBe(false);
    } finally {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }, 10_000);

  it('replayAndReap: unkillable pid → survivor persisted with reapAttempts=1 (test 57)', async () => {
    // Use our own PID so isAlive is always true. Spy on process.kill so neither
    // SIGTERM nor SIGKILL actually touches the runner.
    const ourPid = process.pid;
    writeRawJsonl(filePath, [{
      pid: ourPid,
      backend: 'codex',
      spawnedAt: new Date().toISOString(),
      startTimeToken: '',
      cmdFingerprint: '',
    }]);

    const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid: number, sig?: string | number) => {
      // Signal 0 is the liveness probe — allow it to succeed.
      if (sig === 0 || sig === undefined) return true;
      // SIGTERM/SIGKILL: pretend we sent, but do nothing — process remains alive.
      return true;
    });

    const reg = new ChildRegistry(filePath);
    await reg.replayAndReap();

    const records = reg.getRecords();
    expect(records).toHaveLength(1);
    expect(records[0].pid).toBe(ourPid);
    expect(records[0].reapAttempts).toBe(1);
    expect(records[0].lastReapAt).toBeDefined();

    killSpy.mockRestore();
  }, 20_000);

  it('replayAndReap: survivor with reapAttempts=10 → bumped to 11 + unkillable log (test 58)', async () => {
    const ourPid = process.pid;
    writeRawJsonl(filePath, [{
      pid: ourPid,
      backend: 'codex',
      spawnedAt: new Date().toISOString(),
      startTimeToken: '',
      cmdFingerprint: '',
      reapAttempts: 10,
    }]);

    const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid: number, sig?: string | number) => {
      if (sig === 0 || sig === undefined) return true;
      return true;
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const reg = new ChildRegistry(filePath);
    await reg.replayAndReap();

    const records = reg.getRecords();
    expect(records).toHaveLength(1);
    expect(records[0].reapAttempts).toBe(11);

    // stderr should carry the unkillable log line.
    const emitted = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(emitted).toContain('llm.orphan.unkillable');

    killSpy.mockRestore();
    stderrSpy.mockRestore();
  }, 20_000);

  it('shutdownAll: all live pids SIGTERMed; survivors file-updated (test 59)', async () => {
    const { pid: pid1, proc: p1 } = spawnSleep(60);
    const { pid: pid2, proc: p2 } = spawnSleep(60);
    try {
      const reg = new ChildRegistry(filePath, {
        captureFingerprint: () => ({ startTimeToken: 't', cmdFingerprint: 'f' }),
      });
      await reg.append(pid1, 'codex');
      await reg.append(pid2, 'gemini');
      expect(reg.getRecords()).toHaveLength(2);

      await reg.shutdownAll();

      // Both processes should be gone.
      let alive1 = true, alive2 = true;
      try { process.kill(pid1, 0); } catch { alive1 = false; }
      try { process.kill(pid2, 0); } catch { alive2 = false; }
      expect(alive1).toBe(false);
      expect(alive2).toBe(false);

      // Registry should be empty (all records purged).
      expect(reg.getRecords()).toHaveLength(0);
    } finally {
      try { p1.kill('SIGKILL'); } catch { /* ignore */ }
      try { p2.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }, 10_000);

  it('v8 PID reuse: startTimeToken mismatch → drop without kill (test 59b)', async () => {
    const { pid, proc } = spawnSleep(60);
    try {
      writeRawJsonl(filePath, [{
        pid,
        backend: 'codex',
        spawnedAt: new Date().toISOString(),
        startTimeToken: 'STORED-TOKEN',
        cmdFingerprint: 'STORED-FP',
      }]);

      let killCalls = 0;
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid: number, sig?: string | number) => {
        if (sig === 0 || sig === undefined) return true;
        killCalls++;
        return true;
      });

      const reg = new ChildRegistry(filePath, {
        captureFingerprint: (): Fingerprint | null => ({
          startTimeToken: 'DIFFERENT-TOKEN',
          cmdFingerprint: 'STORED-FP',
        }),
      });
      await reg.replayAndReap();

      expect(reg.getRecords()).toHaveLength(0);
      expect(killCalls).toBe(0);

      killSpy.mockRestore();
    } finally {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }
  });

  it('v8 cmdFingerprint mismatch → drop without kill (test 59c)', async () => {
    const { pid, proc } = spawnSleep(60);
    try {
      writeRawJsonl(filePath, [{
        pid,
        backend: 'codex',
        spawnedAt: new Date().toISOString(),
        startTimeToken: 'STORED-TOKEN',
        cmdFingerprint: 'STORED-FP',
      }]);

      let killCalls = 0;
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid: number, sig?: string | number) => {
        if (sig === 0 || sig === undefined) return true;
        killCalls++;
        return true;
      });

      const reg = new ChildRegistry(filePath, {
        captureFingerprint: () => ({
          startTimeToken: 'STORED-TOKEN',
          cmdFingerprint: 'DIFFERENT-FP',
        }),
      });
      await reg.replayAndReap();

      expect(reg.getRecords()).toHaveLength(0);
      expect(killCalls).toBe(0);

      killSpy.mockRestore();
    } finally {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }
  });

  it('v8 ps unavailable at reap → fallback to plain PID-based reap (test 59d)', async () => {
    const { pid, proc } = spawnSleep(60);
    try {
      writeRawJsonl(filePath, [{
        pid,
        backend: 'codex',
        spawnedAt: new Date().toISOString(),
        startTimeToken: 'STORED-TOKEN',
        cmdFingerprint: 'STORED-FP',
      }]);

      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const reg = new ChildRegistry(filePath, {
        captureFingerprint: () => null, // simulate ps absence
      });

      await reg.replayAndReap();

      // Fallback reap should have killed the live child.
      let alive = true;
      try { process.kill(pid, 0); } catch { alive = false; }
      expect(alive).toBe(false);

      // Record dropped.
      expect(reg.getRecords()).toHaveLength(0);

      const emitted = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(emitted).toContain('llm.fingerprint.unavailable');

      stderrSpy.mockRestore();
    } finally {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }, 10_000);
});

describe('ChildRegistry — hardening (reviewer follow-up)', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'child-registry-harden-'));
    filePath = path.join(dir, 'llm-children.jsonl');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('loader rejects non-positive-integer pid values (test 59e)', () => {
    // Any of pid: 0, -1, 1.5, NaN in the JSONL would let process.kill signal
    // a process group or the server itself. Loader must drop these records.
    writeRawJsonl(filePath, [
      { pid: 0, backend: 'codex', spawnedAt: '2026-04-18T00:00:00.000Z', startTimeToken: 't', cmdFingerprint: 'f' },
      { pid: -1, backend: 'codex', spawnedAt: '2026-04-18T00:00:00.000Z', startTimeToken: 't', cmdFingerprint: 'f' },
      { pid: 1.5, backend: 'codex', spawnedAt: '2026-04-18T00:00:00.000Z', startTimeToken: 't', cmdFingerprint: 'f' },
      { pid: Number.NaN, backend: 'codex', spawnedAt: '2026-04-18T00:00:00.000Z', startTimeToken: 't', cmdFingerprint: 'f' },
      // One valid entry to prove the loader still accepts well-formed records.
      { pid: 99999, backend: 'gemini', spawnedAt: '2026-04-18T00:00:00.000Z', startTimeToken: 't', cmdFingerprint: 'f' },
    ]);

    const reg = new ChildRegistry(filePath);
    const recs = reg.getRecords();
    expect(recs).toHaveLength(1);
    expect(recs[0].pid).toBe(99999);
  });

  it('shutdownAll skips PID-reused entries (fingerprint mismatch → no SIGTERM) (test 59f)', async () => {
    // Simulate: record stored with fingerprint A, but the live PID now has
    // fingerprint B (reused by an unrelated process since our last reap).
    const { pid, proc } = spawnSleep(60);
    try {
      // Override captureFingerprint so append stores 'STORED' but the shutdown
      // re-check returns 'DIFFERENT' — mismatch path.
      let callNum = 0;
      const captureFP = (): Fingerprint | null => {
        callNum += 1;
        if (callNum === 1) return { startTimeToken: 'STORED', cmdFingerprint: 'STORED-FP' };
        return { startTimeToken: 'DIFFERENT', cmdFingerprint: 'DIFFERENT-FP' };
      };
      const reg = new ChildRegistry(filePath, { captureFingerprint: captureFP });
      await reg.append(pid, 'codex');

      const killSpy = vi.spyOn(process, 'kill');
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      await reg.shutdownAll();

      // No SIGTERM/SIGKILL sent to the reused PID.
      const sigCalls = killSpy.mock.calls.filter(([p, sig]) => p === pid && (sig === 'SIGTERM' || sig === 'SIGKILL'));
      expect(sigCalls).toHaveLength(0);

      // Warned.
      const emitted = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(emitted).toContain('llm.orphan.pid-reused');
      // And the phase marker lets operators distinguish shutdown vs. replay.
      // Logger uses JSON.stringify with indentation — accept either spacing.
      expect(emitted).toMatch(/"phase":\s*"shutdown"/);

      killSpy.mockRestore();
      stderrSpy.mockRestore();
    } finally {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }, 10_000);
});

describe('captureFingerprint', () => {
  it('returns a plausible shape for a live PID (smoke)', () => {
    const fp = captureFingerprint(process.pid);
    if (fp === null) {
      // If ps is unavailable in the test environment, skip the shape check.
      // The production fallback path is tested in 59d.
      return;
    }
    expect(fp.startTimeToken.length).toBe(24);
    expect(fp.cmdFingerprint).toMatch(/^[a-f0-9]{12}$/);
  });
});
