/**
 * RED tests for the server-side pending permission-request store.
 *
 * Buttons in the permission prompt carry ONLY a requestId; the authoritative
 * request data (operation, requester, owner, skill, channel, originalText) is
 * read back from here (codex review: don't trust forgeable button fields).
 * Requests dedupe by (owner, skill, requester, operation) so a re-dispatch
 * after a partial grant doesn't spam B with duplicate prompts, and are marked
 * handled to prevent replay.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempDir: string;

vi.mock('../env-paths', () => ({
  get DATA_DIR() {
    return tempDir;
  },
  IS_DEV: true,
}));

vi.mock('../logger', () => ({
  Logger: class {
    debug() {}
    info() {}
    warn() {}
    error() {}
  },
}));

describe('skill-permission-request-store', () => {
  let store: typeof import('../skill-permission-request-store');

  const base = {
    operation: 'invoke' as const,
    requesterId: 'U0A',
    ownerId: 'U0B',
    skillName: 'deploy',
    channel: 'C1',
    threadTs: '171.1',
    originalText: '$<@U0B>:deploy',
  };

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-permreq-'));
    vi.resetModules();
    store = await import('../skill-permission-request-store');
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('creates a request with a requestId and round-trips it', () => {
    const req = store.createPermissionRequest(base);
    expect(req.requestId).toBeTruthy();
    const got = store.getPermissionRequest(req.requestId);
    expect(got).not.toBeNull();
    expect(got?.skillName).toBe('deploy');
    expect(got?.ownerId).toBe('U0B');
    expect(got?.originalText).toBe('$<@U0B>:deploy');
    expect(got?.handled).toBe(false);
  });

  it('dedupes an identical (owner, skill, requester, operation) request', () => {
    const a = store.createPermissionRequest(base);
    const b = store.createPermissionRequest(base);
    expect(b.requestId).toBe(a.requestId);
  });

  it('does NOT dedupe across different operations', () => {
    const inv = store.createPermissionRequest(base);
    const view = store.createPermissionRequest({ ...base, operation: 'view' });
    expect(view.requestId).not.toBe(inv.requestId);
  });

  it('marks a request handled to prevent replay', () => {
    const req = store.createPermissionRequest(base);
    store.markRequestHandled(req.requestId);
    expect(store.getPermissionRequest(req.requestId)?.handled).toBe(true);
    // A handled request no longer dedupes — a fresh attempt creates a new one.
    const again = store.createPermissionRequest(base);
    expect(again.requestId).not.toBe(req.requestId);
  });

  it('persists across a fresh module load', async () => {
    const req = store.createPermissionRequest(base);
    vi.resetModules();
    const reloaded = await import('../skill-permission-request-store');
    expect(reloaded.getPermissionRequest(req.requestId)?.skillName).toBe('deploy');
  });

  it('treats an expired request as absent', () => {
    const req = store.createPermissionRequest({ ...base, ttlMs: -1 });
    expect(store.getPermissionRequest(req.requestId)).toBeNull();
  });
});
