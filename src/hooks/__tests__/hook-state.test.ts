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

  // ── TodoGuard state ──

  describe('incrementTodoGuard', () => {
    it('should increase count on each call', () => {
      const r1 = hookState.incrementTodoGuard('sess-1');
      expect(r1.count).toBe(1);
      expect(r1.todoExists).toBe(false);

      const r2 = hookState.incrementTodoGuard('sess-1');
      expect(r2.count).toBe(2);
    });

    it('should track sessions independently', () => {
      hookState.incrementTodoGuard('sess-1');
      hookState.incrementTodoGuard('sess-1');
      hookState.incrementTodoGuard('sess-2');

      const s1 = hookState.getTodoGuardState('sess-1');
      const s2 = hookState.getTodoGuardState('sess-2');
      expect(s1?.count).toBe(2);
      expect(s2?.count).toBe(1);
    });
  });

  describe('markTodoExists', () => {
    it('should set todoExists to true', () => {
      hookState.markTodoExists('sess-1');
      const state = hookState.getTodoGuardState('sess-1');
      expect(state?.todoExists).toBe(true);
    });

    it('should preserve count when marking', () => {
      hookState.incrementTodoGuard('sess-1');
      hookState.incrementTodoGuard('sess-1');
      hookState.markTodoExists('sess-1');

      const state = hookState.getTodoGuardState('sess-1');
      expect(state?.count).toBe(2);
      expect(state?.todoExists).toBe(true);
    });
  });

  // ── Session cleanup ──

  describe('cleanupSession', () => {
    it('should remove all session data', () => {
      hookState.incrementTodoGuard('sess-1');
      hookState.markTodoExists('sess-1');
      hookState.recordCallStart('sess-1', {
        toolName: 'Task',
        callId: 'c1',
        startTime: new Date().toISOString(),
        epoch: Math.floor(Date.now() / 1000),
        description: 'test',
      });

      hookState.cleanupSession('sess-1');

      expect(hookState.getTodoGuardState('sess-1')).toBeUndefined();
    });

    it('should not affect other sessions', () => {
      hookState.incrementTodoGuard('sess-1');
      hookState.incrementTodoGuard('sess-2');

      hookState.cleanupSession('sess-1');

      expect(hookState.getTodoGuardState('sess-1')).toBeUndefined();
      expect(hookState.getTodoGuardState('sess-2')?.count).toBe(1);
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
    it('should remove entries older than 24 hours', () => {
      const now = new Date('2026-04-10T12:00:00Z');
      vi.setSystemTime(now);

      hookState.incrementTodoGuard('sess-old');

      // Advance 25 hours
      vi.advanceTimersByTime(25 * 60 * 60 * 1000);

      hookState.cleanupStale();

      expect(hookState.getTodoGuardState('sess-old')).toBeUndefined();
    });

    it('should keep entries within 24 hours', () => {
      const now = new Date('2026-04-10T12:00:00Z');
      vi.setSystemTime(now);

      hookState.incrementTodoGuard('sess-recent');

      // Advance 23 hours
      vi.advanceTimersByTime(23 * 60 * 60 * 1000);

      hookState.cleanupStale();

      expect(hookState.getTodoGuardState('sess-recent')).not.toBeUndefined();
    });
  });

  // ── Persistence ──

  describe('load/save', () => {
    it('should persist and reload state via JSON file', async () => {
      hookState.incrementTodoGuard('sess-persist');
      hookState.incrementTodoGuard('sess-persist');
      hookState.markTodoExists('sess-persist');

      // Force synchronous write
      hookState.flushSync();

      const stateFile = path.join(tempDir, 'hook-state.json');
      expect(fs.existsSync(stateFile)).toBe(true);

      // Verify file content
      const data = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      expect(data.todoGuard['sess-persist']).toBeDefined();
      expect(data.todoGuard['sess-persist'].count).toBe(2);
      expect(data.todoGuard['sess-persist'].todoExists).toBe(true);
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
      const result = freshState.incrementTodoGuard('sess-new');
      expect(result.count).toBe(1);
    });
  });
});
