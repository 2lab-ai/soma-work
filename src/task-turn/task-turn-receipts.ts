/**
 * A task turn's work-log receipts (#598 ④b, design 598b v5 §4.3).
 *
 * Every append the turn makes is tracked under its binding. A rejection is
 * kept even after the promise settles, the drain is bounded (a hung append is
 * a failure, not a wait forever), and turns never share a collector.
 * `flushWorkLog()` is not used: its queue rejections resolve.
 */
import type { TaskTurnBinding } from '@soma/slack/task-turn/task-say';
import type { TaskTurnReceipts } from './task-turn-runner';

const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;

interface Collector {
  pending: Promise<void>[];
  failure?: string;
}

export interface TaskTurnReceiptTracker extends TaskTurnReceipts {
  track(binding: TaskTurnBinding, append: Promise<unknown>): void;
}

export function createTaskTurnReceipts(opts: { drainTimeoutMs?: number } = {}): TaskTurnReceiptTracker {
  const timeoutMs = opts.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const collectors = new WeakMap<TaskTurnBinding, Collector>();

  return {
    open(binding) {
      collectors.set(binding, { pending: [] });
    },
    track(binding, append) {
      const c = collectors.get(binding);
      if (!c) return;
      c.pending.push(
        append.then(
          () => undefined,
          (err) => {
            c.failure ??= (err as Error)?.message ?? String(err);
          },
        ),
      );
    },
    async drain(binding) {
      const c = collectors.get(binding);
      if (!c) return undefined;
      collectors.delete(binding);
      let timer: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        Promise.all(c.pending).then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), timeoutMs);
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (timedOut) c.failure ??= 'work log append timed out';
      return c.failure;
    },
  };
}
