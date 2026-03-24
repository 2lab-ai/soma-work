import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('./env-paths', () => ({
  DATA_DIR: '/tmp/soma-work-working-dir-test',
}));

import { SessionRegistry } from './session-registry';

const TEST_DATA_DIR = '/tmp/soma-work-working-dir-test';
const TEST_WORKING_DIR = '/tmp/soma-work-working-dir-test-dirs';

describe('SessionRegistry sourceWorkingDirs', () => {
  let registry: SessionRegistry;

  beforeEach(() => {
    for (const d of [TEST_DATA_DIR, TEST_WORKING_DIR]) {
      if (fs.existsSync(d)) fs.rmSync(d, { recursive: true });
      fs.mkdirSync(d, { recursive: true });
    }
    registry = new SessionRegistry();
    const session = registry.createSession('U001', 'Tester', 'C001', '100.001');
    session.sessionId = 'test-session-1';
    session.state = 'MAIN';
  });

  afterEach(() => {
    for (const d of [TEST_DATA_DIR, TEST_WORKING_DIR]) {
      if (fs.existsSync(d)) fs.rmSync(d, { recursive: true });
    }
  });

  it('rejects paths outside /tmp/', () => {
    const result = registry.addSourceWorkingDir('C001', '100.001', '/home/user/evil');
    expect(result).toBe(false);
  });

  it('rejects paths containing ".."', () => {
    const result = registry.addSourceWorkingDir('C001', '100.001', '/tmp/foo/../../../etc');
    expect(result).toBe(false);
  });

  it('rejects non-existent directories', () => {
    const result = registry.addSourceWorkingDir('C001', '100.001', '/tmp/does-not-exist-12345');
    expect(result).toBe(false);
  });

  it('deduplicates identical paths', () => {
    const dirPath = path.join(TEST_WORKING_DIR, 'dup-test');
    fs.mkdirSync(dirPath, { recursive: true });

    expect(registry.addSourceWorkingDir('C001', '100.001', dirPath)).toBe(true);
    expect(registry.addSourceWorkingDir('C001', '100.001', dirPath)).toBe(true);

    const session = registry.getSession('C001', '100.001');
    expect(session?.sourceWorkingDirs).toHaveLength(1);
  });

  it('cleans up directories on session termination', () => {
    const dirPath = path.join(TEST_WORKING_DIR, 'cleanup-test');
    fs.mkdirSync(dirPath, { recursive: true });

    registry.addSourceWorkingDir('C001', '100.001', dirPath);
    expect(fs.existsSync(dirPath)).toBe(true);

    registry.terminateSession('C001-100.001');
    expect(fs.existsSync(dirPath)).toBe(false);
  });

  it('filters invalid paths on deserialization roundtrip', () => {
    const dirPath = path.join(TEST_WORKING_DIR, 'persist-test');
    fs.mkdirSync(dirPath, { recursive: true });

    registry.addSourceWorkingDir('C001', '100.001', dirPath);
    registry.saveSessions();

    // Manually tamper with the saved file to inject invalid paths
    const sessionsFile = path.join(TEST_DATA_DIR, 'sessions.json');
    const raw = JSON.parse(fs.readFileSync(sessionsFile, 'utf-8'));
    // sessions.json is an array of SerializedSession objects
    const entry = raw.find((s: Record<string, unknown>) => s.key === 'C001-100.001');
    expect(entry).toBeDefined();
    if (!entry.sourceWorkingDirs) entry.sourceWorkingDirs = [];
    entry.sourceWorkingDirs.push('/etc/passwd');
    entry.sourceWorkingDirs.push('/tmp/ok/../../../etc/shadow');
    fs.writeFileSync(sessionsFile, JSON.stringify(raw));

    const reader = new SessionRegistry();
    reader.loadSessions();
    const restored = reader.getSession('C001', '100.001');

    // Only the valid /tmp/ path should survive deserialization
    // Note: stored path may be resolved (e.g. /private/tmp on macOS)
    const resolvedDirPath = fs.realpathSync(dirPath);
    expect(restored?.sourceWorkingDirs).toHaveLength(1);
    expect(restored?.sourceWorkingDirs?.[0]).toBe(resolvedDirPath);
  });

  it('cleans up directories on SLEEPING transition via expireSessions', async () => {
    const dirPath = path.join(TEST_WORKING_DIR, 'sleep-test');
    fs.mkdirSync(dirPath, { recursive: true });

    registry.addSourceWorkingDir('C001', '100.001', dirPath);
    expect(fs.existsSync(dirPath)).toBe(true);

    // Force the session to appear expired by backdating lastActivity
    const session = registry.getSession('C001', '100.001');
    if (session) {
      session.lastActivity = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25 hours ago
    }

    await registry.cleanupInactiveSessions(24 * 60 * 60 * 1000);

    // Directory should be cleaned up when session transitions to SLEEPING
    expect(fs.existsSync(dirPath)).toBe(false);
    // Session should now be SLEEPING
    const updated = registry.getSession('C001', '100.001');
    expect(updated?.state).toBe('SLEEPING');
    expect(updated?.sourceWorkingDirs).toEqual([]);
  });
});
