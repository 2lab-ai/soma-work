import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { Worker } from 'worker_threads';
import {
  HierarchicalMemoryFileStore,
  l1FilePath,
  legacyL1FilePath,
  memoryRoot,
  migrateLegacyL1,
} from './hierarchical-memory-store';
import { MemoryFileStore } from './memory-file-store';
import { MemoryLockTimeoutError, memoryLockPath, reapIfStill, withMemoryLock } from './memory-lock';

// SSOT 2026-10-23 T3 (design review P1) — the dashboard becomes a third writer
// of a user's memory files, next to the host process and the model-command MCP
// subprocess. Every writer takes the same per-user lock, so an edit that reads,
// checks and replaces a file can never lose a block another process appended
// in between.

function tmpData(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'memlock-'));
}

/** Another process holding the lock: a worker thread that owns the lock dir for `ms`. */
function holdLockElsewhere(lockDir: string, ms: number): Promise<Worker> {
  const code = `
    const fs = require('fs');
    const { parentPort, workerData } = require('worker_threads');
    fs.mkdirSync(workerData.lockDir, { recursive: false });
    fs.writeFileSync(workerData.lockDir + '/owner-W.json', JSON.stringify({ pid: process.pid, token: 'W', at: Date.now() }));
    parentPort.postMessage('locked');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.ms);
    fs.rmSync(workerData.lockDir, { recursive: true, force: true });
    parentPort.postMessage('released');
  `;
  return new Promise((resolve) => {
    const w = new Worker(code, { eval: true, workerData: { lockDir, ms } });
    w.on('message', (m) => {
      if (m === 'locked') resolve(w);
    });
  });
}

