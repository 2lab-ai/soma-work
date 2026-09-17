import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SurfaceOutboxStore, threadPanelSurfaceKey } from '../surface-outbox-store';
import { type ConversationSession, ThreadSurface, type ThreadSurfaceDeps } from '../thread-surface';

/**
 * A24b — the combined panel's post path goes through a durable delivery intent.
 *
 * The hazard is the ack-before-persist window at `thread-surface.ts:867-873`:
 * the panel is posted and the returned `ts` lands in MEMORY ONLY, so a process
 * that dies in between has delivered a card it has no record of and the next
 * render posts a second one.
 *
 * These tests drive the REAL `SurfaceOutboxStore` against a temp file (the
 * ordering guarantee is the thing under test, and a fake store would let the
 * surface pass while the ordering is wrong) plus a fake Slack API that records
 * the exact calls. Crash/restart is modelled honestly: a NEW store instance
 * loading the same file, which is all a restart really is.
 *
 * Scope: this is the single combined panel only. TurnSurface / B5 are NOT
 * covered and no claim about them is made here.
 */

const KEY = 'C1:1700.000000';
const SURFACE_KEY = threadPanelSurfaceKey(KEY);

let dir: string;
let storePath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-outbox-'));
  storePath = path.join(dir, 'surface-outbox.json');
});

afterEach(() => {
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
    threadTs: '1700.000000',
    threadRootTs: '1700.000000',
    threadModel: 'user-initiated',
    ownerId: 'U1',
    ownerName: 'zhuge',
    title: 'outbox demo',
    isActive: true,
    terminated: false,
    actionPanel: { channelId: 'C1' },
    ...over,
  } as ConversationSession;
}

function makeSlackApi(overrides: { postMessage?: any; updateMessage?: any } = {}) {
  const posts: Array<{ channel: string; threadTs?: string }> = [];
  const updates: Array<{ channel: string; ts: string }> = [];
  return {
    posts,
    updates,
    getClient: vi.fn().mockReturnValue({}),
    getPermalink: vi.fn().mockResolvedValue('https://slack.example/p'),
    addReaction: vi.fn().mockResolvedValue(true),
    postMessage:
      overrides.postMessage ??
      vi.fn(async (channel: string, _text: string, options: any) => {
        posts.push({ channel, threadTs: options?.threadTs });
        return { ts: 'posted-ts-1' };
      }),
    updateMessage:
      overrides.updateMessage ??
      vi.fn(async (channel: string, ts: string) => {
        updates.push({ channel, ts });
      }),
  };
}

