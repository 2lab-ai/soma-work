import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../env-paths', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'instr-confirm-store-'));
  return { DATA_DIR: tmp };
});

// Import AFTER the mock so the singleton file-path is stable for the test.
import { DATA_DIR } from '../../env-paths';
import type { SessionResourceUpdateRequest } from '../../types';
import { PendingInstructionConfirmStore } from './pending-instruction-confirm-store';

const STORE_FILE = path.join(DATA_DIR, 'pending-instruction-confirms.json');

function mkRequest(opCount = 1): SessionResourceUpdateRequest {
  return {
    instructionOperations: Array.from({ length: opCount }, (_, i) => ({
      action: 'add' as const,
      text: `instr ${i}`,
    })),
  };
}

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
      request: mkRequest(),
      createdAt: Date.now(),
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
      request: mkRequest(),
      createdAt: Date.now(),
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
      request: mkRequest(),
      createdAt: Date.now(),
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
      request: mkRequest(),
      createdAt: Date.now(),
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
      request: mkRequest(),
      createdAt: Date.now() - 25 * 60 * 60 * 1000,
    };
    const fresh = {
      requestId: 'new',
      sessionKey: 'C3|T3',
      channelId: 'C3',
      threadTs: 'T3',
      request: mkRequest(),
      createdAt: Date.now(),
    };
    // Write directly to file so we can set createdAt freely.
    fs.writeFileSync(STORE_FILE, JSON.stringify([expired, fresh], null, 2));
    const loaded = store.loadForms();
    expect(loaded).toBe(1);
    expect(store.get('old')).toBeUndefined();
    expect(store.get('new')).toEqual(fresh);
  });
});
