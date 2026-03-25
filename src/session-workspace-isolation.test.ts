import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('./env-paths', () => ({
  DATA_DIR: '/tmp/soma-work-workspace-isolation-test',
}));

import { WorkingDirectoryManager } from './working-directory-manager';
import { SessionRegistry } from './session-registry';

const TEST_DATA_DIR = '/tmp/soma-work-workspace-isolation-test';
const TEST_WORKING_DIR = '/tmp/soma-work-workspace-isolation-dirs';

describe('Session Workspace Isolation', () => {
  let manager: WorkingDirectoryManager;
  let registry: SessionRegistry;

  beforeEach(() => {
    for (const d of [TEST_DATA_DIR, TEST_WORKING_DIR]) {
      if (fs.existsSync(d)) fs.rmSync(d, { recursive: true });
      fs.mkdirSync(d, { recursive: true });
    }
    manager = new WorkingDirectoryManager();
    registry = new SessionRegistry();
  });

  afterEach(() => {
    for (const d of [TEST_DATA_DIR, TEST_WORKING_DIR]) {
      if (fs.existsSync(d)) fs.rmSync(d, { recursive: true });
    }
  });

  // === Scenario 1: Create Session Working Directory ===

  describe('createSessionWorkingDir', () => {
    // Trace: Scenario 1, Section 3 — Happy Path
    it('creates a unique directory under /tmp/{slackId}/', () => {
      const result = manager.createSessionWorkingDir(
        'U094E5L4A15',
        'https://github.com/2lab-ai/soma-work',
        'fix-auth-bug'
      );
      expect(result).toBeDefined();
      expect(result).toMatch(/^\/tmp\/U094E5L4A15\/soma-work_\d+_\d+_fix-auth-bug$/);
      expect(fs.existsSync(result!)).toBe(true);
    });

    // Trace: Scenario 1, Section 3a — repoUrl → repoName extraction
    it('extracts repo name from GitHub URL', () => {
      const result = manager.createSessionWorkingDir(
        'U001',
        'https://github.com/org/my-repo.git',
        'test'
      );
      expect(result).toBeDefined();
      expect(result).toContain('/my-repo_');
    });

    // Trace: Scenario 1, Section 3a — prName sanitization
    it('sanitizes prName with special characters', () => {
      const result = manager.createSessionWorkingDir(
        'U001',
        'https://github.com/org/repo',
        'fix auth bug!@#$%'
      );
      expect(result).toBeDefined();
      // Should not contain special characters
      expect(result).toMatch(/^[a-zA-Z0-9/_-]+$/);
    });

    // Trace: Scenario 1, Section 5 — empty slackId
    it('returns undefined for empty slackId', () => {
      const result = manager.createSessionWorkingDir(
        '',
        'https://github.com/org/repo',
        'test'
      );
      expect(result).toBeUndefined();
    });

    // Trace: Scenario 1, Section 5 — invalid repoUrl
    it('returns undefined for invalid repoUrl', () => {
      const result = manager.createSessionWorkingDir(
        'U001',
        'not-a-url',
        'test'
      );
      expect(result).toBeUndefined();
    });

    // Fix: trailing-slash URL handling
    it('handles trailing-slash URLs correctly', () => {
      const result = manager.createSessionWorkingDir(
        'U001',
        'https://github.com/org/my-repo/',
        'test'
      );
      expect(result).toBeDefined();
      expect(result).toContain('/my-repo_');
    });

    // Fix: slackId path traversal defense
    it('rejects slackId with path traversal (..)', () => {
      const result = manager.createSessionWorkingDir(
        '../etc',
        'https://github.com/org/repo',
        'test'
      );
      expect(result).toBeUndefined();
    });

    it('rejects slackId with forward slash', () => {
      const result = manager.createSessionWorkingDir(
        'U001/../../etc',
        'https://github.com/org/repo',
        'test'
      );
      expect(result).toBeUndefined();
    });
  });

  // === Scenario 4: Concurrent Session Isolation ===

  describe('concurrent session isolation', () => {
    // Trace: Scenario 4, Section 3 — two calls produce different paths
    it('produces different paths for same user/repo/pr called twice', () => {
      const pathA = manager.createSessionWorkingDir(
        'U094E5L4A15',
        'https://github.com/2lab-ai/soma-work',
        'pr-74'
      );
      // Small delay to ensure different timestamp
      const pathB = manager.createSessionWorkingDir(
        'U094E5L4A15',
        'https://github.com/2lab-ai/soma-work',
        'pr-74'
      );
      expect(pathA).toBeDefined();
      expect(pathB).toBeDefined();
      expect(pathA).not.toBe(pathB);
    });
  });

  // === Scenario 5: Session Cleanup ===

  describe('cleanup with normalized paths', () => {
    // Trace: Scenario 5, Section 3a — addSourceWorkingDir normalizes path
    it('normalizes /private/tmp paths when registering', () => {
      const session = registry.createSession('U001', 'Tester', 'C001', '200.001');
      session.sessionId = 'test-cleanup-1';
      session.state = 'MAIN';

      const dirPath = path.join(TEST_WORKING_DIR, 'normalize-test');
      fs.mkdirSync(dirPath, { recursive: true });

      const result = registry.addSourceWorkingDir('C001', '200.001', dirPath);
      expect(result).toBe(true);
    });

    // Trace: Scenario 5, Section 3b — cleanup removes session working dir
    it('removes session working directory on termination', () => {
      const session = registry.createSession('U001', 'Tester', 'C001', '300.001');
      session.sessionId = 'test-cleanup-2';
      session.state = 'MAIN';

      const dirPath = path.join(TEST_WORKING_DIR, 'cleanup-session-test');
      fs.mkdirSync(dirPath, { recursive: true });

      registry.addSourceWorkingDir('C001', '300.001', dirPath);
      expect(fs.existsSync(dirPath)).toBe(true);

      registry.terminateSession('C001-300.001');
      expect(fs.existsSync(dirPath)).toBe(false);
    });
  });
});
