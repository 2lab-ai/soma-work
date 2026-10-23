import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { Worker } from 'worker_threads';
import { HierarchicalMemoryFileStore, memoryRoot } from './hierarchical-memory-store';
import { MemoryFileStore } from './memory-file-store';
import { MemoryLockTimeoutError, memoryLockPath, withMemoryLock } from './memory-lock';

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
    fs.writeFileSync(workerData.lockDir + '/owner.json', JSON.stringify({ pid: process.pid, at: Date.now() }));
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
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now() }));
    const t0 = Date.now();
    expect(() => withMemoryLock(data, 'U1', () => 1, { timeoutMs: 150 })).toThrow(MemoryLockTimeoutError);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    fs.rmSync(lock, { recursive: true, force: true });
  });

  it('takes over a lock whose owner is gone or that is older than the stale limit', () => {
    const data = tmpData();
    const lock = memoryLockPath(data, 'U1');
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
    expect(withMemoryLock(data, 'U1', () => 'dead-owner', { timeoutMs: 500 })).toBe('dead-owner');

    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now() - 60_000 }));
    expect(withMemoryLock(data, 'U1', () => 'stale', { timeoutMs: 500, staleMs: 10_000 })).toBe('stale');
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
