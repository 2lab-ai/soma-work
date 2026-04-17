/**
 * Session-store JSONL / migration / v8 invariant tests — plan v8 tests 39-47c.
 *
 * Separate from session-store.test.ts (basic CRUD) to keep concerns isolated.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileSessionStore } from './session-store.js';
import type { SessionRecord } from './types.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'session-store-jsonl-'));
}

function jsonlLine(rec: Partial<SessionRecord> & { publicId: string }): string {
  const now = new Date().toISOString();
  const full = {
    publicId: rec.publicId,
    backend: rec.backend ?? 'codex',
    backendSessionId: rec.backendSessionId ?? 'thread-1',
    model: rec.model ?? 'gpt-5.4',
    resolvedConfig: rec.resolvedConfig ?? {},
    status: rec.status ?? 'ready',
    createdAt: rec.createdAt ?? now,
    updatedAt: rec.updatedAt ?? now,
    ...(rec.cwd ? { cwd: rec.cwd } : {}),
  };
  return JSON.stringify(full);
}

describe('FileSessionStore — JSONL + migration + v8 invariants', () => {
  let dir: string;
  let filePath: string;
  let legacyPath: string;

  beforeEach(() => {
    dir = tmpDir();
    filePath = path.join(dir, 'llm-sessions.jsonl');
    legacyPath = path.join(dir, 'llm-sessions.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('malformed JSONL line is skipped with warn (test 39)', async () => {
    const body =
      jsonlLine({ publicId: 'good-1' }) + '\n' +
      '{"not closed\n' +  // malformed
      jsonlLine({ publicId: 'good-2' }) + '\n';
    fs.writeFileSync(filePath, body, 'utf8');

    const store = new FileSessionStore(filePath);
    expect(store.get('good-1')).toBeDefined();
    expect(store.get('good-2')).toBeDefined();
    // Malformed line skipped — file still readable for survivors.
  });

  it('legacy blob migrated → JSONL + .bak (test 40)', async () => {
    const now = new Date().toISOString();
    const blob = [
      {
        publicId: 'legacy-1',
        backend: 'codex',
        backendSessionId: 'thread-legacy-1',
        model: 'gpt-5.4',
        resolvedConfig: { foo: 'bar' },
        status: 'ready',
        createdAt: now,
        updatedAt: now,
      },
    ];
    fs.writeFileSync(legacyPath, JSON.stringify(blob), 'utf8');

    const store = new FileSessionStore(filePath);
    expect(store.get('legacy-1')).toBeDefined();
    expect(store.get('legacy-1')!.resolvedConfig).toEqual({ foo: 'bar' });

    // JSONL written
    expect(fs.existsSync(filePath)).toBe(true);
    // Legacy blob renamed to .bak
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(fs.existsSync(`${legacyPath}.bak`)).toBe(true);
  });

  it('legacy blob top-level parse error → .bak.corrupt + empty start (test 41)', async () => {
    fs.writeFileSync(legacyPath, 'not valid json {{{', 'utf8');

    const store = new FileSessionStore(filePath);
    // Empty store — no records loaded from corrupt blob.
    expect(store.get('anything')).toBeUndefined();

    // Corrupt backup preserved.
    expect(fs.existsSync(`${legacyPath}.bak.corrupt`)).toBe(true);
  });

  it('legacy record without resolvedConfig → corrupted + legacy-unresumable (test 42)', async () => {
    const now = new Date().toISOString();
    const blob = [
      {
        publicId: 'legacy-no-cfg',
        backend: 'codex',
        backendSessionId: 'thread-x',
        model: 'gpt-5.4',
        // no resolvedConfig field
        createdAt: now,
        updatedAt: now,
      },
    ];
    fs.writeFileSync(legacyPath, JSON.stringify(blob), 'utf8');

    const store = new FileSessionStore(filePath);
    const rec = store.get('legacy-no-cfg');
    expect(rec).toBeDefined();
    expect(rec!.status).toBe('corrupted');
  });

  it('50 concurrent distinct-ID saves — no lost update (test 43)', async () => {
    const store = new FileSessionStore(filePath);
    const now = new Date().toISOString();
    const saves = Array.from({ length: 50 }, (_, i) =>
      store.save({
        publicId: `concurrent-${i}`,
        backend: 'codex',
        backendSessionId: `thread-${i}`,
        model: 'gpt-5.4',
        resolvedConfig: {},
        status: 'ready',
        createdAt: now,
        updatedAt: now,
      }),
    );
    await Promise.all(saves);

    const store2 = new FileSessionStore(filePath);
    for (let i = 0; i < 50; i++) {
      expect(store2.get(`concurrent-${i}`)).toBeDefined();
    }
    const body = fs.readFileSync(filePath, 'utf8').trim();
    expect(body.split('\n')).toHaveLength(50);
  });

  it('concurrent save+update+delete mix → file consistent (test 44)', async () => {
    const store = new FileSessionStore(filePath);
    const now = new Date().toISOString();
    // Seed 10 records.
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.save({
          publicId: `mix-${i}`,
          backend: 'codex',
          backendSessionId: `thread-${i}`,
          model: 'gpt-5.4',
          resolvedConfig: {},
          status: 'ready',
          createdAt: now,
          updatedAt: now,
        }),
      ),
    );

    // Interleave updates and deletes.
    const ops: Promise<void>[] = [];
    for (let i = 0; i < 10; i++) {
      if (i % 3 === 0) {
        ops.push(store.updateBackendSessionId(`mix-${i}`, `rotated-${i}`));
      } else if (i % 3 === 1) {
        ops.push(store.delete(`mix-${i}`));
      } else {
        ops.push(store.touch(`mix-${i}`));
      }
    }
    await Promise.all(ops);

    const store2 = new FileSessionStore(filePath);
    for (let i = 0; i < 10; i++) {
      const got = store2.get(`mix-${i}`);
      if (i % 3 === 0) {
        expect(got!.backendSessionId).toBe(`rotated-${i}`);
      } else if (i % 3 === 1) {
        expect(got).toBeUndefined();
      } else {
        expect(got).toBeDefined();
      }
    }
  });

  it('atomic rewrite crash → primary intact (test 45)', async () => {
    const store = new FileSessionStore(filePath);
    const now = new Date().toISOString();
    await store.save({
      publicId: 'intact',
      backend: 'codex',
      backendSessionId: 'thread-intact',
      model: 'gpt-5.4',
      resolvedConfig: {},
      status: 'ready',
      createdAt: now,
      updatedAt: now,
    });

    // Inject rename failure for the next rewrite.
    const spy = vi.spyOn(fs.promises, 'rename').mockImplementationOnce(async () => {
      throw new Error('INJECTED_CRASH');
    });
    await expect(
      store.updateBackendSessionId('intact', 'should-not-commit'),
    ).rejects.toThrow('INJECTED_CRASH');
    spy.mockRestore();

    // Primary file still holds the pre-mutation value.
    const store2 = new FileSessionStore(filePath);
    expect(store2.get('intact')!.backendSessionId).toBe('thread-intact');
  });

  it('missing status, resolvedConfig present → coerced to ready (test 46)', async () => {
    const now = new Date().toISOString();
    const raw = {
      publicId: 'no-status',
      backend: 'codex',
      backendSessionId: 'thread-ns',
      model: 'gpt-5.4',
      resolvedConfig: { k: 1 },
      // no status
      createdAt: now,
      updatedAt: now,
    };
    fs.writeFileSync(filePath, JSON.stringify(raw) + '\n', 'utf8');

    const store = new FileSessionStore(filePath);
    const rec = store.get('no-status');
    expect(rec!.status).toBe('ready');
  });

  it('unknown status → coerced to corrupted (test 47)', async () => {
    const now = new Date().toISOString();
    const raw = {
      publicId: 'weird-status',
      backend: 'codex',
      backendSessionId: 'thread-ws',
      model: 'gpt-5.4',
      resolvedConfig: {},
      status: 'something-unexpected',
      createdAt: now,
      updatedAt: now,
    };
    fs.writeFileSync(filePath, JSON.stringify(raw) + '\n', 'utf8');

    const store = new FileSessionStore(filePath);
    expect(store.get('weird-status')!.status).toBe('corrupted');
  });

  it('v8 invariant: ready with null backendSessionId → corrupted (test 47b)', async () => {
    const now = new Date().toISOString();
    const raw = {
      publicId: 'ready-null-bsid',
      backend: 'codex',
      backendSessionId: null,
      model: 'gpt-5.4',
      resolvedConfig: {},
      status: 'ready',
      createdAt: now,
      updatedAt: now,
    };
    fs.writeFileSync(filePath, JSON.stringify(raw) + '\n', 'utf8');

    const store = new FileSessionStore(filePath);
    const rec = store.get('ready-null-bsid');
    expect(rec!.status).toBe('corrupted');
    expect(rec!.backendSessionId).toBeNull();
  });

  it('v8 invariant: pending with non-null backendSessionId → corrupted (test 47c)', async () => {
    const now = new Date().toISOString();
    const raw = {
      publicId: 'pending-with-bsid',
      backend: 'codex',
      backendSessionId: 'thread-ghost',
      model: 'gpt-5.4',
      resolvedConfig: {},
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    fs.writeFileSync(filePath, JSON.stringify(raw) + '\n', 'utf8');

    const store = new FileSessionStore(filePath);
    const rec = store.get('pending-with-bsid');
    expect(rec!.status).toBe('corrupted');
  });
});
