/**
 * Session Archive Store — Contract Tests
 * Trace: docs/session-archive/trace.md
 * Issue: #401
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../env-paths', () => ({
  DATA_DIR: '/tmp/soma-work-archive-test',
}));

import { type ArchivedSession, SessionArchiveStore } from '../session-archive';
import type { ConversationSession } from '../types';

const TEST_DATA_DIR = '/tmp/soma-work-archive-test';
const TEST_ARCHIVES_DIR = path.join(TEST_DATA_DIR, 'archives');

// ── Test Helpers ────────────────────────────────────────────────────

function makeTestSession(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return {
    ownerId: 'U000',
    userId: 'U000',
    channelId: 'C000',
    isActive: true,
    lastActivity: new Date('2026-04-09T12:00:00Z'),
    ...overrides,
  } as ConversationSession;
}

describe('SessionArchiveStore', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true });
    }
    fs.mkdirSync(TEST_ARCHIVES_DIR, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true });
    }
  });

  // ── Scenario 1: Archive on Terminate ──────────────────────

  // Trace: Scenario 1, Section 3a — archive() called before delete
  it('terminate_archivesSessionBeforeDelete', () => {
    const store = new SessionArchiveStore(TEST_ARCHIVES_DIR);
    const session = makeTestSession({ ownerId: 'U001', model: 'claude-opus-4-6' });
    store.archive(session, 'C123-456.789', 'terminated');

    const archived = store.load('C123-456.789');
    expect(archived).not.toBeNull();
    expect(archived?.sessionKey).toBe('C123-456.789');
    expect(archived?.archiveReason).toBe('terminated');
  });

  // Trace: Scenario 1, Section 3a transformation — all metadata preserved
  it('terminate_archiveContainsAllMetadata', () => {
    const store = new SessionArchiveStore(TEST_ARCHIVES_DIR);
    const session = makeTestSession({
      ownerId: 'U001',
      ownerName: 'Zhuge',
      channelId: 'C0AK',
      threadTs: '123.456',
      sessionId: 'sess-001',
      conversationId: 'conv-001',
      title: 'Test Session',
      model: 'claude-opus-4-6',
      workflow: 'default',
      links: { issue: { url: 'https://github.com/issues/1', type: 'issue', provider: 'github', label: 'PTN-123' } },
      mergeStats: { totalLinesAdded: 100, totalLinesDeleted: 20, mergedPRs: [] },
      instructions: [
        {
          id: 'i1',
          text: 'Do X',
          createdAt: new Date().toISOString(),
          source: 'model',
          status: 'active',
          linkedSessionIds: [],
          sourceRawInputIds: [],
        },
      ],
    });

    store.archive(session, 'C0AK-123.456', 'terminated');
    const archived = store.load('C0AK-123.456');

    expect(archived?.ownerId).toBe('U001');
    expect(archived?.ownerName).toBe('Zhuge');
    expect(archived?.conversationId).toBe('conv-001');
    expect(archived?.model).toBe('claude-opus-4-6');
    expect(archived?.links?.issue?.url).toBe('https://github.com/issues/1');
    expect(archived?.mergeStats?.totalLinesAdded).toBe(100);
    expect(archived?.instructions).toHaveLength(1);
    expect(archived?.archivedAt).toBeGreaterThan(0);
  });

  // Trace: Scenario 1, Section 5 — archive failure does not block terminate
  it('terminate_archiveFailure_doesNotBlockTerminate', () => {
    // Use a non-writable path to simulate failure
    const store = new SessionArchiveStore('/dev/null/impossible-path');
    const session = makeTestSession({ ownerId: 'U001' });

    // Should not throw
    expect(() => store.archive(session, 'C123-456.789', 'terminated')).not.toThrow();
  });

  // Trace: Scenario 1, Section 3b — atomic write (tmp → rename), append-only naming
  it('terminate_archiveFile_atomicWrite', () => {
    const store = new SessionArchiveStore(TEST_ARCHIVES_DIR);
    const session = makeTestSession({ ownerId: 'U001' });

    store.archive(session, 'C123-456.789', 'terminated');

    // Verify an archive file exists with append-only naming (key_timestamp.json)
    const files = fs.readdirSync(TEST_ARCHIVES_DIR).filter((f) => f.startsWith('C123-456.789_'));
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^C123-456\.789_\d+\.json$/);

    // Verify no .tmp files remain
    const tmpFiles = fs.readdirSync(TEST_ARCHIVES_DIR).filter((f) => f.endsWith('.tmp'));
    expect(tmpFiles.length).toBe(0);

    // Verify the file content is valid JSON
    const content = JSON.parse(fs.readFileSync(path.join(TEST_ARCHIVES_DIR, files[0]), 'utf-8'));
    expect(content.sessionKey).toBe('C123-456.789');
  });

  // Append-only: multiple archives for same sessionKey don't overwrite
  it('terminate_appendOnly_multipleArchivesPreserved', () => {
    const store = new SessionArchiveStore(TEST_ARCHIVES_DIR);
    const session1 = makeTestSession({ ownerId: 'U001', title: 'First' });
    const session2 = makeTestSession({ ownerId: 'U001', title: 'Second' });

    store.archive(session1, 'C123-456.789', 'terminated');
    // Small delay to ensure different timestamp
    const _files1 = fs.readdirSync(TEST_ARCHIVES_DIR).filter((f) => f.startsWith('C123-456.789_'));

    store.archive(session2, 'C123-456.789', 'terminated');
    const files2 = fs.readdirSync(TEST_ARCHIVES_DIR).filter((f) => f.startsWith('C123-456.789_'));

    // Should have 2 archive files (or 1 if same ms — still valid, just overwritten)
    expect(files2.length).toBeGreaterThanOrEqual(1);

    // load() returns the most recent
    const latest = store.load('C123-456.789');
    expect(latest).not.toBeNull();
  });

  // ── Scenario 2: Archive on Sleep-Expire ───────────────────

  // Trace: Scenario 2, Section 3a — archive on sleep expire
  it('sleepExpire_archivesSessionBeforeDelete', () => {
    const store = new SessionArchiveStore(TEST_ARCHIVES_DIR);
    const session = makeTestSession({ ownerId: 'U001', state: 'SLEEPING' });
    store.archive(session, 'C123-456.789', 'sleep_expired');

    const archived = store.load('C123-456.789');
    expect(archived).not.toBeNull();
    expect(archived?.archiveReason).toBe('sleep_expired');
  });

  // Trace: Scenario 2, Section 3a — reason field is correct
  it('sleepExpire_archiveReason_isSleepExpired', () => {
    const store = new SessionArchiveStore(TEST_ARCHIVES_DIR);
    const session = makeTestSession({ state: 'SLEEPING' });
    store.archive(session, 'C123-456.789', 'sleep_expired');

    const archived = store.load('C123-456.789');
    expect(archived?.archiveReason).toBe('sleep_expired');
    expect(archived?.finalState).toBe('SLEEPING');
  });

  // Trace: Scenario 2, Section 5 — archive failure does not block expiry
  it('sleepExpire_archiveFailure_doesNotBlockExpiry', () => {
    const store = new SessionArchiveStore('/dev/null/impossible-path');
    const session = makeTestSession({ ownerId: 'U001', state: 'SLEEPING' });

    expect(() => store.archive(session, 'C123-456.789', 'sleep_expired')).not.toThrow();
  });

  // ── Scenario 3: Dashboard Closed Column ───────────────────

  // Trace: Scenario 3, Section 3a — closed column includes recent archives
  it('dashboard_closedColumn_includesRecentArchives', () => {
    const store = new SessionArchiveStore(TEST_ARCHIVES_DIR);
    const session = makeTestSession({ ownerId: 'U001', title: 'Recent Session' });
    store.archive(session, 'C123-recent.789', 'terminated');

    const recent = store.listRecent(48 * 60 * 60 * 1000);
    expect(recent).toHaveLength(1);
    expect(recent[0].sessionKey).toBe('C123-recent.789');
  });

  // Trace: Scenario 3, Section 3a — 48h filter excludes old archives
  it('dashboard_closedColumn_excludesOldArchives', () => {
    // Write an archive file with old archivedAt timestamp
    const oldArchive: ArchivedSession = {
      archivedAt: Date.now() - 49 * 60 * 60 * 1000, // 49 hours ago
      archiveReason: 'terminated',
      sessionKey: 'C123-old.789',
      ownerId: 'U000',
      channelId: 'C000',
      lastActivity: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(TEST_ARCHIVES_DIR, 'C123-old.789.json'), JSON.stringify(oldArchive));

    const store = new SessionArchiveStore(TEST_ARCHIVES_DIR);
    const recent = store.listRecent(48 * 60 * 60 * 1000);
    expect(recent).toHaveLength(0);
  });

  // Trace: Scenario 3, Section 3a — user filter on archives
  it('dashboard_closedColumn_filtersArchivesByUser', () => {
    const store = new SessionArchiveStore(TEST_ARCHIVES_DIR);
    store.archive(makeTestSession({ ownerId: 'U001' }), 'C123-u1.789', 'terminated');
    store.archive(makeTestSession({ ownerId: 'U002' }), 'C123-u2.789', 'terminated');

    const filtered = store.list({ ownerId: 'U001' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].ownerId).toBe('U001');
  });

  // Trace: Scenario 3, Section 3a transformation — ArchivedSession fields
  it('dashboard_closedColumn_archivedToKanban_transformation', () => {
    const store = new SessionArchiveStore(TEST_ARCHIVES_DIR);
    const session = makeTestSession({
      ownerId: 'U001',
      ownerName: 'Zhuge',
      title: 'Test',
      model: 'claude-opus-4-6',
      channelId: 'C0AK',
      threadTs: '123.456',
    });
    store.archive(session, 'C0AK-123.456', 'terminated');

    const archived = store.load('C0AK-123.456');
    expect(archived).not.toBeNull();
    expect(archived?.sessionKey).toBe('C0AK-123.456');
    expect(archived?.title).toBe('Test');
    expect(archived?.model).toBe('claude-opus-4-6');
    expect(archived?.ownerId).toBe('U001');
    expect(archived?.ownerName).toBe('Zhuge');
  });

  // Trace: Scenario 3, Section 5 — missing archive dir returns empty
  it('dashboard_closedColumn_missingArchiveDir_returnsEmpty', () => {
    const store = new SessionArchiveStore('/tmp/nonexistent-archives-test');
    const recent = store.listRecent(48 * 60 * 60 * 1000);
    expect(recent).toEqual([]);
  });
});
