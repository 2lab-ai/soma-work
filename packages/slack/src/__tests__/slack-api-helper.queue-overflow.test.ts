import { describe, expect, it, vi } from 'vitest';
import { SlackApiHelper } from '../slack-api-helper';

/**
 * Queue overflow is a DEFINITIVE rejection, and it has to say so.
 *
 * When the rate-limit queue is full the helper drops the oldest waiting request
 * and rejects it. That request provably never called `execute()`, so nothing
 * was ever sent to Slack — but the rejection used to be a bare `Error`, which a
 * caller cannot tell apart from a socket reset ("the message may exist").
 * `ThreadSurface` treats an unknown outcome as unresolvable and holds the panel
 * forever, so the drop is reported with the same evidence shape every other
 * definitive outcome uses: `data.error`.
 */

function neverResolves(): Promise<never> {
  return new Promise<never>(() => {});
}

describe('SlackApiHelper — a request dropped by the rate-limit queue', () => {
  it('rejects with data.error "queue_overflow" — proof that nothing was sent', async () => {
    const app = {
      client: {
        chat: {
          // The first request occupies the worker forever, so the queue fills.
          postMessage: vi.fn().mockImplementation(neverResolves),
        },
      },
    };
    const helper = new SlackApiHelper(app as any, { maxQueueSize: 1, minInterval: 0 });

    void helper.postMessage('C1', 'in flight');
    const dropped = helper.postMessage('C1', 'oldest waiting');
    const survivor = helper.postMessage('C1', 'newest waiting');

    await expect(dropped).rejects.toMatchObject({ data: { error: 'queue_overflow' } });
    await expect(dropped).rejects.toThrow('Queue overflow: dropped oldest request');

    // The survivor is still waiting — this says nothing about it.
    void survivor.catch(() => {});
  });
});