function makeDeps(
  session: ConversationSession,
  slackApi: ReturnType<typeof makeSlackApi>,
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

describe('ThreadSurface — A24b durable delivery intent for the combined panel', () => {
  it('commits the intent to disk BEFORE the Slack call, then records the ack', async () => {
    const session = makeSession();
    const store = loadedStore();
    let onDiskAtPostTime: string | undefined;

    const slackApi = makeSlackApi({
      postMessage: vi.fn(async () => {
        // Read the FILE, not memory: this is what a crash right here would leave.
        const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
        onDiskAtPostTime = raw.records[0]?.state;
        return { ts: 'posted-ts-1' };
      }),
    });

    const surface = new ThreadSurface(makeDeps(session, slackApi, store));
    await surface.updatePanel(session, KEY);

    expect(onDiskAtPostTime).toBe('pending');

    const record = loadedStore().get(SURFACE_KEY);
    expect(record?.state).toBe('sent');
    expect(record?.messageTs).toBe('posted-ts-1');
    expect(session.actionPanel?.messageTs).toBe('posted-ts-1');
  });

  it('after a restart, adopts the stored ts and UPDATES instead of posting again', async () => {
    const first = makeSession();
    const slackApi1 = makeSlackApi();
    await new ThreadSurface(makeDeps(first, slackApi1, loadedStore())).updatePanel(first, KEY);
    expect(slackApi1.posts).toHaveLength(1);

    // Restart: fresh session object (memory lost), fresh store reading the file.
    const revived = makeSession();
    const slackApi2 = makeSlackApi();
    await new ThreadSurface(makeDeps(revived, slackApi2, loadedStore())).updatePanel(revived, KEY);

    expect(slackApi2.posts).toHaveLength(0);
    expect(slackApi2.updates).toEqual([{ channel: 'C1', ts: 'posted-ts-1' }]);
    expect(revived.actionPanel?.messageTs).toBe('posted-ts-1');
  });

  it('leaves an ambiguous post pending and never reposts it, warning once instead', async () => {
    const session = makeSession();
    const slackApi = makeSlackApi({
      // Not a definitive rejection — the card may well have been created.
      postMessage: vi.fn().mockRejectedValue(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })),
    });

    await new ThreadSurface(makeDeps(session, slackApi, loadedStore())).updatePanel(session, KEY);
    expect(loadedStore().get(SURFACE_KEY)?.state).toBe('pending');

    // Restart: the surviving pending record means "unknown", never "not posted".
    const revived = makeSession();
    const slackApi2 = makeSlackApi();
    const surface2 = new ThreadSurface(makeDeps(revived, slackApi2, loadedStore()));
    await surface2.updatePanel(revived, KEY);
    await surface2.updatePanel(revived, KEY);

    expect(slackApi2.posts).toHaveLength(0);
    expect(slackApi2.updates).toHaveLength(0);
    expect(slackApi2.addReaction).toHaveBeenCalledTimes(1);
    expect(slackApi2.addReaction).toHaveBeenCalledWith('C1', '1700.000000', 'warning');
  });

  it('does not post again when persisting the ack fails (the card is already out there)', async () => {
    const session = makeSession();
    const real = loadedStore();
    // The store's own persist failure is its unit's concern; what this asserts
    // is the SURFACE's reaction to markSent throwing: the record stays pending,
    // so nothing may repost.
    const failingAck: ThreadSurfaceDeps['surfaceOutbox'] = {
      get: (key) => real.get(key),
      beginPost: (address) => real.beginPost(address),
      markSent: () => {
        throw new Error('disk full');
      },
      markRejected: (key, intentId, code) => real.markRejected(key, intentId, code),
      markDeleted: (key, intentId, messageTs) => real.markDeleted(key, intentId, messageTs),
      get recoveryWarning() {
        return real.recoveryWarning;
      },
    };

    const slackApi = makeSlackApi();
    await new ThreadSurface(makeDeps(session, slackApi, failingAck)).updatePanel(session, KEY);

    expect(slackApi.posts).toHaveLength(1);
    expect(loadedStore().get(SURFACE_KEY)?.state).toBe('pending');
    // The ts never reached memory either, so nothing claims a card it cannot prove.
    expect(session.actionPanel?.messageTs).toBeUndefined();

    const slackApi2 = makeSlackApi();
    await new ThreadSurface(makeDeps(makeSession(), slackApi2, loadedStore())).updatePanel(makeSession(), KEY);
    expect(slackApi2.posts).toHaveLength(0);
  });

  it('releases the surface for a fresh intent after a DEFINITIVE Slack rejection', async () => {
    const session = makeSession();
    const slackApi = makeSlackApi({
      postMessage: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('nope'), { data: { error: 'channel_not_found' } })),
    });

    await new ThreadSurface(makeDeps(session, slackApi, loadedStore())).updatePanel(session, KEY);

    const rejected = loadedStore().get(SURFACE_KEY);
    expect(rejected?.state).toBe('rejected');
    expect(rejected?.reason).toBe('channel_not_found');

    // A rejection is the one outcome that re-authorises a post, with a NEW intent.
    const retrySession = makeSession();
    const slackApi2 = makeSlackApi();
    await new ThreadSurface(makeDeps(retrySession, slackApi2, loadedStore())).updatePanel(retrySession, KEY);

    expect(slackApi2.posts).toHaveLength(1);
    const sent = loadedStore().get(SURFACE_KEY);
    expect(sent?.state).toBe('sent');
    expect(sent?.intentId).not.toBe(rejected?.intentId);
  });

  /**
   * A request the helper's own rate-limit queue dropped never reached
   * `execute()` (`slack-api-helper.ts:361-368`), so it is proof that no card
   * exists — the same class of evidence as `channel_not_found`, and the only
   * reason it needs saying is that a held panel is invisible to the user.
   */
  it('treats a queue-overflow drop as definitive and posts again on the next render', async () => {
    const session = makeSession();
    const slackApi = makeSlackApi({
      postMessage: vi.fn().mockRejectedValue(
        Object.assign(new Error('Queue overflow: dropped oldest request'), {
          data: { error: 'queue_overflow' },
        }),
      ),
    });

    await new ThreadSurface(makeDeps(session, slackApi, loadedStore())).updatePanel(session, KEY);
    expect(loadedStore().get(SURFACE_KEY)).toMatchObject({ state: 'rejected', reason: 'queue_overflow' });

    const retrySession = makeSession();
    const slackApi2 = makeSlackApi();
    await new ThreadSurface(makeDeps(retrySession, slackApi2, loadedStore())).updatePanel(retrySession, KEY);

    expect(slackApi2.posts).toHaveLength(1);
    expect(loadedStore().get(SURFACE_KEY)).toMatchObject({ state: 'sent', messageTs: 'posted-ts-1' });
  });

  it('never treats a rate limit or an unknown failure as a rejection', async () => {
    const session = makeSession();
    const slackApi = makeSlackApi({
      postMessage: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('ratelimited'), { data: { error: 'ratelimited' } })),
    });

    await new ThreadSurface(makeDeps(session, slackApi, loadedStore())).updatePanel(session, KEY);
    expect(loadedStore().get(SURFACE_KEY)?.state).toBe('pending');
  });

  it('blocks minting while the state came from a backup generation', async () => {
    // Healthy backup + corrupt live file = the loader falls back a generation,
    // so "no record for this key" no longer proves the card was never posted.
    fs.writeFileSync(`${storePath}.bak`, JSON.stringify({ version: 1, records: [] }));
    fs.writeFileSync(storePath, '{ not json');

    const store = new SurfaceOutboxStore({ path: storePath, warn: () => {} });
    store.load();
    expect(store.recoveryWarning).toBeDefined();

    const session = makeSession();
    const slackApi = makeSlackApi();
    await new ThreadSurface(makeDeps(session, slackApi, store)).updatePanel(session, KEY);

    expect(slackApi.posts).toHaveLength(0);
    expect(slackApi.updates).toHaveLength(0);
    expect(slackApi.addReaction).toHaveBeenCalledWith('C1', '1700.000000', 'warning');
  });

  it('fails closed when the stored address differs from the one being rendered', async () => {
    const session = makeSession();
    await new ThreadSurface(makeDeps(session, makeSlackApi(), loadedStore())).updatePanel(session, KEY);

    // Same session key, different channel — a `ts` is only meaningful with its
    // channel, so updating with it would 404 or edit an unrelated message.
    const moved = makeSession({ channelId: 'C-OTHER', actionPanel: { channelId: 'C-OTHER' } });
    const slackApi2 = makeSlackApi();
    await new ThreadSurface(makeDeps(moved, slackApi2, loadedStore())).updatePanel(moved, KEY);

    expect(slackApi2.posts).toHaveLength(0);
    expect(slackApi2.updates).toHaveLength(0);
  });

  /** A 404 from `chat.update`, the only shape the surface is allowed to act on. */
  function messageNotFound(): Error {
    return Object.assign(new Error('gone'), { data: { error: 'message_not_found' } });
  }

  /**
   * The delivered card is deleted in Slack afterwards. `chat.update` then
   * answers `message_not_found` on a ts the durable record still calls `sent` —
   * a state `markRejected` refuses — so before A24c the surface cleared its
   * in-memory ts, re-entered the post branch, was handed the SAME dead ts back
   * by `beginPost`, and looped on the vanished message until a human stepped in.
   */
  it('recovers from a dead panel ts with exactly ONE new message, in the same render', async () => {
    const first = makeSession();
    await new ThreadSurface(makeDeps(first, makeSlackApi(), loadedStore())).updatePanel(first, KEY);
    const original = loadedStore().get(SURFACE_KEY);
    expect(original).toMatchObject({ state: 'sent', messageTs: 'posted-ts-1' });

    const revived = makeSession({ actionPanel: { channelId: 'C1', messageTs: 'posted-ts-1' } });
    const updateMessage = vi.fn(async () => {
      throw messageNotFound();
    });
    const postMessage = vi.fn(async () => ({ ts: 'posted-ts-2' }));
    const slackApi = makeSlackApi({ updateMessage, postMessage });

    await new ThreadSurface(makeDeps(revived, slackApi, loadedStore())).updatePanel(revived, KEY);

    // One dead update, one replacement card — not a second render, not a loop.
    expect(updateMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledTimes(1);
    const record = loadedStore().get(SURFACE_KEY);
    expect(record).toMatchObject({ state: 'sent', messageTs: 'posted-ts-2' });
    // A NEW intent: a late ack for the dead one can never repoint the surface.
    expect(record?.intentId).not.toBe(original?.intentId);
    expect(revived.actionPanel?.messageTs).toBe('posted-ts-2');
    expect(slackApi.addReaction).not.toHaveBeenCalled();
  });

  it('does not record a deletion when the 404 names a ts the record does not hold', async () => {
    const first = makeSession();
    await new ThreadSurface(makeDeps(first, makeSlackApi(), loadedStore())).updatePanel(first, KEY);

    const store = loadedStore();
    const markDeleted = vi.spyOn(store, 'markDeleted');
    // Memory points somewhere else (a stale copy, a wrong ts): the 404 is
    // evidence about THAT message, and acting on it would discard the address
    // of a card that is still in the thread.
    const revived = makeSession({ actionPanel: { channelId: 'C1', messageTs: 'other-ts' } });
    const updated: string[] = [];
    const updateMessage = vi.fn(async (_channel: string, ts: string) => {
      updated.push(ts);
      if (ts === 'other-ts') throw messageNotFound();
    });
    const postMessage = vi.fn(async () => ({ ts: 'posted-ts-2' }));
    const slackApi = makeSlackApi({ updateMessage, postMessage });

    await new ThreadSurface(makeDeps(revived, slackApi, store)).updatePanel(revived, KEY);

    expect(markDeleted).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
    // The stored card is still the surface: it is adopted and updated in place.
    expect(updated).toEqual(['other-ts', 'posted-ts-1']);
    expect(loadedStore().get(SURFACE_KEY)).toMatchObject({ state: 'sent', messageTs: 'posted-ts-1' });
    expect(revived.actionPanel?.messageTs).toBe('posted-ts-1');
  });

  it('records the loss but holds the re-mint when the 404 lands under a backup-generation quarantine', async () => {
    fs.writeFileSync(
      `${storePath}.bak`,
      JSON.stringify({
        version: 1,
        records: [
          {
            surfaceKey: SURFACE_KEY,
            sessionKey: KEY,
            channelId: 'C1',
            threadTs: '1700.000000',
            intentId: 'intent-1',
            state: 'sent',
            messageTs: 'posted-ts-1',
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000,
          },
        ],
      }),
    );
    fs.writeFileSync(storePath, '{ not json');
    const store = new SurfaceOutboxStore({ path: storePath, warn: () => {} });
    store.load();
    expect(store.recoveryWarning).toBeDefined();

    const session = makeSession({ actionPanel: { channelId: 'C1', messageTs: 'posted-ts-1' } });
    const updateMessage = vi.fn(async () => {
      throw messageNotFound();
    });
    const postMessage = vi.fn(async () => ({ ts: 'posted-ts-2' }));
    const slackApi = makeSlackApi({ updateMessage, postMessage });

    await new ThreadSurface(makeDeps(session, slackApi, store)).updatePanel(session, KEY);

    // The loss is recorded — it only ever removes an address …
    expect(store.get(SURFACE_KEY)).toMatchObject({ state: 'rejected', reason: 'message_not_found' });
    // … but the quarantine still owns the mint: no replacement card, panel held.
    expect(postMessage).not.toHaveBeenCalled();
    expect(slackApi.addReaction).toHaveBeenCalledWith('C1', '1700.000000', 'warning');
    expect(session.actionPanel?.messageTs).toBeUndefined();
  });

  it('leaves the ordinary update path untouched — a known ts never consults the outbox', async () => {
    const session = makeSession({ actionPanel: { channelId: 'C1', messageTs: 'known-ts' } });
    const store = loadedStore();
    const beginPost = vi.spyOn(store, 'beginPost');
    const slackApi = makeSlackApi();

    await new ThreadSurface(makeDeps(session, slackApi, store)).updatePanel(session, KEY);

    expect(slackApi.updates).toEqual([{ channel: 'C1', ts: 'known-ts' }]);
    expect(slackApi.posts).toHaveLength(0);
    expect(beginPost).not.toHaveBeenCalled();
  });

  it('keeps legacy behaviour when no outbox is injected', async () => {
    const session = makeSession();
    const slackApi = makeSlackApi();

    await new ThreadSurface(makeDeps(session, slackApi, undefined)).updatePanel(session, KEY);

    expect(slackApi.posts).toHaveLength(1);
    expect(session.actionPanel?.messageTs).toBe('posted-ts-1');
  });

  it('persists the session only after the ts is confirmed', async () => {
    const session = makeSession();
    const persistAndBroadcast = vi.fn();
    const slackApi = makeSlackApi();

    await new ThreadSurface(
      makeDeps(session, slackApi, loadedStore(), { sessionRegistry: { persistAndBroadcast } }),
    ).updatePanel(session, KEY);

    expect(persistAndBroadcast).toHaveBeenCalledWith(KEY);
    expect(session.actionPanel?.messageTs).toBe('posted-ts-1');
  });
});
