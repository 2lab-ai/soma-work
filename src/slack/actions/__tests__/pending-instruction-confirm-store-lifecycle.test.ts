/**
 * Pending entry shape extension for sealed 5-op lifecycle vocabulary (#755).
 *
 * The pre-#755 entry carried only `requestId / sessionKey / request /
 * requesterId / messageTs`. After #755 the entry MUST also carry:
 *
 *   - `type`  — the lifecycle op that produced it
 *               ('add' | 'link' | 'complete' | 'cancel' | 'rename')
 *   - `by`    — `{ type, id }` actor descriptor matching the sealed
 *               `lifecycleEvents[].by` shape so the host can build the
 *               audit row without re-deriving identity.
 *
 * Both fields survive persistence + reload, and entries missing the new
 * fields are rejected on rehydrate (defense against pre-migration shape
 * leaking through a worktree restart).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../env-paths', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'instr-confirm-lifecycle-'));
  return { DATA_DIR: tmp };
});

import { DATA_DIR } from '../../../env-paths';
import type { SessionResourceUpdateRequest } from '../../../types';
import { PendingInstructionConfirmStore } from '../pending-instruction-confirm-store';

const STORE_FILE = path.join(DATA_DIR, 'pending-instruction-confirms.json');

function mkRequest(action: 'add' | 'link' | 'complete' | 'cancel' | 'rename'): SessionResourceUpdateRequest {
  switch (action) {
    case 'add':
      return { instructionOperations: [{ action: 'add', text: 'do x' }] };
    case 'link':
      return { instructionOperations: [{ action: 'link', id: 'i1', sessionKey: 'C-D|T-D' }] };
    case 'complete':
      return { instructionOperations: [{ action: 'complete', id: 'i1', evidence: 'merged' }] };
    case 'cancel':
      return { instructionOperations: [{ action: 'cancel', id: 'i1' }] };
    case 'rename':
      return { instructionOperations: [{ action: 'rename', id: 'i1', text: 'better text' }] };
  }
}

const REQUESTER = 'U-owner';

describe('PendingInstructionConfirmStore — sealed lifecycle entry shape (#755)', () => {
  beforeEach(() => {
    if (fs.existsSync(STORE_FILE)) fs.unlinkSync(STORE_FILE);
  });

  for (const action of ['add', 'link', 'complete', 'cancel', 'rename'] as const) {
    it(`stores type='${action}' entry with by.type='slack-user' and round-trips through disk`, () => {
      const store = new PendingInstructionConfirmStore();
      const entry = {
        requestId: `r-${action}`,
        sessionKey: 'C1|T1',
        channelId: 'C1',
        threadTs: 'T1',
        payload: mkRequest(action),
        createdAt: Date.now(),
        requesterId: REQUESTER,
        type: action,
        by: { type: 'slack-user' as const, id: REQUESTER },
      };
      store.set(entry);
      const got = store.get(`r-${action}`);
      expect(got?.type).toBe(action);
      expect(got?.by).toEqual({ type: 'slack-user', id: REQUESTER });

      const reloaded = new PendingInstructionConfirmStore();
      const n = reloaded.loadForms();
      expect(n).toBe(1);
      const after = reloaded.get(`r-${action}`);
      expect(after?.type).toBe(action);
      expect(after?.by).toEqual({ type: 'slack-user', id: REQUESTER });
    });
  }

  it('rejects rehydrate of entries missing `type` or `by` (post-#755 shape only)', () => {
    // Persist a pre-#755 entry shape (no type / no by) and verify the
    // reloader refuses it rather than silently treat it as an `add`.
    const legacy = {
      requestId: 'legacy',
      sessionKey: 'C9|T9',
      channelId: 'C9',
      threadTs: 'T9',
      payload: mkRequest('add'),
      createdAt: Date.now(),
      requesterId: REQUESTER,
      // type and by intentionally absent
    };
    fs.writeFileSync(STORE_FILE, JSON.stringify([legacy], null, 2));
    const store = new PendingInstructionConfirmStore();
    const loaded = store.loadForms();
    expect(loaded).toBe(0);
    expect(store.get('legacy')).toBeUndefined();
  });

  it('supersede returns the evicted entry (so caller can record state="superseded")', () => {
    const store = new PendingInstructionConfirmStore();
    const a = {
      requestId: 'rA',
      sessionKey: 'C1|T1',
      channelId: 'C1',
      threadTs: 'T1',
      payload: mkRequest('add'),
      createdAt: Date.now(),
      requesterId: REQUESTER,
      type: 'add' as const,
      by: { type: 'slack-user' as const, id: REQUESTER },
    };
    store.set(a);
    const b = { ...a, requestId: 'rB', type: 'link' as const, payload: mkRequest('link') };
    const evicted = store.set(b);
    expect(evicted?.requestId).toBe('rA');
    expect(evicted?.type).toBe('add');
    expect(store.get('rA')).toBeUndefined();
    expect(store.get('rB')?.type).toBe('link');
  });

  // PR2 P1-4 (#755): the sealed pending-confirm entry shape carries the
  // deferred update under `payload` (matching the lifecycleEvents[].payload
  // anchor), not `request`. The pre-PR2 store used `request` which made
  // the persistent entry diverge from the audit-row shape, forcing a
  // rename inside InstructionConfirmActionHandler at every read.
  it('persists the deferred update under `payload` (sealed shape) — not the legacy `request`', () => {
    const store = new PendingInstructionConfirmStore();
    const entry = {
      requestId: 'r-payload',
      sessionKey: 'C1|T1',
      channelId: 'C1',
      threadTs: 'T1',
      payload: mkRequest('add'),
      createdAt: Date.now(),
      requesterId: REQUESTER,
      type: 'add' as const,
      by: { type: 'slack-user' as const, id: REQUESTER },
    };
    store.set(entry);

    // In-memory get: payload is present, request is not.
    const got = store.get('r-payload') as unknown as Record<string, unknown>;
    expect(got).toBeDefined();
    expect(got.payload).toEqual(mkRequest('add'));
    expect((got as { request?: unknown }).request).toBeUndefined();

    // Round-trip through disk: same shape after rehydrate.
    const reloaded = new PendingInstructionConfirmStore();
    expect(reloaded.loadForms()).toBe(1);
    const after = reloaded.get('r-payload') as unknown as Record<string, unknown>;
    expect(after.payload).toEqual(mkRequest('add'));
    expect((after as { request?: unknown }).request).toBeUndefined();
  });

  it('rejects rehydrate of entries that carry only the legacy `request` field (pre-PR2 shape)', () => {
    // A pre-PR2 entry persisted under `request` would not satisfy the
    // sealed shape; the loader rejects it rather than silently coerce.
    const legacy = {
      requestId: 'legacy-req',
      sessionKey: 'C9|T9',
      channelId: 'C9',
      threadTs: 'T9',
      request: mkRequest('add'), // legacy field
      createdAt: Date.now(),
      requesterId: REQUESTER,
      type: 'add' as const,
      by: { type: 'slack-user' as const, id: REQUESTER },
    };
    fs.writeFileSync(STORE_FILE, JSON.stringify([legacy], null, 2));
    const store = new PendingInstructionConfirmStore();
    const loaded = store.loadForms();
    expect(loaded).toBe(0);
    expect(store.get('legacy-req')).toBeUndefined();
  });

  // PR2 fix loop #2 P2 (#755): the rehydrate guard also validates that
  // `payload.instructionOperations` is a non-empty array AND its single op's
  // `action` matches the entry's `type`. Without this, a corrupted on-disk
  // entry with mismatched `type=add` but `payload.instructionOperations[0]
  // .action='cancel'` would mis-attribute the lifecycleEvents row built
  // from `entry.type` while the catalog applies the (different) op.
  it('rejects rehydrate when payload.instructionOperations is missing or empty', () => {
    const corrupt = {
      requestId: 'corrupt-no-ops',
      sessionKey: 'C9|T9',
      channelId: 'C9',
      threadTs: 'T9',
      payload: { instructionOperations: [] }, // empty
      createdAt: Date.now(),
      requesterId: REQUESTER,
      type: 'add' as const,
      by: { type: 'slack-user' as const, id: REQUESTER },
    };
    fs.writeFileSync(STORE_FILE, JSON.stringify([corrupt], null, 2));
    const store = new PendingInstructionConfirmStore();
    expect(store.loadForms()).toBe(0);
    expect(store.get('corrupt-no-ops')).toBeUndefined();
  });

  it('rejects rehydrate when entry.type does not match payload op action', () => {
    const mismatched = {
      requestId: 'mismatched',
      sessionKey: 'C9|T9',
      channelId: 'C9',
      threadTs: 'T9',
      payload: mkRequest('cancel'), // op.action === 'cancel'
      createdAt: Date.now(),
      requesterId: REQUESTER,
      type: 'add' as const, // ← inconsistent with payload op
      by: { type: 'slack-user' as const, id: REQUESTER },
    };
    fs.writeFileSync(STORE_FILE, JSON.stringify([mismatched], null, 2));
    const store = new PendingInstructionConfirmStore();
    expect(store.loadForms()).toBe(0);
    expect(store.get('mismatched')).toBeUndefined();
  });

  it('rejects rehydrate when payload carries multiple ops (sealed single-op rule)', () => {
    const multi = {
      requestId: 'multi',
      sessionKey: 'C9|T9',
      channelId: 'C9',
      threadTs: 'T9',
      payload: {
        instructionOperations: [
          { action: 'add', text: 'one' },
          { action: 'add', text: 'two' },
        ],
      },
      createdAt: Date.now(),
      requesterId: REQUESTER,
      type: 'add' as const,
      by: { type: 'slack-user' as const, id: REQUESTER },
    };
    fs.writeFileSync(STORE_FILE, JSON.stringify([multi], null, 2));
    const store = new PendingInstructionConfirmStore();
    expect(store.loadForms()).toBe(0);
    expect(store.get('multi')).toBeUndefined();
  });
});
