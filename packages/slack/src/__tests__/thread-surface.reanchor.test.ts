import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThreadPostEvent } from '../slack-api-helper';
import { SurfaceOutboxStore, threadPanelSurfaceKey } from '../surface-outbox-store';
import { type ConversationSession, ThreadSurface, type ThreadSurfaceDeps } from '../thread-surface';

/**
 * Tail anchoring, part 2 — the combined panel must be the LAST message in its
 * thread (2026-09-17 user feedback on the live panel: "스레드 안에 항상 최하단에
 * 이거 출력해주고").
 *
 * Slack cannot move a message, so "stay at the tail" can only mean: delete the
 * card and post it again below whatever arrived. That is a destructive edit on
 * the one message the surface owns, so the interesting assertions here are all
 * about NOT doing it twice and NOT doing it to the wrong message:
 *
 *   - the panel's own post must never re-anchor the panel (else: infinite loop);
 *   - a burst of thread posts is one re-anchor, not one per post;
 *   - a crash between the delete and the post leaves a released record, so the
 *     next render posts exactly ONE replacement (A24 crash-safety, unchanged);
 *   - a failed delete posts nothing — two panels is worse than a stale one.
 *
 * The outbox is the REAL `SurfaceOutboxStore` against a temp file: the record
 * transition `sent(old) → released → sent(new)` is the thing under test, and a
 * fake store would let the surface pass while the ordering is wrong.
 */

const KEY = 'C1:1700.000000';
const SURFACE_KEY = threadPanelSurfaceKey(KEY);
const THREAD_TS = '1700.000000';
/** ~700ms debounce + the ~3s per-session rate limit, as the surface applies them. */
const DEBOUNCE_MS = 700;
const MIN_INTERVAL_MS = 3000;

let dir: string;
let storePath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-reanchor-'));
  storePath = path.join(dir, 'surface-outbox.json');
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

function loadedStore(): SurfaceOutboxStore {
  const store = new SurfaceOutboxStore({ path: storePath, warn: () => {} });
  store.load();
  return store;
}

function makeSession(over: Partial<ConversationSession> = {}): ConversationSession {
  return {
    sessionId: 'sess-1',
    channelId: 'C1',
    threadTs: THREAD_TS,
    threadRootTs: THREAD_TS,
    threadModel: 'user-initiated',
    ownerId: 'U1',
    ownerName: 'zhuge',
    title: 'tail demo',
    isActive: true,
    terminated: false,
    actionPanel: { channelId: 'C1' },
    ...over,
  } as ConversationSession;
}

/**
 * Slack double that behaves like `SlackApiHelper` in the one respect this test
 * depends on: a threaded post notifies the registered listeners (proved for the
 * real helper in `slack-api-helper.thread-post.test.ts`). That is what makes
 * "the panel's own post must not re-anchor it" a real assertion rather than a
 * stipulation.
 */
