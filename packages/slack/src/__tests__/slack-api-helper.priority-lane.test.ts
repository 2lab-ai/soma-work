import { describe, expect, it, vi } from 'vitest';
import { SlackApiHelper } from '../slack-api-helper';

/**
 * The queue-control reactions are a CONTROL, and a control that arrives after
 * the thing it controls is gone is not a control.
 *
 * Every Slack call in this helper shares ONE FIFO token-bucket queue, so during
 * a live turn a `reactions.add` used to wait behind 5–8 streaming `chat.update`
 * calls (measured 2026-09-21: `Rate limit: waiting for token
 * {"waitTime":334,"queueLength":7}`). By the time `ui_cancel` appeared on the
 * message the model had already consumed the item, and the user's click could
 * only be refused.
 *
 * The priority lane is the fix: a control reaction still spends a token and
 * still respects `minInterval` (Slack's limits are real), but it is inserted at
 * the FRONT of the queue instead of behind whatever the stream is doing.
 */

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('SlackApiHelper — the priority lane', () => {
  function harness() {
    const order: string[] = [];
    const blocker = deferred();
    let firstCall = true;
    const app = {
      client: {
        chat: {
          postMessage: vi.fn(async (payload: any) => {
            order.push(payload.text);
            // The first call occupies the worker until released, so everything
            // behind it is provably QUEUED rather than merely slow.
            if (firstCall) {
              firstCall = false;
              await blocker.promise;
            }
            return { ok: true, ts: '111.222' };
          }),
        },
        reactions: {
          add: vi.fn(async (payload: any) => {
            order.push(`+${payload.name}`);
            return { ok: true };
          }),
          remove: vi.fn(async (payload: any) => {
            order.push(`-${payload.name}`);
            return { ok: true };
          }),
        },
      },
    };
    const helper = new SlackApiHelper(app as any, { minInterval: 0 });
    return { order, blocker, helper };
  }

  it('runs a priority reaction before five ordinary calls that were queued first', async () => {
    const { order, blocker, helper } = harness();

    // Occupies the single worker; the bucket is being spent behind it.
    const inFlight = helper.postMessage('C1', 'blocker');
    const ordinary = [1, 2, 3, 4, 5].map((n) => helper.postMessage('C1', `update-${n}`));

    const control = helper.addReactionResult('C1', '111.222', 'ui_cancel', { priority: true });
    blocker.resolve();

    await expect(control).resolves.toEqual({ ok: true });
    await Promise.all([inFlight, ...ordinary]);

    // Queued last, ran first: every ordinary call stayed behind it.
    expect(order).toEqual(['blocker', '+ui_cancel', 'update-1', 'update-2', 'update-3', 'update-4', 'update-5']);
  });

  it('keeps FIFO order AMONG priority calls — a control set is painted in the order it was asked for', async () => {
    const { order, blocker, helper } = harness();

    const inFlight = helper.postMessage('C1', 'blocker');
    const ordinary = helper.postMessage('C1', 'update-1');

    const controls = [
      helper.addReactionResult('C1', '111.222', 'inbox_tray', { priority: true }),
      helper.addReactionResult('C1', '111.222', 'ui_send_now', { priority: true }),
      helper.removeReactionResult('C1', '111.222', 'warning', { priority: true }),
    ];
    blocker.resolve();
    await Promise.all(controls);
    await Promise.all([inFlight, ordinary]);

    expect(order).toEqual(['blocker', '+inbox_tray', '+ui_send_now', '-warning', 'update-1']);
  });

  it('is opt-in — a reaction with no priority still queues behind the stream', async () => {
    const { order, blocker, helper } = harness();

    const inFlight = helper.postMessage('C1', 'blocker');
    const ordinary = helper.postMessage('C1', 'update-1');
    const control = helper.addReactionResult('C1', '111.222', 'ui_cancel');
    blocker.resolve();
    await control;

    expect(order).toEqual(['blocker', 'update-1', '+ui_cancel']);
    await Promise.all([inFlight, ordinary]);
  });

  /**
   * Overflow drops the OLDEST waiting request. With a lane at the front of the
   * queue that would drop a control first — inverting the whole point — so the
   * drop looks for the oldest ordinary item instead.
   */
  it('drops an ordinary waiting call on overflow, not the control in front of it', async () => {
    const order: string[] = [];
    const blocker = deferred();
    let firstCall = true;
    const app = {
      client: {
        chat: {
          postMessage: vi.fn(async (payload: any) => {
            order.push(payload.text);
            if (firstCall) {
              firstCall = false;
              await blocker.promise;
            }
            return { ok: true, ts: '111.222' };
          }),
        },
        reactions: {
          add: vi.fn(async (payload: any) => {
            order.push(`+${payload.name}`);
            return { ok: true };
          }),
        },
      },
    };
    const helper = new SlackApiHelper(app as any, { minInterval: 0, maxQueueSize: 2 });

    const inFlight = helper.postMessage('C1', 'blocker');
    const control = helper.addReactionResult('C1', '111.222', 'ui_cancel', { priority: true });
    const dropped = helper.postMessage('C1', 'update-1');
    // Queue is now at capacity (control + update-1); this one evicts the oldest
    // ORDINARY waiter.
    const survivor = helper.postMessage('C1', 'update-2');

    await expect(dropped).rejects.toMatchObject({ data: { error: 'queue_overflow' } });
    blocker.resolve();
    await expect(control).resolves.toEqual({ ok: true });
    await Promise.all([inFlight, survivor]);

    expect(order).toEqual(['blocker', '+ui_cancel', 'update-2']);
  });
});
