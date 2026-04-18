/**
 * mutateAndPersist commit/rollback tests — plan v8 tests 36-38.
 *
 * mutateAndPersist is an internal wrapper on FileSessionStore. We exercise it
 * by injecting an atomicRewrite failure via a mocked `fs.promises.rename`.
 *
 * Invariant under test: if atomicRewrite throws, the in-memory records map is
 * restored to its pre-mutation snapshot; on success both memory and file
 * reflect the mutation.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileSessionStore } from './session-store.js';
import type { SessionRecord } from './types.js';

function tmpFilePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutate-persist-test-'));
  return path.join(dir, 'llm-sessions.jsonl');
}

function makeRecord(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  const now = new Date().toISOString();
  return {
    publicId: id,
    backend: 'codex',
    backendSessionId: `thread-${id}`,
    model: 'gpt-5.4',
    resolvedConfig: {},
    status: 'ready',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('mutateAndPersist (via FileSessionStore)', () => {
  let filePath: string;

  beforeEach(() => {
    filePath = tmpFilePath();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('rollback: atomicRewrite fails → memory equals pre-mutation snapshot (test 36)', async () => {
    const store = new FileSessionStore(filePath);
    // Seed one record successfully first.
    const initial = makeRecord('a', { backendSessionId: 'orig-a' });
    await store.save(initial);
    expect(store.get('a')!.backendSessionId).toBe('orig-a');

    // Inject rename failure for the NEXT write.
    const origRename = fs.promises.rename;
    const spy = vi.spyOn(fs.promises, 'rename').mockImplementationOnce(async () => {
      throw new Error('INJECTED_RENAME_FAIL');
    });

    await expect(
      store.save(makeRecord('a', { backendSessionId: 'will-fail' })),
    ).rejects.toThrow('INJECTED_RENAME_FAIL');

    // Memory restored: still the pre-mutation value.
    expect(store.get('a')!.backendSessionId).toBe('orig-a');

    // File on disk also still the pre-mutation value (because rewrite never
    // completed — rename is the atomic swap step).
    const store2 = new FileSessionStore(filePath);
    expect(store2.get('a')!.backendSessionId).toBe('orig-a');

    spy.mockRestore();
    void origRename;
  });

  it('commit: atomicRewrite succeeds → memory AND file reflect mutation (test 37)', async () => {
    const store = new FileSessionStore(filePath);
    const rec = makeRecord('b', { backendSessionId: 'final-b' });
    await store.save(rec);
    expect(store.get('b')!.backendSessionId).toBe('final-b');

    // File must also reflect it — reload in a fresh store.
    const store2 = new FileSessionStore(filePath);
    expect(store2.get('b')!.backendSessionId).toBe('final-b');

    // File body sanity: one JSONL line.
    const body = fs.readFileSync(filePath, 'utf8').trim();
    expect(body.split('\n')).toHaveLength(1);
  });

  it('sequential: first rolls back, second succeeds → only second is visible (test 38)', async () => {
    const store = new FileSessionStore(filePath);

    // First mutation: inject failure.
    const spy = vi.spyOn(fs.promises, 'rename').mockImplementationOnce(async () => {
      throw new Error('INJECTED_RENAME_FAIL');
    });
    await expect(store.save(makeRecord('x', { backendSessionId: 'x-1' }))).rejects.toThrow(
      'INJECTED_RENAME_FAIL',
    );
    spy.mockRestore();

    // After rollback: memory must not contain 'x'.
    expect(store.get('x')).toBeUndefined();

    // Second mutation succeeds with a different record.
    await store.save(makeRecord('y', { backendSessionId: 'y-1' }));

    // Memory consistency: only 'y' is present.
    expect(store.get('y')!.backendSessionId).toBe('y-1');
    expect(store.get('x')).toBeUndefined();

    // File: exactly one line (the 'y' record).
    const store2 = new FileSessionStore(filePath);
    expect(store2.get('y')!.backendSessionId).toBe('y-1');
    expect(store2.get('x')).toBeUndefined();
    const body = fs.readFileSync(filePath, 'utf8').trim();
    expect(body.split('\n')).toHaveLength(1);
  });
});
