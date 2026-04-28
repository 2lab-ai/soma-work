import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../env-paths', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'instr-confirm-store-'));
  return { DATA_DIR: tmp };
});

// Import AFTER the mock so the singleton file-path is stable for the test.
import { DATA_DIR } from '../../../env-paths';
import type { SessionResourceUpdateRequest } from '../../../types';
import { PendingInstructionConfirmStore } from '../pending-instruction-confirm-store';

const STORE_FILE = path.join(DATA_DIR, 'pending-instruction-confirms.json');

function mkRequest(opCount = 1): SessionResourceUpdateRequest {
  return {
    instructionOperations: Array.from({ length: opCount }, (_, i) => ({
      action: 'add' as const,
      text: `instr ${i}`,
    })),
  };
}

// Shared requesterId for fixtures — individual tests override when the
// owner-identity is what's under test.
const DEFAULT_REQUESTER = 'U-owner';

describe('PendingInstructionConfirmStore', () => {
  beforeEach(() => {
    // Wipe the store file between tests so each test starts clean.
    if (fs.existsSync(STORE_FILE)) fs.unlinkSync(STORE_FILE);
  });

  it('set/get/delete round-trip', () => {
    const store = new PendingInstructionConfirmStore();
    const entry = {
      requestId: 'r1',
      sessionKey: 'C1|T1',
      channelId: 'C1',
      threadTs: 'T1',
      payload: mkRequest(),
      createdAt: Date.now(),
      requesterId: DEFAULT_REQUESTER,
      type: 'add' as const,
      by: { type: 'slack-user' as const, id: DEFAULT_REQUESTER },
    };
    expect(store.set(entry)).toBeUndefined();
    expect(store.get('r1')).toEqual(entry);
    expect(store.getBySession('C1|T1')).toEqual(entry);
    const deleted = store.delete('r1');
    expect(deleted).toEqual(entry);
    expect(store.get('r1')).toBeUndefined();
    expect(store.getBySession('C1|T1')).toBeUndefined();
  });

  it('overwrites existing entry for same sessionKey and returns evicted', () => {
    const store = new PendingInstructionConfirmStore();
    const a = {
      requestId: 'r1',
      sessionKey: 'C1|T1',
      channelId: 'C1',
      threadTs: 'T1',
      messageTs: 'ts-a',
      payload: mkRequest(),
      createdAt: Date.now(),
      requesterId: DEFAULT_REQUESTER,
      type: 'add' as const,
      by: { type: 'slack-user' as const, id: DEFAULT_REQUESTER },
    };
    store.set(a);
    const b = { ...a, requestId: 'r2', messageTs: undefined as string | undefined };
    const evicted = store.set(b);
    expect(evicted).toEqual(a);
    expect(store.get('r1')).toBeUndefined();
    expect(store.get('r2')).toEqual(b);
    expect(store.getBySession('C1|T1')).toEqual(b);
  });

  it('updateMessageTs mutates in place', () => {
    const store = new PendingInstructionConfirmStore();
    const entry = {
      requestId: 'r1',
      sessionKey: 'C1|T1',
      channelId: 'C1',
      threadTs: 'T1',
      payload: mkRequest(),
      createdAt: Date.now(),
      requesterId: DEFAULT_REQUESTER,
      type: 'add' as const,
      by: { type: 'slack-user' as const, id: DEFAULT_REQUESTER },
    };
    store.set(entry);
    store.updateMessageTs('r1', 'ts-123');
    expect(store.get('r1')?.messageTs).toBe('ts-123');
  });

  it('persists and reloads across instances', () => {
    const store = new PendingInstructionConfirmStore();
    store.set({
      requestId: 'r1',
      sessionKey: 'C1|T1',
      channelId: 'C1',
      threadTs: 'T1',
      messageTs: 'ts-1',
      payload: mkRequest(),
      createdAt: Date.now(),
      requesterId: DEFAULT_REQUESTER,
      type: 'add' as const,
      by: { type: 'slack-user' as const, id: DEFAULT_REQUESTER },
    });

    const store2 = new PendingInstructionConfirmStore();
    const loaded = store2.loadForms();
    expect(loaded).toBe(1);
    expect(store2.get('r1')?.messageTs).toBe('ts-1');
  });

  it('drops entries older than 24h on reload', () => {
    const store = new PendingInstructionConfirmStore();
    const expired = {
      requestId: 'old',
      sessionKey: 'C2|T2',
      channelId: 'C2',
      threadTs: 'T2',
      payload: mkRequest(),
      createdAt: Date.now() - 25 * 60 * 60 * 1000,
      requesterId: DEFAULT_REQUESTER,
      type: 'add' as const,
      by: { type: 'slack-user' as const, id: DEFAULT_REQUESTER },
    };
    const fresh = {
      requestId: 'new',
      sessionKey: 'C3|T3',
      channelId: 'C3',
      threadTs: 'T3',
      payload: mkRequest(),
      createdAt: Date.now(),
      requesterId: DEFAULT_REQUESTER,
      type: 'add' as const,
      by: { type: 'slack-user' as const, id: DEFAULT_REQUESTER },
    };
    // Write directly to file so we can set createdAt freely.
    fs.writeFileSync(STORE_FILE, JSON.stringify([expired, fresh], null, 2));
    const loaded = store.loadForms();
    expect(loaded).toBe(1);
    expect(store.get('old')).toBeUndefined();
    expect(store.get('new')).toEqual(fresh);
  });

  it('drops rehydrated entries missing requesterId (pre-schema-migration)', () => {
    // Persist a pre-migration entry shape (no requesterId) and verify the
    // reloader refuses it rather than rehydrate an unguardable record.
    const legacy = {
      requestId: 'legacy',
      sessionKey: 'C4|T4',
      channelId: 'C4',
      threadTs: 'T4',
      payload: mkRequest(),
      createdAt: Date.now(),
    };
    fs.writeFileSync(STORE_FILE, JSON.stringify([legacy], null, 2));
    const store = new PendingInstructionConfirmStore();
    const loaded = store.loadForms();
    expect(loaded).toBe(0);
    expect(store.get('legacy')).toBeUndefined();
  });

  it('get(requestId) treats expired entries as gone and deletes them', () => {
    // Runtime TTL guard — before the fix the expiry check only ran at
    // loadForms time, so a long-running process could serve entries past
    // their 24h window. Force an expired createdAt and verify get/
    // getBySession sweep it lazily.
    const store = new PendingInstructionConfirmStore();
    store.set({
      requestId: 'stale',
      sessionKey: 'C5|T5',
      channelId: 'C5',
      threadTs: 'T5',
      payload: mkRequest(),
      createdAt: Date.now() - 25 * 60 * 60 * 1000,
      requesterId: DEFAULT_REQUESTER,
      type: 'add',
      by: { type: 'slack-user', id: DEFAULT_REQUESTER },
    });
    expect(store.get('stale')).toBeUndefined();
    expect(store.getBySession('C5|T5')).toBeUndefined();
    // Should also have been purged from the snapshot list.
    expect(store.list()).toHaveLength(0);
  });
});
