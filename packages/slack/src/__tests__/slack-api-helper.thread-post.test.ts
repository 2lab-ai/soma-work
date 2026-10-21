import { describe, expect, it, vi } from 'vitest';
import { SlackApiHelper, type ThreadPostEvent } from '../slack-api-helper';

/**
 * Tail anchoring, part 1 — the CENTRAL notification that some other message
 * landed in a thread (2026-09-17 user feedback: "스레드 안에 항상 최하단에 이거
 * 출력해주고").
 *
 * The combined panel can only stay at the tail if it learns that something was
 * posted below it. Every bot message that goes through this helper carries that
 * fact already, so the hook lives HERE rather than in each sender — a
 * per-sender notification is exactly the arrangement that silently misses the
 * one sender someone adds next month.
 *
 * What is deliberately NOT notified: a top-level (non-threaded) post — it is
 * not in the panel's thread and cannot push it up; and `chat.update`, which
 * moves no message.
 */

const createFakeApp = (postResult?: unknown) => ({
  client: {
    chat: {
      postMessage: vi.fn().mockResolvedValue(postResult ?? { ts: '1700.000200', channel: 'C1' }),
      update: vi.fn().mockResolvedValue({ ok: true }),
    },
    reactions: { add: vi.fn().mockResolvedValue({ ok: true }) },
  },
});

function helperWithListener(app: ReturnType<typeof createFakeApp>): {
  helper: SlackApiHelper;
  events: ThreadPostEvent[];
} {
  const helper = new SlackApiHelper(app as any);
  const events: ThreadPostEvent[] = [];
  helper.onThreadPost = (event) => events.push(event);
  return { helper, events };
}

describe('SlackApiHelper — thread-post notification', () => {
  it('notifies after a successful threaded post, with the ts Slack returned', async () => {
    const app = createFakeApp();
    const { helper, events } = helperWithListener(app);

    await helper.postMessage('C1', 'hello', { threadTs: '1700.000000' });

    expect(events).toEqual([{ channel: 'C1', threadTs: '1700.000000', ts: '1700.000200', kind: 'post' }]);
  });

  it('does not notify for a top-level post — it is in no thread', async () => {
    const app = createFakeApp();
    const { helper, events } = helperWithListener(app);

    await helper.postMessage('C1', 'hello');

    expect(events).toHaveLength(0);
  });

  it('reports the thread Slack ACTUALLY used, not the one that was asked for', async () => {
    // A dead `thread_ts` is silently dropped by Slack and the message becomes a
    // channel post; the echoed message is the only witness of where it landed.
    const app = createFakeApp({ ts: '1700.000200', channel: 'C1', message: { thread_ts: '1700.000009' } });
    const { helper, events } = helperWithListener(app);

    await helper.postMessage('C1', 'hello', { threadTs: '1700.000000' });

    expect(events).toEqual([{ channel: 'C1', threadTs: '1700.000009', ts: '1700.000200', kind: 'post' }]);
  });

  it('notifies exactly once for a system message (it delegates to postMessage)', async () => {
    const app = createFakeApp();
    const { helper, events } = helperWithListener(app);

    await helper.postSystemMessage('C1', 'hello', { threadTs: '1700.000000' });

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('post');
  });

  it('never notifies when the post failed', async () => {
    const app = createFakeApp();
    app.client.chat.postMessage = vi.fn().mockRejectedValue(new Error('boom'));
    const { helper, events } = helperWithListener(app);

    await expect(helper.postMessage('C1', 'hello', { threadTs: '1700.000000' })).rejects.toThrow('boom');
    expect(events).toHaveLength(0);
  });

  it('delivers to registered listeners as well as the host hook, and survives a throwing one', async () => {
    const app = createFakeApp();
    const { helper, events } = helperWithListener(app);
    const seen: ThreadPostEvent[] = [];
    helper.addThreadPostListener(() => {
      throw new Error('listener exploded');
    });
    const unsubscribe = helper.addThreadPostListener((event) => seen.push(event));

    // A listener fault is the listener's problem: the post already happened and
    // must still be reported to everyone else (and must not fail the caller).
    await expect(helper.postMessage('C1', 'hello', { threadTs: '1700.000000' })).resolves.toBeDefined();
    expect(events).toHaveLength(1);
    expect(seen).toHaveLength(1);

    unsubscribe();
    await helper.postMessage('C1', 'again', { threadTs: '1700.000000' });
    expect(seen).toHaveLength(1);
  });

  it('lets a non-helper sender report its own thread message (TurnSurface streams)', async () => {
    const app = createFakeApp();
    const { helper, events } = helperWithListener(app);

    helper.notifyThreadPost({ channel: 'C1', threadTs: '1700.000000', ts: '1700.000300', kind: 'stream' });

    expect(events).toEqual([{ channel: 'C1', threadTs: '1700.000000', ts: '1700.000300', kind: 'stream' }]);
  });
});
