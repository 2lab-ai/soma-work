import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// We need a unique temp dir for each test run
let tempDir: string;

// Mock env-paths before importing the module
vi.mock('../../env-paths', () => ({
  get DATA_DIR() {
    return tempDir;
  },
  IS_DEV: true,
}));
vi.mock('../../logger', () => ({
  Logger: class {
    debug() {}
    info() {}
    warn() {}
    error() {}
  },
}));

describe('HookState', () => {
  let hookState: typeof import('../hook-state').hookState;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-state-test-'));
    vi.resetModules();
    vi.useFakeTimers();

    const mod = await import('../hook-state');
    hookState = mod.hookState;
  });

  afterEach(() => {
    vi.useRealTimers();
    // Clean up temp dir
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // ── Session cleanup ──

  describe('cleanupSession', () => {
    it('should remove all session data', () => {
      hookState.recordCallStart('sess-1', {
        toolName: 'Task',
        callId: 'c1',
        startTime: new Date().toISOString(),
        epoch: Math.floor(Date.now() / 1000),
        description: 'test',
      });

      hookState.cleanupSession('sess-1');

      // The pending call is gone — nothing left to match on end.
      expect(hookState.recordCallEnd('sess-1', 'Task', 'ok')).toBeNull();
    });

    it('should not affect other sessions', () => {
      for (const sessionId of ['sess-1', 'sess-2']) {
        hookState.recordCallStart(sessionId, {
          toolName: 'Task',
          callId: `c-${sessionId}`,
          startTime: new Date().toISOString(),
          epoch: Math.floor(Date.now() / 1000),
          description: 'test',
        });
      }

      hookState.cleanupSession('sess-1');

      expect(hookState.recordCallEnd('sess-1', 'Task', 'ok')).toBeNull();
      expect(hookState.recordCallEnd('sess-2', 'Task', 'ok')?.callId).toBe('c-sess-2');
    });
  });

  // ── Call tracking ──

  describe('recordCallStart/End', () => {
    it('should create a log entry with FIFO matching', () => {
      const startTime = new Date('2026-04-10T10:00:00Z');
      vi.setSystemTime(startTime);

      hookState.recordCallStart('sess-1', {
        toolName: 'Task',
        callId: 'c1',
        startTime: startTime.toISOString(),
        epoch: Math.floor(startTime.getTime() / 1000),
        description: 'first call',
      });

      vi.advanceTimersByTime(1000);

      const entry = hookState.recordCallEnd('sess-1', 'Task', 'ok');
      expect(entry).not.toBeNull();
      expect(entry?.callId).toBe('c1');
      expect(entry?.toolName).toBe('Task');
      expect(entry?.description).toBe('first call');
      expect(entry?.status).toBe('ok');
      expect(entry?.durationMs).toBeGreaterThanOrEqual(1000);
    });

    it('should return null for recordCallEnd without matching start', () => {
      const entry = hookState.recordCallEnd('sess-1', 'Task', 'ok');
      expect(entry).toBeNull();
    });

    it('should use FIFO order for multiple pending calls', () => {
      hookState.recordCallStart('sess-1', {
        toolName: 'Task',
        callId: 'c1',
        startTime: new Date().toISOString(),
        epoch: Math.floor(Date.now() / 1000),
        description: 'first',
      });

      hookState.recordCallStart('sess-1', {
        toolName: 'Task',
        callId: 'c2',
        startTime: new Date().toISOString(),
        epoch: Math.floor(Date.now() / 1000),
        description: 'second',
      });

      const entry1 = hookState.recordCallEnd('sess-1', 'Task', 'ok');
      expect(entry1?.callId).toBe('c1');
      expect(entry1?.description).toBe('first');

      const entry2 = hookState.recordCallEnd('sess-1', 'Task', 'ok');
      expect(entry2?.callId).toBe('c2');
      expect(entry2?.description).toBe('second');
    });
  });

  // ── Call log cap ──

  describe('callLog cap', () => {
    it('should trim call log at 1000 entries', () => {
      for (let i = 0; i < 1010; i++) {
        hookState.recordCallStart('sess-1', {
          toolName: 'Task',
          callId: `c${i}`,
          startTime: new Date().toISOString(),
          epoch: Math.floor(Date.now() / 1000),
          description: `call ${i}`,
        });
        hookState.recordCallEnd('sess-1', 'Task', 'ok');
      }

      const log = hookState.getCallLog();
      expect(log.length).toBeLessThanOrEqual(1000);
      // Should keep the most recent entries
      expect(log[log.length - 1].callId).toBe('c1009');
    });
  });

  // ── Stale cleanup ──

  describe('cleanupStale', () => {
    const startPendingCall = (sessionId: string) => {
      hookState.recordCallStart(sessionId, {
        toolName: 'Task',
        callId: `c-${sessionId}`,
        startTime: new Date().toISOString(),
        epoch: Math.floor(Date.now() / 1000),
        description: 'pending',
      });
    };

    it('should remove entries older than 24 hours', () => {
      vi.setSystemTime(new Date('2026-04-10T12:00:00Z'));
      startPendingCall('sess-old');

      // Advance 25 hours
      vi.advanceTimersByTime(25 * 60 * 60 * 1000);

      hookState.cleanupStale();

      expect(hookState.recordCallEnd('sess-old', 'Task', 'ok')).toBeNull();
    });

    it('should keep entries within 24 hours', () => {
      vi.setSystemTime(new Date('2026-04-10T12:00:00Z'));
      startPendingCall('sess-recent');

      // Advance 23 hours
      vi.advanceTimersByTime(23 * 60 * 60 * 1000);

      hookState.cleanupStale();

      expect(hookState.recordCallEnd('sess-recent', 'Task', 'ok')).not.toBeNull();
    });
  });

  // ── Persistence ──

  describe('load/save', () => {
    it('should persist and reload state via JSON file', async () => {
      hookState.recordCallStart('sess-persist', {
        toolName: 'Task',
        callId: 'c1',
        startTime: new Date().toISOString(),
        epoch: Math.floor(Date.now() / 1000),
        description: 'persisted call',
      });
      hookState.recordCallEnd('sess-persist', 'Task', 'ok');

      // Force synchronous write
      hookState.flushSync();

      const stateFile = path.join(tempDir, 'hook-state.json');
      expect(fs.existsSync(stateFile)).toBe(true);

      // Verify file content
      const data = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      expect(data.callLog).toHaveLength(1);
      expect(data.callLog[0].sessionId).toBe('sess-persist');
      expect(data.callLog[0].description).toBe('persisted call');
    });

    it('should start fresh on corrupted state file', async () => {
      // Write corrupted data
      const stateFile = path.join(tempDir, 'hook-state.json');
      fs.writeFileSync(stateFile, 'not valid json{{{');

      // Re-import to trigger load
      vi.resetModules();
      const mod = await import('../hook-state');
      const freshState = mod.hookState;

      // Should work without error — started fresh
      freshState.recordCallStart('sess-new', {
        toolName: 'Task',
        callId: 'c1',
        startTime: new Date().toISOString(),
        epoch: Math.floor(Date.now() / 1000),
        description: 'fresh',
      });
      expect(freshState.recordCallEnd('sess-new', 'Task', 'ok')?.callId).toBe('c1');
    });
  });
});
