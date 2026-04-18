/**
 * WriteQueue tests — plan v8 tests 31-35b.
 */
import { describe, expect, it } from 'vitest';
import { WriteQueue } from './write-queue.js';
import { ErrorCode, LlmChatError } from './errors.js';

describe('WriteQueue', () => {
  it('preserves FIFO order under 100 concurrent enqueues (test 31)', async () => {
    const q = new WriteQueue();
    const order: number[] = [];
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 100; i++) {
      promises.push(q.run(async () => {
        // Random micro-delay to stress interleaving
        await new Promise<void>((r) => {
          const t = setTimeout(r, Math.random() * 2);
          t.unref?.();
        });
        order.push(i);
      }));
    }
    await Promise.all(promises);
    expect(order).toEqual([...Array(100).keys()]);
  });

  it('continues after a task throws (test 32)', async () => {
    const q = new WriteQueue();
    const err = q.run(async () => { throw new Error('boom'); });
    await expect(err).rejects.toThrow('boom');
    let ran = false;
    await q.run(async () => { ran = true; });
    expect(ran).toBe(true);
  });

  it('does not overlap tasks (test 33)', async () => {
    const q = new WriteQueue();
    let concurrent = 0;
    let maxConcurrent = 0;
    const tasks = Array(20).fill(0).map(() =>
      q.run(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise<void>((r) => {
          const t = setTimeout(r, 1);
          t.unref?.();
        });
        concurrent--;
      }),
    );
    await Promise.all(tasks);
    expect(maxConcurrent).toBe(1);
  });

  it('drain resolves after all pending tasks settle including rejections (test 34)', async () => {
    const q = new WriteQueue();
    let completed = 0;
    q.run(async () => {
      await new Promise<void>((r) => { const t = setTimeout(r, 5); t.unref?.(); });
      completed++;
    }).catch(() => {});
    q.run(async () => {
      throw new Error('expected');
    }).catch(() => {});
    q.run(async () => {
      await new Promise<void>((r) => { const t = setTimeout(r, 5); t.unref?.(); });
      completed++;
    }).catch(() => {});
    await q.drain();
    expect(completed).toBe(2);
  });

  it('drain on idle queue resolves immediately (test 35)', async () => {
    const q = new WriteQueue();
    const start = Date.now();
    await q.drain();
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('close-barrier: run() after drain() rejects with ABORTED; drain() idempotent (test 35b)', async () => {
    const q = new WriteQueue();
    await q.drain();
    await expect(q.run(async () => 1)).rejects.toBeInstanceOf(LlmChatError);
    const err = await q.run(async () => 1).catch((e) => e);
    expect((err as LlmChatError).code).toBe(ErrorCode.ABORTED);
    // drain idempotent
    await q.drain();
    expect(q.isClosed).toBe(true);
  });
});
