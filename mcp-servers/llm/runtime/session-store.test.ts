/**
 * Unit Tests — FileSessionStore (post-refactor: JSONL + WriteQueue).
 *
 * Covers basic CRUD + TTL; JSONL/migration/invariant specifics are in
 * session-store-jsonl.test.ts.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileSessionStore } from './session-store.js';
import type { SessionRecord } from './types.js';

function tmpFilePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-store-test-'));
  return path.join(dir, 'llm-sessions.jsonl');
}

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const now = new Date().toISOString();
  return {
    publicId: `pub-${Math.random().toString(36).slice(2, 10)}`,
    backend: 'codex',
    backendSessionId: `thread-${Math.random().toString(36).slice(2, 10)}`,
    model: 'gpt-5.4',
    resolvedConfig: {},
    status: 'ready',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('FileSessionStore', () => {
  let filePath: string;

  beforeEach(() => {
    filePath = tmpFilePath();
  });

  afterEach(() => {
    try {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('saves and retrieves a session record', async () => {
    const store = new FileSessionStore(filePath);
    const record = makeRecord();
    await store.save(record);

    const got = store.get(record.publicId);
    expect(got).toBeDefined();
    expect(got!.publicId).toBe(record.publicId);
    expect(got!.backend).toBe('codex');
    expect(got!.backendSessionId).toBe(record.backendSessionId);
    expect(got!.model).toBe('gpt-5.4');
    expect(got!.status).toBe('ready');
  });

  it('returns undefined for unknown publicId', () => {
    const store = new FileSessionStore(filePath);
    expect(store.get('nonexistent')).toBeUndefined();
  });

  it('deletes a session record', async () => {
    const store = new FileSessionStore(filePath);
    const record = makeRecord();
    await store.save(record);
    expect(store.get(record.publicId)).toBeDefined();
    await store.delete(record.publicId);
    expect(store.get(record.publicId)).toBeUndefined();
  });

  it('updates backend session ID and updatedAt', async () => {
    const store = new FileSessionStore(filePath);
    const beforeUpdate = new Date(Date.now() - 60_000).toISOString();
    const record = makeRecord({ updatedAt: beforeUpdate });
    await store.save(record);

    await store.updateBackendSessionId(record.publicId, 'new-thread-xyz');

    const got = store.get(record.publicId);
    expect(got!.backendSessionId).toBe('new-thread-xyz');
    expect(new Date(got!.updatedAt).getTime()).toBeGreaterThan(new Date(beforeUpdate).getTime());
  });

  it('updateBackendSessionId is a no-op for unknown publicId', async () => {
    const store = new FileSessionStore(filePath);
    await store.updateBackendSessionId('nonexistent', 'new-id');
  });

  it('touch refreshes updatedAt without changing other fields', async () => {
    const store = new FileSessionStore(filePath);
    const beforeTouch = new Date(Date.now() - 1000).toISOString();
    const record = makeRecord({ updatedAt: beforeTouch });
    await store.save(record);

    await store.touch(record.publicId);

    const got = store.get(record.publicId);
    expect(got!.backendSessionId).toBe(record.backendSessionId);
    expect(new Date(got!.updatedAt).getTime()).toBeGreaterThan(new Date(beforeTouch).getTime());
  });

  it('returns undefined for expired sessions (TTL 24h)', async () => {
    const store = new FileSessionStore(filePath);
    const expired = makeRecord({
      updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    });
    await store.save(expired);
    expect(store.get(expired.publicId)).toBeUndefined();
  });

  it('returns valid session within TTL', async () => {
    const store = new FileSessionStore(filePath);
    const fresh = makeRecord({
      updatedAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
    });
    await store.save(fresh);
    expect(store.get(fresh.publicId)).toBeDefined();
  });

  it('prune removes expired sessions', async () => {
    const store = new FileSessionStore(filePath);
    const expired = makeRecord({
      updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    });
    const fresh = makeRecord();
    await store.save(expired);
    await store.save(fresh);
    await store.prune();

    const store2 = new FileSessionStore(filePath);
    expect(store2.get(expired.publicId)).toBeUndefined();
    expect(store2.get(fresh.publicId)).toBeDefined();
  });

  it('persists across store instances', async () => {
    const store1 = new FileSessionStore(filePath);
    const record = makeRecord();
    await store1.save(record);

    const store2 = new FileSessionStore(filePath);
    const got = store2.get(record.publicId);
    expect(got).toBeDefined();
    expect(got!.publicId).toBe(record.publicId);
  });

  it('writes atomically (no .tmp file left behind)', async () => {
    const store = new FileSessionStore(filePath);
    await store.save(makeRecord());
    const dir = path.dirname(filePath);
    const files = fs.readdirSync(dir);
    expect(files).not.toContain(path.basename(filePath) + '.tmp');
    expect(files).toContain(path.basename(filePath));
  });
});
