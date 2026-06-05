import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTurnFeedbackStoreDataDirProvider, TurnFeedbackStore } from '../turn-feedback-store';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-feedback-'));
  setTurnFeedbackStoreDataDirProvider(() => tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const base = {
  turnId: 'C1-1.2:1700:abc',
  userId: 'U1',
  channel: 'C1',
  threadTs: '1700.1',
  messageTs: '1700.9',
  category: 'WorkflowComplete',
} as const;

describe('TurnFeedbackStore', () => {
  it('records and reads back a feedback record', () => {
    const store = new TurnFeedbackStore();
    const rec = store.record({ ...base, sentiment: 'positive' });

    expect(rec.sentiment).toBe('positive');
    expect(rec.createdAt).toBeGreaterThan(0);
    expect(store.get(base.turnId, base.userId)?.sentiment).toBe('positive');
  });

  it('is idempotent per (turnId, userId): repeated same-sentiment click keeps one record', () => {
    const store = new TurnFeedbackStore();
    store.record({ ...base, sentiment: 'positive' });
    store.record({ ...base, sentiment: 'positive' });

    expect(store.listForTurn(base.turnId)).toHaveLength(1);
  });

  it('upserts in place on a sentiment flip and bumps updatedAt', () => {
    const store = new TurnFeedbackStore();
    const first = store.record({ ...base, sentiment: 'positive' });
    const flipped = store.record({ ...base, sentiment: 'negative' });

    expect(store.listForTurn(base.turnId)).toHaveLength(1);
    expect(flipped.sentiment).toBe('negative');
    expect(flipped.createdAt).toBe(first.createdAt); // preserved
    expect(flipped.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
  });

  it('keeps different users independent on the same turn', () => {
    const store = new TurnFeedbackStore();
    store.record({ ...base, userId: 'U1', sentiment: 'positive' });
    store.record({ ...base, userId: 'U2', sentiment: 'negative' });

    expect(store.listForTurn(base.turnId)).toHaveLength(2);
    expect(store.get(base.turnId, 'U1')?.sentiment).toBe('positive');
    expect(store.get(base.turnId, 'U2')?.sentiment).toBe('negative');
  });

  it('persists to disk and rehydrates via load()', () => {
    const a = new TurnFeedbackStore();
    a.record({ ...base, sentiment: 'positive' });

    const b = new TurnFeedbackStore();
    expect(b.load()).toBe(1);
    expect(b.get(base.turnId, base.userId)?.sentiment).toBe('positive');
  });

  it('prunes records that expire in-memory on the next write (long-uptime bound)', () => {
    vi.useFakeTimers();
    try {
      const store = new TurnFeedbackStore();
      store.record({ ...base, turnId: 'old', sentiment: 'positive' });
      // Age past the 30d TTL while the record sits in memory, then write again.
      vi.advanceTimersByTime(40 * 24 * 60 * 60 * 1000);
      store.record({ ...base, turnId: 'fresh', sentiment: 'positive' });

      expect(store.get('old', base.userId)).toBeUndefined();
      expect(store.get('fresh', base.userId)?.sentiment).toBe('positive');
      expect(store.list()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops malformed records on load', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'turn-feedback.json'),
      JSON.stringify([{ turnId: 'x', userId: 'U', sentiment: 'bogus' }, null, { userId: 'no-turn' }]),
    );
    const store = new TurnFeedbackStore();
    expect(store.load()).toBe(0);
  });
});
