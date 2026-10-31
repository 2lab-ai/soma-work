/**
 * #598 ④b1 — a task turn's work-log receipts (design 598b v5 §4.3): every
 * append promise is kept, a rejection is kept even after it settles, and the
 * drain is bounded (a timeout counts as a failure).
 */
import { describe, expect, it } from 'vitest';
import { createTaskTurnReceipts } from '../task-turn-receipts';

const binding = (turnId: string) => ({ sessionKey: 'task:t1', conversationId: 'conv-1', turnId });

describe('createTaskTurnReceipts (#598 ④b1)', () => {
  it('drains to undefined when every append landed', async () => {
    const r = createTaskTurnReceipts();
    const b = binding('a');
    r.open(b);
    r.track(b, Promise.resolve());
    r.track(b, Promise.resolve());
    await expect(r.drain(b)).resolves.toBeUndefined();
  });

  it('keeps the first rejection, even one that settled before the drain', async () => {
    const r = createTaskTurnReceipts();
    const b = binding('b');
    r.open(b);
    const failed = Promise.reject(new Error('ENOSPC'));
    failed.catch(() => {});
    r.track(b, failed);
    await new Promise((res) => setTimeout(res, 0));
    r.track(b, Promise.resolve());
    await expect(r.drain(b)).resolves.toBe('ENOSPC');
  });

  it('a hung append is a failure after the bound', async () => {
    const r = createTaskTurnReceipts({ drainTimeoutMs: 20 });
    const b = binding('c');
    r.open(b);
    r.track(b, new Promise(() => {}));
    await expect(r.drain(b)).resolves.toBe('work log append timed out');
  });

  it('turns are separate — one turn’s failure is not another’s', async () => {
    const r = createTaskTurnReceipts();
    const b1 = binding('d1');
    const b2 = binding('d2');
    r.open(b1);
    r.open(b2);
    const failed = Promise.reject(new Error('EIO'));
    failed.catch(() => {});
    r.track(b1, failed);
    r.track(b2, Promise.resolve());
    await expect(r.drain(b2)).resolves.toBeUndefined();
    await expect(r.drain(b1)).resolves.toBe('EIO');
  });

  it('a write for a turn that was never opened (or already drained) is not lost silently — it is ignored only after drain', async () => {
    const r = createTaskTurnReceipts();
    const b = binding('e');
    await expect(r.drain(b)).resolves.toBeUndefined();
    r.track(b, Promise.resolve()); // no throw
  });
});
