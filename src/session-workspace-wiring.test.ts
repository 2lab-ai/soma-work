import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('./env-paths', () => ({
  DATA_DIR: '/tmp/soma-work-wiring-test',
}));

import { WorkingDirectoryManager } from './working-directory-manager';
import { SessionRegistry } from './session-registry';

const TEST_DATA_DIR = '/tmp/soma-work-wiring-test';

describe('Session Workspace Wiring', () => {
  let manager: WorkingDirectoryManager;
  let registry: SessionRegistry;

  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    manager = new WorkingDirectoryManager();
    registry = new SessionRegistry();
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  // === Scenario W1: createSessionBaseDir ===

  describe('createSessionBaseDir', () => {
    // Trace W1, Section 3a — Happy Path
    it('creates a unique directory under /tmp/{slackId}/', () => {
      const result = manager.createSessionBaseDir('U094E5L4A15');
      expect(result).toBeDefined();
      expect(result).toMatch(/^\/tmp\/U094E5L4A15\/session_\d+_\d+$/);
      expect(fs.existsSync(result!)).toBe(true);
    });

    // Trace W1, Section 5 — empty slackId
    it('returns undefined for empty slackId', () => {
      const result = manager.createSessionBaseDir('');
      expect(result).toBeUndefined();
    });

    // Trace W1 — uniqueness
    it('produces different paths for two calls', () => {
      const a = manager.createSessionBaseDir('U094E5L4A15');
      const b = manager.createSessionBaseDir('U094E5L4A15');
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      expect(a).not.toBe(b);
    });
  });

  // === Scenario W2: Pipeline Wiring ===

  describe('pipeline wiring (SessionInitializer integration)', () => {
    // Trace W2 — new session gets sessionWorkingDir
    it('new session should use createSessionBaseDir result as cwd', () => {
      const sessionDir = manager.createSessionBaseDir('U094E5L4A15');
      expect(sessionDir).toBeDefined();

      // Simulate what SessionInitializer should do:
      const session = registry.createSession('U094E5L4A15', 'Tester', 'C001', '100.001');
      session.sessionWorkingDir = sessionDir;

      // The session's effective working dir should be the session-unique path
      const effectiveDir = session.sessionWorkingDir || '/tmp/U094E5L4A15';
      expect(effectiveDir).toBe(sessionDir);
      expect(effectiveDir).toMatch(/session_\d+_\d+/);
    });

    // Trace W2 — sourceWorkingDirs registration
    it('session base dir should be registerable in sourceWorkingDirs', () => {
      const sessionDir = manager.createSessionBaseDir('U094E5L4A15');
      expect(sessionDir).toBeDefined();

      const session = registry.createSession('U094E5L4A15', 'Tester', 'C001', '200.001');
      session.sessionId = 'test-wiring-1';
      session.state = 'MAIN';

      const added = registry.addSourceWorkingDir('C001', '200.001', sessionDir!);
      expect(added).toBe(true);
    });
  });

  // === Scenario W3: Backward Compatibility ===

  describe('backward compatibility', () => {
    // Trace W3 — existing session without sessionWorkingDir uses base dir
    it('session without sessionWorkingDir falls back to base dir', () => {
      const session = registry.createSession('U094E5L4A15', 'Tester', 'C001', '300.001');
      // Don't set sessionWorkingDir (simulates pre-wiring session)

      const baseDir = '/tmp/U094E5L4A15';
      const effectiveDir = session.sessionWorkingDir || baseDir;
      expect(effectiveDir).toBe(baseDir);
    });
  });

  // === Scenario W4: Cleanup ===

  describe('cleanup includes session base dir', () => {
    // Trace W4 — session termination cleans up sessionWorkingDir
    it('terminateSession removes session base dir', () => {
      const sessionDir = manager.createSessionBaseDir('U094E5L4A15');
      expect(sessionDir).toBeDefined();
      expect(fs.existsSync(sessionDir!)).toBe(true);

      const session = registry.createSession('U094E5L4A15', 'Tester', 'C001', '400.001');
      session.sessionId = 'test-cleanup-wiring';
      session.state = 'MAIN';
      session.sessionWorkingDir = sessionDir;

      registry.addSourceWorkingDir('C001', '400.001', sessionDir!);

      // Terminate → should cleanup
      registry.terminateSession('C001-400.001');
      expect(fs.existsSync(sessionDir!)).toBe(false);
    });
  });
});
