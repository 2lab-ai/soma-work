import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Each test gets its own temp dir referenced via closure in the env-paths mock
let tempDir: string;

vi.mock('./env-paths', () => ({
  get DATA_DIR() {
    return tempDir;
  },
  IS_DEV: true,
}));

vi.mock('./logger', () => ({
  Logger: class {
    debug() {}
    info() {}
    warn() {}
    error() {}
  },
}));

// Partial mock on fs: keep all real implementations, but allow us to stub
// individual functions via vi.mocked(...) in specific tests.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    renameSync: vi.fn(actual.renameSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});

describe('user-memory-store atomic write + new primitives', () => {
  const userId = 'U-TEST-atomic';
  let store: typeof import('./user-memory-store');

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-mem-test-'));
    // Reset both mocks to delegate to real impls by default
    const actual = await vi.importActual<typeof import('fs')>('fs');
    vi.mocked(fs.renameSync).mockImplementation(actual.renameSync);
    vi.mocked(fs.writeFileSync).mockImplementation(actual.writeFileSync);
    vi.resetModules();
    store = await import('./user-memory-store');
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  describe('atomic writeEntries (Scenario 10)', () => {
    it('writes via tmp+rename and cleans tmp on rename failure', () => {
      // Seed initial entry (normal writeEntries path succeeds here)
      store.addMemory(userId, 'memory', 'original');
      const originalEntries = store.loadMemory(userId, 'memory').entries;
      expect(originalEntries).toEqual(['original']);

      // Force rename to fail → simulate ENOSPC mid-write.
      vi.mocked(fs.renameSync).mockImplementation(() => {
        throw new Error('ENOSPC');
      });

      expect(() => store.addMemory(userId, 'memory', 'new')).toThrow('ENOSPC');

      // Original file preserved (rename failed before overwriting)
      expect(store.loadMemory(userId, 'memory').entries).toEqual(originalEntries);

      // No leftover .tmp files in the user's memory dir
      const userDir = path.join(tempDir, userId);
      const leftover = fs.readdirSync(userDir).filter((f) => f.includes('.tmp.'));
      expect(leftover).toEqual([]);
    });

    it('preserves original on writeFileSync failure (tmp never created)', () => {
      // Seed initial entry so the dir exists
      store.addMemory(userId, 'memory', 'original');
      const originalEntries = store.loadMemory(userId, 'memory').entries;

      // Force writeFileSync to fail → never reach renameSync.
      vi.mocked(fs.writeFileSync).mockImplementation(() => {
        throw new Error('EACCES');
      });

      expect(() => store.addMemory(userId, 'memory', 'new')).toThrow('EACCES');

      // Original file preserved
      expect(store.loadMemory(userId, 'memory').entries).toEqual(originalEntries);

      // No tmp leftovers
      const userDir = path.join(tempDir, userId);
      const leftover = fs.readdirSync(userDir).filter((f) => f.includes('.tmp.'));
      expect(leftover).toEqual([]);
    });

    it('uses unique tmp path per write (UUID component)', async () => {
      // Spy writeFileSync: record tmp paths and delegate to real impl.
      const realFs = await vi.importActual<typeof import('fs')>('fs');
      const paths: string[] = [];
      vi.mocked(fs.writeFileSync).mockImplementation(((
        p: Parameters<typeof fs.writeFileSync>[0],
        data: Parameters<typeof fs.writeFileSync>[1],
      ) => {
        if (typeof p === 'string' && p.includes('.tmp.')) paths.push(p);
        return realFs.writeFileSync(p, data);
      }) as typeof fs.writeFileSync);

      store.addMemory(userId, 'memory', 'e1');
      store.addMemory(userId, 'memory', 'e2');
      store.addMemory(userId, 'memory', 'e3');

      expect(paths.length).toBe(3);
      expect(new Set(paths).size).toBe(3); // all unique
      // Each path must include a UUID-shaped component (8-4-4-4-12 hex).
      for (const p of paths) {
        expect(p).toMatch(/\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      }
    });
  });

  describe('replaceMemoryByIndex (Scenario 11)', () => {
    it('replaces at 1-based index', () => {
      store.addMemory(userId, 'memory', 'a');
      store.addMemory(userId, 'memory', 'b');
      store.addMemory(userId, 'memory', 'c');
      expect(store.replaceMemoryByIndex(userId, 'memory', 2, 'NEW')).toEqual({ ok: true });
      expect(store.loadMemory(userId, 'memory').entries).toEqual(['a', 'NEW', 'c']);
    });

    it('rejects out-of-range without mutation', () => {
      store.addMemory(userId, 'memory', 'a');
      const r = store.replaceMemoryByIndex(userId, 'memory', 99, 'x');
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('range');
      expect(store.loadMemory(userId, 'memory').entries).toEqual(['a']);
    });

    it('rejects index < 1 without mutation', () => {
      store.addMemory(userId, 'memory', 'a');
      const r = store.replaceMemoryByIndex(userId, 'memory', 0, 'x');
      expect(r.ok).toBe(false);
      expect(store.loadMemory(userId, 'memory').entries).toEqual(['a']);
    });

    it('rejects over-cap newText without mutation', () => {
      store.addMemory(userId, 'memory', 'a');
      const r = store.replaceMemoryByIndex(userId, 'memory', 1, 'x'.repeat(5000));
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('too long');
      expect(store.loadMemory(userId, 'memory').entries).toEqual(['a']);
    });

    it('rejects empty newText', () => {
      store.addMemory(userId, 'memory', 'a');
      const r = store.replaceMemoryByIndex(userId, 'memory', 1, '');
      expect(r.ok).toBe(false);
      expect(store.loadMemory(userId, 'memory').entries).toEqual(['a']);
    });

    it('rejects when total would exceed charLimit', () => {
      // per-entry cap = 660, total memory cap = 2200, delimiter = '\n§\n' (3 chars).
      // Seed ['a', 'b'.repeat(2100)] → total = 1 + 2100 + 3 = 2104 (within 2200).
      // Replace idx=1 ('a') with 'x'.repeat(660) → new total = 660 + 2100 + 3 = 2763 > 2200.
      // newText passes per-entry cap (660 ≤ 660) so we reach the total-chars check.
      store.addMemory(userId, 'memory', 'a');
      store.addMemory(userId, 'memory', 'b'.repeat(2100));
      const r = store.replaceMemoryByIndex(userId, 'memory', 1, 'x'.repeat(660));
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('charLimit');
      // untouched
      expect(store.loadMemory(userId, 'memory').entries).toEqual(['a', 'b'.repeat(2100)]);
    });

    it('trims whitespace and stores trimmed', () => {
      store.addMemory(userId, 'memory', 'a');
      const r = store.replaceMemoryByIndex(userId, 'memory', 1, '  newtext  ');
      expect(r).toEqual({ ok: true });
      expect(store.loadMemory(userId, 'memory').entries).toEqual(['newtext']);
    });

    it('rejects whitespace-only newText as empty', () => {
      store.addMemory(userId, 'memory', 'a');
      const r = store.replaceMemoryByIndex(userId, 'memory', 1, '   \n\t  ');
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('empty');
      expect(store.loadMemory(userId, 'memory').entries).toEqual(['a']);
    });

    describe('CAS (expectedOldText)', () => {
      it('proceeds when entry at index still equals expected text', () => {
        store.addMemory(userId, 'memory', 'orig');
        const r = store.replaceMemoryByIndex(userId, 'memory', 1, 'NEW', 'orig');
        expect(r).toEqual({ ok: true });
        expect(store.loadMemory(userId, 'memory').entries).toEqual(['NEW']);
      });

      it('rejects with cas mismatch when index now points to a different entry', () => {
        // Simulate the race: we captured 'orig' at click-time, but a concurrent
        // delete removed 'orig' at idx 1 and shifted 'other' into idx 1.
        store.addMemory(userId, 'memory', 'other');
        // originally captured at idx 1 = 'orig', but store now has ['other']
        const r = store.replaceMemoryByIndex(userId, 'memory', 1, 'NEW', 'orig');
        expect(r.ok).toBe(false);
        expect(r.reason).toBe('cas mismatch');
        // 'other' preserved — CAS prevented overwrite
        expect(store.loadMemory(userId, 'memory').entries).toEqual(['other']);
      });

      it('without expectedOldText behaves as original (no CAS)', () => {
        store.addMemory(userId, 'memory', 'x');
        const r = store.replaceMemoryByIndex(userId, 'memory', 1, 'y');
        expect(r).toEqual({ ok: true });
        expect(store.loadMemory(userId, 'memory').entries).toEqual(['y']);
      });
    });
  });

  describe('replaceAllMemory (Scenario 12)', () => {
    it('writes full array on valid input', () => {
      store.addMemory(userId, 'memory', 'old1');
      store.addMemory(userId, 'memory', 'old2');
      expect(store.replaceAllMemory(userId, 'memory', ['x', 'y', 'z'])).toEqual({ ok: true });
      expect(store.loadMemory(userId, 'memory').entries).toEqual(['x', 'y', 'z']);
    });

    it('rejects empty array without mutation', () => {
      store.addMemory(userId, 'memory', 'old');
      const r = store.replaceAllMemory(userId, 'memory', []);
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('empty');
      expect(store.loadMemory(userId, 'memory').entries).toEqual(['old']);
    });

    it('rejects duplicates without mutation', () => {
      store.addMemory(userId, 'memory', 'old');
      const r = store.replaceAllMemory(userId, 'memory', ['a', 'a']);
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('duplicate');
      expect(store.loadMemory(userId, 'memory').entries).toEqual(['old']);
    });

    it('rejects over-limit without mutation (prevalidate via per-entry cap)', () => {
      store.addMemory(userId, 'memory', 'old');
      // 3000 chars is > per-entry cap 660 → rejected before any write
      const r = store.replaceAllMemory(userId, 'memory', ['x'.repeat(3000)]);
      expect(r.ok).toBe(false);
      expect(store.loadMemory(userId, 'memory').entries).toEqual(['old']);
    });

    it('rejects entry containing empty string without mutation', () => {
      store.addMemory(userId, 'memory', 'old');
      const r = store.replaceAllMemory(userId, 'memory', ['a', '']);
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('empty');
      expect(store.loadMemory(userId, 'memory').entries).toEqual(['old']);
    });

    it('rejects when total chars exceeds charLimit', () => {
      store.addMemory(userId, 'memory', 'old');
      // Four entries at 600 chars each = 2400 + 3*3 delimiters = 2409 > 2200 memory cap.
      // Each individual length (600) is <= 660 per-entry cap, so we hit the
      // total-chars check specifically.
      const big = ['a', 'b', 'c', 'd'].map((c) => c.repeat(600));
      const r = store.replaceAllMemory(userId, 'memory', big);
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('charLimit');
      expect(store.loadMemory(userId, 'memory').entries).toEqual(['old']);
    });

    it('works for user target with different cap (412)', () => {
      store.addMemory(userId, 'user', 'old');
      // 400 chars is under 412 per-entry cap for user target
      const r = store.replaceAllMemory(userId, 'user', ['a'.repeat(400)]);
      expect(r.ok).toBe(true);
      expect(store.loadMemory(userId, 'user').entries).toEqual(['a'.repeat(400)]);
    });

    it('rejects user-target entry above user per-entry cap (412)', () => {
      store.addMemory(userId, 'user', 'old');
      const r = store.replaceAllMemory(userId, 'user', ['a'.repeat(500)]);
      expect(r.ok).toBe(false);
      expect(store.loadMemory(userId, 'user').entries).toEqual(['old']);
    });

    it('trims whitespace in all entries', () => {
      store.addMemory(userId, 'memory', 'old');
      const r = store.replaceAllMemory(userId, 'memory', ['  a  ', 'b  ', '  c']);
      expect(r).toEqual({ ok: true });
      expect(store.loadMemory(userId, 'memory').entries).toEqual(['a', 'b', 'c']);
    });

    it('rejects whitespace-only entries', () => {
      store.addMemory(userId, 'memory', 'old');
      const r = store.replaceAllMemory(userId, 'memory', ['a', '   ', 'c']);
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('empty');
      expect(store.loadMemory(userId, 'memory').entries).toEqual(['old']);
    });

    it('rejects non-string member without mutation', () => {
      store.addMemory(userId, 'memory', 'old');
      // Simulate a malformed LLM response that slipped past memory-improve.ts.
      const r = store.replaceAllMemory(userId, 'memory', ['a', 42 as unknown as string, 'c']);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('non-string entry');
      expect(store.loadMemory(userId, 'memory').entries).toEqual(['old']);
    });

    describe('CAS (expectedOldEntries)', () => {
      it('proceeds when current entries match the snapshot', () => {
        store.addMemory(userId, 'memory', 'a');
        store.addMemory(userId, 'memory', 'b');
        const snapshot = store.loadMemory(userId, 'memory').entries;
        const r = store.replaceAllMemory(userId, 'memory', ['x', 'y'], snapshot);
        expect(r).toEqual({ ok: true });
        expect(store.loadMemory(userId, 'memory').entries).toEqual(['x', 'y']);
      });

      it('rejects with cas mismatch when entries changed mid-flight', () => {
        store.addMemory(userId, 'memory', 'a');
        store.addMemory(userId, 'memory', 'b');
        const snapshot = ['a', 'b']; // captured before a concurrent delete
        // Simulate concurrent delete: remove entry 1 while the LLM was running
        store.removeMemory(userId, 'memory', 'a');
        const r = store.replaceAllMemory(userId, 'memory', ['x', 'y'], snapshot);
        expect(r.ok).toBe(false);
        expect(r.reason).toBe('cas mismatch');
        // Store preserved — 'b' only remains, intervening delete respected
        expect(store.loadMemory(userId, 'memory').entries).toEqual(['b']);
      });

      it('rejects cas mismatch when length differs', () => {
        store.addMemory(userId, 'memory', 'a');
        const snapshot = ['a', 'b']; // we thought there were two
        const r = store.replaceAllMemory(userId, 'memory', ['x'], snapshot);
        expect(r.ok).toBe(false);
        expect(r.reason).toBe('cas mismatch');
        expect(store.loadMemory(userId, 'memory').entries).toEqual(['a']);
      });

      it('without snapshot behaves as before (no CAS)', () => {
        store.addMemory(userId, 'memory', 'orig');
        const r = store.replaceAllMemory(userId, 'memory', ['x']);
        expect(r).toEqual({ ok: true });
        expect(store.loadMemory(userId, 'memory').entries).toEqual(['x']);
      });
    });
  });
});
