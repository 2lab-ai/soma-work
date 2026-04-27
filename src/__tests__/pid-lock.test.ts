import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Contract tests derived from docs/pid-lock/trace.md
// Tests the atomic O_EXCL-based PID lock with PID:timestamp format

describe('PID Lock — Single Instance Guard', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pid-lock-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // === Scenario 1: acquirePidLock — no existing lock ===
  describe('Scenario 1: No existing lock', () => {
    it('creates lock file when none exists', async () => {
      const { acquirePidLock } = await import('../pid-lock');
      const result = acquirePidLock(tempDir);
      expect(result).toBe(true);
      const pidContent = readFileSync(join(tempDir, 'soma-work.pid'), 'utf-8');
      // New format: "PID:timestamp"
      expect(pidContent).toMatch(new RegExp(`^${process.pid}:\\d+$`));
    });
  });

  // === Scenario 2: acquirePidLock — stale lock (dead PID) ===
  describe('Scenario 2: Stale lock (dead PID)', () => {
    it('removes stale lock and acquires (legacy bare PID format)', async () => {
      // Legacy format: bare PID
      writeFileSync(join(tempDir, 'soma-work.pid'), '4294967295');
      const { acquirePidLock } = await import('../pid-lock');
      const result = acquirePidLock(tempDir);
      expect(result).toBe(true);
      const pidContent = readFileSync(join(tempDir, 'soma-work.pid'), 'utf-8');
      expect(pidContent).toMatch(new RegExp(`^${process.pid}:\\d+$`));
    });

    it('removes stale lock and acquires (new PID:timestamp format)', async () => {
      writeFileSync(join(tempDir, 'soma-work.pid'), '4294967295:1700000000000');
      const { acquirePidLock } = await import('../pid-lock');
      const result = acquirePidLock(tempDir);
      expect(result).toBe(true);
      const pidContent = readFileSync(join(tempDir, 'soma-work.pid'), 'utf-8');
      expect(pidContent).toMatch(new RegExp(`^${process.pid}:\\d+$`));
    });
  });

  // === Scenario 3: acquirePidLock — live lock (running PID) ===
  describe('Scenario 3: Live lock (another running process)', () => {
    it('refuses to acquire when another instance is running (legacy format)', async () => {
      // Use parent PID (guaranteed alive, guaranteed not us)
      writeFileSync(join(tempDir, 'soma-work.pid'), String(process.ppid));
      const { acquirePidLock } = await import('../pid-lock');
      const result = acquirePidLock(tempDir);
      expect(result).toBe(false);
    });

    it('refuses to acquire when another instance is running (new format)', async () => {
      writeFileSync(join(tempDir, 'soma-work.pid'), `${process.ppid}:${Date.now()}`);
      const { acquirePidLock } = await import('../pid-lock');
      const result = acquirePidLock(tempDir);
      expect(result).toBe(false);
    });
  });

  // === Scenario 4: releasePidLock — cleanup on shutdown ===
  describe('Scenario 4: Release lock on shutdown', () => {
    it('removes lock file on release', async () => {
      const { acquirePidLock, releasePidLock } = await import('../pid-lock');
      acquirePidLock(tempDir);
      expect(existsSync(join(tempDir, 'soma-work.pid'))).toBe(true);
      releasePidLock(tempDir);
      expect(existsSync(join(tempDir, 'soma-work.pid'))).toBe(false);
    });

    it('does not remove lock file if PID does not match (safety)', async () => {
      const { releasePidLock } = await import('../pid-lock');
      // Write someone else's PID
      writeFileSync(join(tempDir, 'soma-work.pid'), `${process.ppid}:${Date.now()}`);
      releasePidLock(tempDir);
      // Should NOT remove — not our lock
      expect(existsSync(join(tempDir, 'soma-work.pid'))).toBe(true);
    });
  });

  // === Edge cases ===
  describe('Edge: Corrupted lock file', () => {
    it('handles non-numeric content in lock file', async () => {
      writeFileSync(join(tempDir, 'soma-work.pid'), 'not-a-number');
      const { acquirePidLock } = await import('../pid-lock');
      const result = acquirePidLock(tempDir);
      expect(result).toBe(true);
    });
  });

  describe('Edge: Missing data directory', () => {
    it('creates data directory if it does not exist', async () => {
      const nonExistentDir = join(tempDir, 'nested', 'data');
      const { acquirePidLock } = await import('../pid-lock');
      const result = acquirePidLock(nonExistentDir);
      expect(result).toBe(true);
      expect(existsSync(join(nonExistentDir, 'soma-work.pid'))).toBe(true);
    });
  });

  describe('Edge: Lock file removed between check and read', () => {
    it('handles ENOENT gracefully during read', async () => {
      // Pre-create then remove to simulate race
      writeFileSync(join(tempDir, 'soma-work.pid'), `99999:${Date.now()}`);
      const { acquirePidLock } = await import('../pid-lock');
      // Remove the file to simulate the race window
      rmSync(join(tempDir, 'soma-work.pid'));
      // Should still acquire successfully
      const result = acquirePidLock(tempDir);
      expect(result).toBe(true);
    });
  });
});
