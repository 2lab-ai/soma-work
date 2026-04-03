/**
 * Unit Tests — FileSessionStore
 * Issue #333: Durable Session Store
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileSessionStore } from './session-store.js';
import type { SessionRecord } from './types.js';

// ── Helpers ─────────────────────────────────────────────────

function tmpFilePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-store-test-'));
  return path.join(dir, 'llm-sessions.json');
}

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const now = new Date().toISOString();
  return {
    publicId: `pub-${Math.random().toString(36).slice(2, 10)}`,
    backend: 'codex',
    backendSessionId: `thread-${Math.random().toString(36).slice(2, 10)}`,
    model: 'gpt-5.4',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────

describe('FileSessionStore', () => {
  let filePath: string;

  beforeEach(() => {
    filePath = tmpFilePath();
  });

  afterEach(() => {
    try {
      fs.unlinkSync(filePath);
      fs.rmdirSync(path.dirname(filePath));
    } catch {
      // ignore cleanup errors
    }
  });

  // ── save / get / delete ───────────────────────────────────

  it('saves and retrieves a session record', () => {
    const store = new FileSessionStore(filePath);
    const record = makeRecord();
    store.save(record);

    const got = store.get(record.publicId);
    expect(got).toBeDefined();
    expect(got!.publicId).toBe(record.publicId);
    expect(got!.backend).toBe('codex');
    expect(got!.backendSessionId).toBe(record.backendSessionId);
    expect(got!.model).toBe('gpt-5.4');
  });

  it('returns undefined for unknown publicId', () => {
    const store = new FileSessionStore(filePath);
    expect(store.get('nonexistent')).toBeUndefined();
  });

  it('deletes a session record', () => {
    const store = new FileSessionStore(filePath);
    const record = makeRecord();
    store.save(record);
    expect(store.get(record.publicId)).toBeDefined();

    store.delete(record.publicId);
    expect(store.get(record.publicId)).toBeUndefined();
  });

  // ── updateBackendSessionId ────────────────────────────────

  it('updates backend session ID and updatedAt', () => {
    const store = new FileSessionStore(filePath);
    const beforeUpdate = new Date(Date.now() - 60_000).toISOString(); // 1 minute ago (within TTL)
    const record = makeRecord({ updatedAt: beforeUpdate });
    store.save(record);

    store.updateBackendSessionId(record.publicId, 'new-thread-xyz');

    const got = store.get(record.publicId);
    expect(got!.backendSessionId).toBe('new-thread-xyz');
    expect(new Date(got!.updatedAt).getTime()).toBeGreaterThan(new Date(beforeUpdate).getTime());
  });

  it('updateBackendSessionId is a no-op for unknown publicId', () => {
    const store = new FileSessionStore(filePath);
    // Should not throw
    store.updateBackendSessionId('nonexistent', 'new-id');
  });

  // ── touch() ─────────────────────────────────────────────

  it('touch refreshes updatedAt without changing other fields', () => {
    const store = new FileSessionStore(filePath);
    const beforeTouch = new Date(Date.now() - 1000).toISOString();
    const record = makeRecord({ updatedAt: beforeTouch });
    store.save(record);

    store.touch(record.publicId);

    const got = store.get(record.publicId);
    expect(got!.backendSessionId).toBe(record.backendSessionId); // unchanged
    expect(new Date(got!.updatedAt).getTime()).toBeGreaterThan(new Date(beforeTouch).getTime());
  });

  it('touch is a no-op for unknown publicId', () => {
    const store = new FileSessionStore(filePath);
    store.touch('nonexistent'); // should not throw
  });

  // ── TTL expiry ────────────────────────────────────────────

  it('returns undefined for expired sessions (TTL 24h)', () => {
    const store = new FileSessionStore(filePath);
    const expired = makeRecord({
      updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), // 25 hours ago
    });
    store.save(expired);

    expect(store.get(expired.publicId)).toBeUndefined();
  });

  it('returns valid session within TTL', () => {
    const store = new FileSessionStore(filePath);
    const fresh = makeRecord({
      updatedAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(), // 1 hour ago
    });
    store.save(fresh);

    expect(store.get(fresh.publicId)).toBeDefined();
  });

  // ── prune ─────────────────────────────────────────────────

  it('prune() removes expired sessions', () => {
    const store = new FileSessionStore(filePath);
    const expired = makeRecord({
      updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    });
    const fresh = makeRecord();
    store.save(expired);
    store.save(fresh);

    store.prune();

    // Verify via a new store instance reading from disk
    const store2 = new FileSessionStore(filePath);
    expect(store2.get(expired.publicId)).toBeUndefined();
    expect(store2.get(fresh.publicId)).toBeDefined();
  });

  // ── max count pruning ─────────────────────────────────────

  it('auto-prunes oldest sessions when exceeding max 50', () => {
    const store = new FileSessionStore(filePath);

    // Save 52 sessions with incrementing timestamps
    const records: SessionRecord[] = [];
    for (let i = 0; i < 52; i++) {
      const r = makeRecord({
        publicId: `pub-${String(i).padStart(3, '0')}`,
        updatedAt: new Date(Date.now() - (52 - i) * 1000).toISOString(),
      });
      records.push(r);
      store.save(r);
    }

    // The 2 oldest should have been pruned
    const store2 = new FileSessionStore(filePath);
    expect(store2.get('pub-000')).toBeUndefined();
    expect(store2.get('pub-001')).toBeUndefined();
    // The newest should still be there
    expect(store2.get('pub-051')).toBeDefined();
    expect(store2.get('pub-050')).toBeDefined();
  });

  // ── persistence across instances ──────────────────────────

  it('persists across store instances', () => {
    const store1 = new FileSessionStore(filePath);
    const record = makeRecord();
    store1.save(record);

    // Create a brand new store instance pointing to the same file
    const store2 = new FileSessionStore(filePath);
    const got = store2.get(record.publicId);
    expect(got).toBeDefined();
    expect(got!.publicId).toBe(record.publicId);
    expect(got!.backendSessionId).toBe(record.backendSessionId);
  });

  // ── atomic write safety ───────────────────────────────────

  it('writes atomically (no .tmp file left behind)', () => {
    const store = new FileSessionStore(filePath);
    store.save(makeRecord());

    const dir = path.dirname(filePath);
    const files = fs.readdirSync(dir);
    expect(files).not.toContain(path.basename(filePath) + '.tmp');
    expect(files).toContain(path.basename(filePath));
  });

  it('creates parent directory if it does not exist', () => {
    const deepPath = path.join(os.tmpdir(), `session-store-deep-${Date.now()}`, 'sub', 'llm-sessions.json');
    const store = new FileSessionStore(deepPath);
    store.save(makeRecord());

    expect(fs.existsSync(deepPath)).toBe(true);

    // Cleanup
    fs.rmSync(path.join(os.tmpdir(), `session-store-deep-${Date.now()}`), { recursive: true, force: true });
  });

  it('handles corrupt JSON file gracefully', () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'NOT VALID JSON {{{', 'utf-8');

    const store = new FileSessionStore(filePath);
    // Should not throw, starts fresh
    expect(store.get('anything')).toBeUndefined();

    // Can still save
    const record = makeRecord();
    store.save(record);
    expect(store.get(record.publicId)).toBeDefined();
  });
});