describe('memory lock', () => {
  it('runs the body, releases afterwards, and is re-entrant in one process', () => {
    const data = tmpData();
    const lock = memoryLockPath(data, 'U1');
    const out = withMemoryLock(data, 'U1', () => {
      expect(fs.existsSync(lock)).toBe(true);
      return withMemoryLock(data, 'U1', () => 42);
    });
    expect(out).toBe(42);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('releases even when the body throws', () => {
    const data = tmpData();
    expect(() =>
      withMemoryLock(data, 'U1', () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(fs.existsSync(memoryLockPath(data, 'U1'))).toBe(false);
  });

  it('a live holder elsewhere makes a writer wait, then time out', () => {
    const data = tmpData();
    const lock = memoryLockPath(data, 'U1');
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(
      path.join(lock, 'owner-LIVE.json'),
      JSON.stringify({ pid: process.pid, token: 'LIVE', at: Date.now() }),
    );
    const t0 = Date.now();
    expect(() => withMemoryLock(data, 'U1', () => 1, { timeoutMs: 150 })).toThrow(MemoryLockTimeoutError);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    fs.rmSync(lock, { recursive: true, force: true });
  });

  function plant(lock: string, owner: Record<string, unknown>) {
    fs.rmSync(lock, { recursive: true, force: true });
    fs.mkdirSync(lock, { recursive: true });
    const rec = { token: 'T0', host: os.hostname(), ...owner };
    fs.writeFileSync(path.join(lock, `owner-${rec.token}.json`), JSON.stringify(rec));
  }
  const DEAD_PID = 2 ** 22 + 12345;

  it('takes over a same-host lock whose owner died (after a short grace), or a foreign-host lock older than the stale limit', () => {
    const data = tmpData();
    const lock = memoryLockPath(data, 'U1');
    plant(lock, { pid: DEAD_PID, at: Date.now() - 5_000 });
    expect(withMemoryLock(data, 'U1', () => 'dead-owner', { timeoutMs: 500 })).toBe('dead-owner');

    plant(lock, { pid: process.pid, host: 'some-other-host', at: Date.now() - 120_000 });
    expect(withMemoryLock(data, 'U1', () => 'stale', { timeoutMs: 500, staleMs: 60_000 })).toBe('stale');
  });

  it('does not judge a fresh lock by its pid: a just-died owner gets a grace, another host only the stale limit (review P1)', () => {
    const data = tmpData();
    const lock = memoryLockPath(data, 'U1');
    plant(lock, { pid: DEAD_PID, at: Date.now() });
    expect(() => withMemoryLock(data, 'U1', () => 1, { timeoutMs: 200 })).toThrow(MemoryLockTimeoutError);
    plant(lock, { pid: DEAD_PID, host: 'some-other-host', at: Date.now() - 5_000 });
    expect(() => withMemoryLock(data, 'U1', () => 1, { timeoutMs: 200 })).toThrow(MemoryLockTimeoutError);
    expect(fs.existsSync(lock)).toBe(true);
  });

  const PROCESS_STARTED_AT = Date.now() - process.uptime() * 1000;

  it('never takes over a same-host lock whose owner process is still alive, however old (review R2 P1)', () => {
    const data = tmpData();
    const lock = memoryLockPath(data, 'U1');
    plant(lock, { pid: process.pid, startedAt: PROCESS_STARTED_AT, at: Date.now() - 10 * 60_000 });
    expect(() => withMemoryLock(data, 'U1', () => 1, { timeoutMs: 200 })).toThrow(MemoryLockTimeoutError);
    expect(fs.existsSync(lock)).toBe(true);
  });

  it('takes over when the recorded pid now belongs to another process (pid reuse)', () => {
    const data = tmpData();
    const lock = memoryLockPath(data, 'U1');
    // the recorded owner started 10 days before the process that now has this pid
    plant(lock, { pid: process.pid, startedAt: PROCESS_STARTED_AT - 10 * 86_400_000, at: Date.now() - 15_000 });
    expect(withMemoryLock(data, 'U1', () => 'reused', { timeoutMs: 1_000 })).toBe('reused');
  });

  it('pid reuse is still detected when the shell runs a non-English locale (#379 review R3)', () => {
    const data = tmpData();
    const lock = memoryLockPath(data, 'U1');
    plant(lock, { pid: process.pid, startedAt: PROCESS_STARTED_AT - 10 * 86_400_000, at: Date.now() - 15_000 });
    const saved = { LC_ALL: process.env.LC_ALL, LANG: process.env.LANG, LC_TIME: process.env.LC_TIME };
    // `ps -o lstart=` prints a localized date under ko_KR ("2026년 10월 23일 …"), which Date.parse cannot read
    Object.assign(process.env, { LC_ALL: 'ko_KR.UTF-8', LANG: 'ko_KR.UTF-8', LC_TIME: 'ko_KR.UTF-8' });
    try {
      expect(withMemoryLock(data, 'U1', () => 'reused', { timeoutMs: 1_000 })).toBe('reused');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('release removes only its own lock — a lock that was reaped and re-taken by another owner stays (review P1)', () => {
    const data = tmpData();
    const lock = memoryLockPath(data, 'U1');
    withMemoryLock(data, 'U1', () => {
      // meanwhile a reaper took the lock over and someone else holds it now
      fs.rmSync(lock, { recursive: true, force: true });
      plant(lock, { pid: process.pid, token: 'OTHER', at: Date.now() });
    });
    expect(ownerToken(lock)).toBe('OTHER');
  });

  it('a reaper removes only the lock it judged abandoned; of two reapers only one commits (review P1, R3)', () => {
    const data = tmpData();
    const lock = memoryLockPath(data, 'U1');
    // judged T0 abandoned, but the lock now belongs to a new owner T1
    plant(lock, { pid: process.pid, token: 'T1', at: Date.now() });
    expect(reapIfStill(lock, 'T0')).toBe(false);
    expect(ownerToken(lock)).toBe('T1');
    // two reapers judged the same dead owner: the first commits, the second finds nothing to move
    plant(lock, { pid: DEAD_PID, token: 'T0', at: Date.now() - 5_000 });
    expect(reapIfStill(lock, 'T0')).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
    expect(reapIfStill(lock, 'T0')).toBe(false);
  });

  it('an empty .lock left by a crash mid-release is replaced by the next acquire; a .lock with junk is never removed', () => {
    const data = tmpData();
    const lock = memoryLockPath(data, 'U1');
    fs.mkdirSync(lock, { recursive: true });
    expect(withMemoryLock(data, 'U1', () => 'took-over-empty', { timeoutMs: 500 })).toBe('took-over-empty');
    expect(fs.existsSync(lock)).toBe(false);
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, 'something-else'), 'x');
    expect(() => withMemoryLock(data, 'U1', () => 1, { timeoutMs: 150 })).toThrow(MemoryLockTimeoutError);
    expect(fs.existsSync(path.join(lock, 'something-else'))).toBe(true);
  });

  /** The token of the owner the lock dir records. */
  function ownerToken(lock: string): string | null {
    if (!fs.existsSync(lock)) return null;
    for (const f of fs.readdirSync(lock)) {
      if (/^owner-.+\.json$/.test(f)) {
        return JSON.parse(fs.readFileSync(path.join(lock, f), 'utf-8')).token ?? null;
      }
    }
    return null;
  }

  it('a reaper paused right before its commit cannot remove the lock a newer owner took meanwhile (review R3 P1)', () => {
    const data = tmpData();
    const lock = memoryLockPath(data, 'U1');
    plant(lock, { pid: DEAD_PID, token: 'OLD', at: Date.now() - 5_000 });
    const reaped = reapIfStill(lock, 'OLD', {
      beforeCommit: () => {
        // A is frozen here for seconds. Meanwhile another reaper removed the dead owner's lock and B took it.
        fs.rmSync(lock, { recursive: true, force: true });
        plant(lock, { pid: process.pid, token: 'B', startedAt: PROCESS_STARTED_AT, at: Date.now() });
      },
    });
    expect(reaped).toBe(false);
    expect(ownerToken(lock)).toBe('B');
  });

  it('an episodic append waits for an edit held by another process, and is not lost', async () => {
    const data = tmpData();
    const store = new HierarchicalMemoryFileStore(data);
    store.appendEpisodic('U1', 'first', '2026-10-23');
    const worker = await holdLockElsewhere(memoryLockPath(data, 'U1'), 300);
    const t0 = Date.now();
    store.appendEpisodic('U1', 'second', '2026-10-23');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(200);
    await worker.terminate();
    const raw = fs.readFileSync(path.join(memoryRoot(data, 'U1'), 'episodic', '2026-10-23.md'), 'utf-8');
    expect(raw).toContain('first');
    expect(raw).toContain('second');
  });

  it("a legacy L1 migration waits for the lock and decides inside it: a locked writer's save survives (review R4)", async () => {
    const data = tmpData();
    const legacy = legacyL1FilePath(data, 'U1', 'memory');
    const canonical = l1FilePath(data, 'U1', 'memory');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, 'legacy note', 'utf-8');
    // Another process holds the lock and saves the canonical file meanwhile.
    fs.mkdirSync(path.dirname(canonical), { recursive: true });
    const worker = await holdLockElsewhere(memoryLockPath(data, 'U1'), 300);
    fs.writeFileSync(canonical, 'legacy note\n§\nnew saved note', 'utf-8');
    const t0 = Date.now();
    expect(migrateLegacyL1(data, 'U1', 'memory')).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(200);
    await worker.terminate();
    expect(fs.readFileSync(canonical, 'utf-8')).toBe('legacy note\n§\nnew saved note');
    expect(fs.existsSync(legacy)).toBe(false);
    const leftovers = fs.readdirSync(path.dirname(canonical)).filter((f) => f.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('the MCP-side L1 store takes the same lock and writes atomically', async () => {
    const data = tmpData();
    const l1 = new MemoryFileStore(data);
    l1.addMemory('U1', 'memory', 'one');
    const worker = await holdLockElsewhere(memoryLockPath(data, 'U1'), 250);
    const t0 = Date.now();
    expect(l1.addMemory('U1', 'memory', 'two').ok).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
    await worker.terminate();
    expect(l1.loadMemory('U1', 'memory').entries).toEqual(['one', 'two']);
    const leftovers = fs.readdirSync(memoryRoot(data, 'U1')).filter((f) => f.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });
});
