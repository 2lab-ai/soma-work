import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync } from 'fs';

// Contract tests derived from docs/pid-lock/trace.md
// All tests should FAIL (RED) until implementation

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
      const { acquirePidLock } = await import('./pid-lock');
      const result = acquirePidLock(tempDir);
      expect(result).toBe(true);
      const pidContent = readFileSync(join(tempDir, 'soma-work.pid'), 'utf-8');
      expect(pidContent.trim()).toBe(String(process.pid));
    });
  });

  // === Scenario 2: acquirePidLock — stale lock (dead PID) ===
  describe('Scenario 2: Stale lock (dead PID)', () => {
    it('removes stale lock and acquires', async () => {
      // Write a PID that definitely does not exist (very high number)
      writeFileSync(join(tempDir, 'soma-work.pid'), '4294967295');
      const { acquirePidLock } = await import('./pid-lock');
      const result = acquirePidLock(tempDir);
      expect(result).toBe(true);
      const pidContent = readFileSync(join(tempDir, 'soma-work.pid'), 'utf-8');
      expect(pidContent.trim()).toBe(String(process.pid));
    });
  });

  // === Scenario 3: acquirePidLock — live lock (running PID) ===
  describe('Scenario 3: Live lock (another running process)', () => {
    it('refuses to acquire when another instance is running', async () => {
      // Use parent PID (guaranteed alive, guaranteed not us)
      writeFileSync(join(tempDir, 'soma-work.pid'), String(process.ppid));
      const { acquirePidLock } = await import('./pid-lock');
      const result = acquirePidLock(tempDir);
      expect(result).toBe(false);
      // Lock file should remain unchanged (still contains ppid)
      const pidContent = readFileSync(join(tempDir, 'soma-work.pid'), 'utf-8');
      expect(pidContent.trim()).toBe(String(process.ppid));
    });
  });

  // === Scenario 4: releasePidLock — cleanup on shutdown ===
  describe('Scenario 4: Release lock on shutdown', () => {
    it('removes lock file on release', async () => {
      const { acquirePidLock, releasePidLock } = await import('./pid-lock');
      acquirePidLock(tempDir);
      expect(existsSync(join(tempDir, 'soma-work.pid'))).toBe(true);
      releasePidLock(tempDir);
      expect(existsSync(join(tempDir, 'soma-work.pid'))).toBe(false);
    });

    it('does not remove lock file if PID does not match (safety)', async () => {
      const { releasePidLock } = await import('./pid-lock');
      // Write someone else's PID
      writeFileSync(join(tempDir, 'soma-work.pid'), String(process.ppid));
      releasePidLock(tempDir);
      // Should NOT remove — not our lock
      expect(existsSync(join(tempDir, 'soma-work.pid'))).toBe(true);
    });
  });

  // === Scenario edge: corrupted lock file ===
  describe('Edge: Corrupted lock file', () => {
    it('handles non-numeric content in lock file', async () => {
      writeFileSync(join(tempDir, 'soma-work.pid'), 'not-a-number');
      const { acquirePidLock } = await import('./pid-lock');
      const result = acquirePidLock(tempDir);
      expect(result).toBe(true); // Should treat as stale and acquire
    });
  });
});