function makeSlackApi(
  overrides: { postMessage?: any; updateMessage?: any; deleteMessage?: any } = {},
): Record<string, any> {
  const posts: Array<{ channel: string; threadTs?: string; ts: string }> = [];
  const updates: Array<{ channel: string; ts: string }> = [];
  const deletes: Array<{ channel: string; ts: string }> = [];
  const listeners = new Set<(event: ThreadPostEvent) => void>();
  let seq = 0;

  const notify = (event: ThreadPostEvent) => {
    for (const listener of [...listeners]) listener(event);
  };

  const api: Record<string, any> = {
    posts,
    updates,
    deletes,
    notify,
    getClient: vi.fn().mockReturnValue({}),
    getPermalink: vi.fn().mockResolvedValue('https://slack.example/p'),
    addReaction: vi.fn().mockResolvedValue(true),
    addThreadPostListener: (listener: (event: ThreadPostEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notifyThreadPost: notify,
    postMessage:
      overrides.postMessage ??
      vi.fn(async (channel: string, _text: string, options: any) => {
        seq += 1;
        const ts = `1700.00010${seq}`;
        posts.push({ channel, threadTs: options?.threadTs, ts });
        if (options?.threadTs) notify({ channel, threadTs: options.threadTs, ts, kind: 'post' });
        return { ts };
      }),
    updateMessage:
      overrides.updateMessage ??
      vi.fn(async (channel: string, ts: string) => {
        updates.push({ channel, ts });
      }),
    deleteMessage:
      overrides.deleteMessage ??
      vi.fn(async (channel: string, ts: string) => {
        deletes.push({ channel, ts });
      }),
  };
  return api;
}

function makeDeps(
  session: ConversationSession,
  slackApi: Record<string, any>,
  surfaceOutbox?: ThreadSurfaceDeps['surfaceOutbox'],
  extra: Partial<ThreadSurfaceDeps> = {},
): ThreadSurfaceDeps {
  return {
    slackApi: slackApi as any,
    claudeHandler: { getSessionByKey: vi.fn().mockReturnValue(session) } as any,
    requestCoordinator: { isRequestActive: vi.fn().mockReturnValue(false) } as any,
    todoManager: { getTodos: vi.fn().mockReturnValue([]), getEffectiveStatus: vi.fn() } as any,
    surfaceOutbox,
    ...extra,
  };
}

/** A message from somebody else landing under the panel. */
function foreignPost(slackApi: Record<string, any>, ts: string, kind: 'post' | 'stream' = 'post'): void {
  slackApi.notify({ channel: 'C1', threadTs: THREAD_TS, ts, kind });
}

/** Let the debounce fire and the async re-anchor settle. */
async function settle(ms = DEBOUNCE_MS): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await vi.advanceTimersByTimeAsync(0);
}

describe('ThreadSurface — the panel re-anchors to the tail of its thread', () => {
  it('deletes the old card and posts a fresh one below the newest thread message', async () => {
    const session = makeSession();
    const slackApi = makeSlackApi();
    const surface = new ThreadSurface(makeDeps(session, slackApi, loadedStore()));

    await surface.updatePanel(session, KEY);
    const firstTs = session.actionPanel?.messageTs;
    expect(firstTs).toBe('1700.000101');
    expect(loadedStore().get(SURFACE_KEY)).toMatchObject({ state: 'sent', messageTs: firstTs });

    foreignPost(slackApi, '1700.000500');
    await settle();

    expect(slackApi.deletes).toEqual([{ channel: 'C1', ts: firstTs }]);
    expect(slackApi.posts).toHaveLength(2);
    // The replacement is posted into the same thread, i.e. at its tail.
    expect(slackApi.posts[1]).toMatchObject({ channel: 'C1', threadTs: THREAD_TS });
    expect(session.actionPanel?.messageTs).toBe(slackApi.posts[1].ts);

    // sent(old) → released by the observed deletion → sent(new), under a NEW
    // intent, so a late ack for the dead card can never repoint the surface.
    const record = loadedStore().get(SURFACE_KEY);
    expect(record).toMatchObject({ state: 'sent', messageTs: slackApi.posts[1].ts });
    expect(record?.intentId).not.toBe('');
    expect(record?.messageTs).not.toBe(firstTs);
  });

  it('never re-anchors on its OWN post — otherwise the panel deletes itself forever', async () => {
    const session = makeSession();
    const slackApi = makeSlackApi();
    const surface = new ThreadSurface(makeDeps(session, slackApi, loadedStore()));

    // The fake notifies on every threaded post, including the panel's own.
    await surface.updatePanel(session, KEY);
    await settle(MIN_INTERVAL_MS * 2);

    expect(slackApi.deletes).toHaveLength(0);
    expect(slackApi.posts).toHaveLength(1);
  });

  it('coalesces a burst of thread posts into ONE re-anchor', async () => {
    const session = makeSession();
    const slackApi = makeSlackApi();
    const surface = new ThreadSurface(makeDeps(session, slackApi, loadedStore()));
    await surface.updatePanel(session, KEY);

    foreignPost(slackApi, '1700.000500');
    foreignPost(slackApi, '1700.000501', 'stream');
    foreignPost(slackApi, '1700.000502');
    await settle();

    expect(slackApi.deletes).toHaveLength(1);
    expect(slackApi.posts).toHaveLength(2);
  });

  it('holds the next re-anchor to one per ~3s per session', async () => {
    const session = makeSession();
    const slackApi = makeSlackApi();
    const surface = new ThreadSurface(makeDeps(session, slackApi, loadedStore()));
    await surface.updatePanel(session, KEY);

    foreignPost(slackApi, '1700.000500');
    await settle();
    expect(slackApi.deletes).toHaveLength(1);

    // A second message arrives right after the first re-anchor.
    foreignPost(slackApi, '1700.000600');
    await settle();
    expect(slackApi.deletes).toHaveLength(1);

    // …and lands once the rate-limit window has passed, not before.
    await settle(MIN_INTERVAL_MS);
    expect(slackApi.deletes).toHaveLength(2);
  });

  it('does not re-anchor when the newest thread message is older than the panel', async () => {
    const session = makeSession();
    const slackApi = makeSlackApi();
    const surface = new ThreadSurface(makeDeps(session, slackApi, loadedStore()));
    await surface.updatePanel(session, KEY);

    // A late notification about a message that is already above the panel.
    foreignPost(slackApi, '1700.000001');
    await settle();

    expect(slackApi.deletes).toHaveLength(0);
  });

  it('refuses to delete a panel that IS the thread root', async () => {
    // bot-initiated threads: the root message is the surface. Deleting it
    // deletes the whole conversation, which no layout preference can justify.
    const session = makeSession({
      threadModel: 'bot-initiated',
      actionPanel: { channelId: 'C1', messageTs: THREAD_TS },
    });
    const slackApi = makeSlackApi();
    const surface = new ThreadSurface(makeDeps(session, slackApi, loadedStore()));
    await surface.updatePanel(session, KEY);

    foreignPost(slackApi, '1700.000500');
    await settle();

    expect(slackApi.deletes).toHaveLength(0);
    expect(session.actionPanel?.messageTs).toBe(THREAD_TS);
  });

  it('posts nothing when the delete fails — a stale panel beats two panels', async () => {
    const session = makeSession();
    const slackApi = makeSlackApi({
      deleteMessage: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('nope'), { data: { error: 'cant_delete_message' } })),
    });
    const surface = new ThreadSurface(makeDeps(session, slackApi, loadedStore()));
    await surface.updatePanel(session, KEY);
    const firstTs = session.actionPanel?.messageTs;

    foreignPost(slackApi, '1700.000500');
    await settle();

    expect(slackApi.posts).toHaveLength(1);
    expect(session.actionPanel?.messageTs).toBe(firstTs);
    expect(loadedStore().get(SURFACE_KEY)).toMatchObject({ state: 'sent', messageTs: firstTs });
  });

  /**
   * The crash window is between the observed deletion and the replacement post.
   * Modelled the way the A24b suite models a crash — by what it leaves on DISK:
   * `beginPost` throwing is the process dying at that instant, and the restart
   * is a NEW store reading the same file. The record must then be released, so
   * the next render mints a fresh intent and posts exactly one card.
   */
  it('survives a crash between the delete and the post with exactly one panel', async () => {
    const session = makeSession();
    const slackApi = makeSlackApi();
    const real = loadedStore();

    let crash = false;
    const dyingOutbox: ThreadSurfaceDeps['surfaceOutbox'] = {
      get: (key) => real.get(key),
      beginPost: (address) => {
        if (crash) throw new Error('process died before the replacement post');
        return real.beginPost(address);
      },
      markSent: (key, intentId, ts) => real.markSent(key, intentId, ts),
      markRejected: (key, intentId, code) => real.markRejected(key, intentId, code),
      markDeleted: (key, intentId, ts) => real.markDeleted(key, intentId, ts),
      get recoveryWarning() {
        return real.recoveryWarning;
      },
    };
    const crashing = new ThreadSurface(makeDeps(session, slackApi, dyingOutbox));
    await crashing.updatePanel(session, KEY);
    const firstTs = session.actionPanel?.messageTs;

    crash = true;
    foreignPost(slackApi, '1700.000500');
    await settle();

    expect(slackApi.deletes).toEqual([{ channel: 'C1', ts: firstTs }]);
    expect(slackApi.posts).toHaveLength(1); // the original only — the replacement never happened
    expect(loadedStore().get(SURFACE_KEY)).toMatchObject({ state: 'rejected', reason: 'message_not_found' });

    // Restart: the dead process stops listening, session memory is gone, and a
    // fresh store reads the file the crash left behind.
    crashing.dispose();
    const revived = makeSession();
    const slackApi2 = makeSlackApi();
    await new ThreadSurface(makeDeps(revived, slackApi2, loadedStore())).updatePanel(revived, KEY);

    expect(slackApi2.posts).toHaveLength(1);
    expect(slackApi2.updates).toHaveLength(0);
    expect(loadedStore().get(SURFACE_KEY)).toMatchObject({ state: 'sent', messageTs: slackApi2.posts[0].ts });
  });

  it('leaves a closed panel where it is — the closed card is history, not a control', async () => {
    const session = makeSession();
    const slackApi = makeSlackApi();
    const surface = new ThreadSurface(makeDeps(session, slackApi, loadedStore()));
    await surface.updatePanel(session, KEY);

    session.isActive = false;
    session.terminated = true;
    foreignPost(slackApi, '1700.000500');
    await settle();

    expect(slackApi.deletes).toHaveLength(0);
  });

  it('keeps working without an outbox (legacy hosts)', async () => {
    const session = makeSession();
    const slackApi = makeSlackApi();
    const surface = new ThreadSurface(makeDeps(session, slackApi, undefined));
    await surface.updatePanel(session, KEY);
    const firstTs = session.actionPanel?.messageTs;

    foreignPost(slackApi, '1700.000500');
    await settle();

    expect(slackApi.deletes).toEqual([{ channel: 'C1', ts: firstTs }]);
    expect(slackApi.posts).toHaveLength(2);
    expect(session.actionPanel?.messageTs).toBe(slackApi.posts[1].ts);
  });

  it('ignores thread posts addressed to a different thread', async () => {
    const session = makeSession();
    const slackApi = makeSlackApi();
    const surface = new ThreadSurface(makeDeps(session, slackApi, loadedStore()));
    await surface.updatePanel(session, KEY);

    slackApi.notify({ channel: 'C1', threadTs: '1700.999999', ts: '1700.000500', kind: 'post' });
    slackApi.notify({ channel: 'C-OTHER', threadTs: THREAD_TS, ts: '1700.000501', kind: 'post' });
    await settle();

    expect(slackApi.deletes).toHaveLength(0);
  });
});
