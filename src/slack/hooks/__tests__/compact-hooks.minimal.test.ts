/**
 * Spec 10 §3.2-4 — at `minimal` the compaction start/complete notices stay off
 * the thread (they reach the dashboard work log as `notice` entries, emitted by
 * stream-executor). Only the Slack calls are gated: the epoch markers, the
 * usage snapshot, `autoCompactPending`, `skipThresholdCheckOnce` and the
 * deferred re-dispatch all still happen, because the re-dispatch of a message
 * typed during compaction lives in these helpers.
 *
 * The other half of the contract: a "⏳ Compaction starting" message that DID
 * reach the thread is never left behind un-updated — not when the level drops
 * to minimal mid-cycle, and not when the cycle seals while the starting post
 * is still in flight.
 */

import type { PostCompactHookInput, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
import { getVerbosityFlags, LOG_MINIMAL } from '@soma/slack/output-flags';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../session/compaction-context-builder', () => ({
  buildCompactionContext: vi.fn().mockReturnValue('<compaction-context/>'),
  snapshotFromSession: vi.fn().mockReturnValue({}),
}));

import type { ConversationSession } from '../../../types';
import type { SlackApiHelper } from '../../slack-api-helper';
import {
  buildCompactHooks,
  COMPACT_END_WAIT_FOR_START_MS,
  COMPACT_ENDED_WITHOUT_SIGNAL_TEXT,
  closeCompactStartingAtTurnEnd,
  postCompactCompleteIfNeeded,
  postCompactStartingIfNeeded,
} from '../compact-hooks';

const COMPACT = getVerbosityFlags('compact');

function makeSession(logVerbosity: number | undefined, overrides: Partial<ConversationSession> = {}) {
  return {
    channelId: 'C1',
    threadTs: 'T1',
    compactionCount: 0,
    compactEpoch: 0,
    compactPostedByEpoch: {},
    compactionRehydratedByEpoch: {},
    preCompactUsagePct: null,
    lastKnownUsagePct: 80,
    compactPreTokens: null,
    compactPostTokens: null,
    compactTrigger: null,
    compactDurationMs: null,
    compactStartingMessageTs: null,
    compactStartedAtMs: null,
    compactTickInterval: undefined,
    autoCompactPending: true,
    pendingUserText: 'typed during compaction',
    pendingEventContext: { channel: 'C1', threadTs: 'T1', user: 'U1', ts: '1.1' },
    ...(logVerbosity === undefined ? {} : { logVerbosity }),
    ...overrides,
  } as ConversationSession;
}

function makeSlackApi() {
  return {
    postSystemMessage: vi.fn().mockResolvedValue({ ts: 'start_ts' }),
    updateMessage: vi.fn().mockResolvedValue(undefined),
  };
}

function deps(session: ConversationSession, slackApi: ReturnType<typeof makeSlackApi>) {
  return { session, channel: 'C1', threadTs: 'T1', slackApi: slackApi as unknown as SlackApiHelper };
}

const sessions: ConversationSession[] = [];
function track(session: ConversationSession): ConversationSession {
  sessions.push(session);
  return session;
}

afterEach(() => {
  for (const session of sessions.splice(0)) {
    if (session.compactTickInterval) clearInterval(session.compactTickInterval);
  }
  vi.useRealTimers();
});

/** Every bookkeeping effect of one full START → END cycle. */
function expectCycleSealed(session: ConversationSession): void {
  const epoch = session.compactEpoch ?? 0;
  expect(epoch).toBe(1);
  expect(session.compactPostedByEpoch?.[epoch]).toEqual({ pre: true, post: true });
  expect(session.compactionRehydratedByEpoch?.[epoch]).toBe(true);
  expect(session.autoCompactPending).toBe(false);
  expect(session.skipThresholdCheckOnce).toBe(true);
  // The message typed during compaction is queued for re-dispatch.
  expect(session.pendingUserText).toBeNull();
  expect(session.compactPendingDispatches).toEqual([
    { ctx: { channel: 'C1', threadTs: 'T1', user: 'U1', ts: '1.1' }, text: 'typed during compaction' },
  ]);
  expect(session.compactStartingMessageTs).toBeNull();
  expect(session.compactStartedAtMs).toBeNull();
  expect(session.compactTickInterval).toBeUndefined();
}

describe('compaction notices at minimal (spec 10 §3.2-4)', () => {
  it('minimal: START and END make no Slack call, and every side effect still happens', async () => {
    const session = track(makeSession(LOG_MINIMAL));
    const slackApi = makeSlackApi();

    await postCompactStartingIfNeeded(deps(session, slackApi), 'auto');
    expect(session.compactPostedByEpoch?.[1]).toEqual({ pre: true, post: false });
    // Usage snapshot for the "was ~X%" line still taken, heuristic invalidated.
    expect(session.preCompactUsagePct).toBe(80);
    expect(session.lastKnownUsagePct).toBeNull();
    expect(session.compactTickInterval).toBeUndefined();

    await postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' });

    expect(slackApi.postSystemMessage).not.toHaveBeenCalled();
    expect(slackApi.updateMessage).not.toHaveBeenCalled();
    expectCycleSealed(session);
    expect(session.compactCompletionMessageTs ?? null).toBeNull();
  });

  it('minimal: the SDK PreCompact / PostCompact hooks post nothing either', async () => {
    const session = track(makeSession(LOG_MINIMAL));
    const slackApi = makeSlackApi();
    const hooks = buildCompactHooks(deps(session, slackApi));

    await hooks.PreCompact({ hook_event_name: 'PreCompact', trigger: 'auto' } as unknown as PreCompactHookInput);
    await hooks.PostCompact({ hook_event_name: 'PostCompact', trigger: 'auto' } as unknown as PostCompactHookInput);

    expect(slackApi.postSystemMessage).not.toHaveBeenCalled();
    expect(slackApi.updateMessage).not.toHaveBeenCalled();
    expect(session.compactPostedByEpoch?.[1]).toEqual({ pre: true, post: true });
  });

  it.each([
    ['compact', COMPACT],
    ['no mask (legacy session → detail)', undefined],
  ])('%s: START posts, END replaces it in place (unchanged)', async (_label, mask) => {
    const session = track(makeSession(mask));
    const slackApi = makeSlackApi();

    await postCompactStartingIfNeeded(deps(session, slackApi), 'auto');
    expect(slackApi.postSystemMessage).toHaveBeenCalledTimes(1);
    expect(String(slackApi.postSystemMessage.mock.calls[0]?.[1])).toContain('Compaction starting');
    expect(session.compactTickInterval).toBeDefined();

    await postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' });

    expect(slackApi.postSystemMessage).toHaveBeenCalledTimes(1);
    expect(slackApi.updateMessage).toHaveBeenCalledWith(
      'C1',
      'start_ts',
      expect.stringContaining('Compaction completed'),
    );
    expectCycleSealed(session);
  });

  it('compact → minimal mid-cycle: the posted "starting" message is still replaced by "completed"', async () => {
    const session = track(makeSession(COMPACT));
    const slackApi = makeSlackApi();

    await postCompactStartingIfNeeded(deps(session, slackApi), 'auto');
    session.logVerbosity = LOG_MINIMAL;
    await postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' });

    expect(slackApi.postSystemMessage).toHaveBeenCalledTimes(1);
    expect(slackApi.updateMessage).toHaveBeenCalledWith(
      'C1',
      'start_ts',
      expect.stringContaining('Compaction completed'),
    );
    expectCycleSealed(session);
  });

  it('minimal → compact mid-cycle: no starting message to update, so the completion is posted fresh', async () => {
    const session = track(makeSession(LOG_MINIMAL));
    const slackApi = makeSlackApi();

    await postCompactStartingIfNeeded(deps(session, slackApi), 'auto');
    session.logVerbosity = COMPACT;
    await postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' });

    expect(slackApi.postSystemMessage).toHaveBeenCalledTimes(1);
    expect(String(slackApi.postSystemMessage.mock.calls[0]?.[1])).toContain('Compaction completed');
    expect(slackApi.updateMessage).not.toHaveBeenCalled();
    expectCycleSealed(session);
  });

  it('END while the starting post is still in flight: END waits for it and replaces it — no orphan, no ticker', async () => {
    const session = track(makeSession(COMPACT));
    const slackApi = makeSlackApi();
    let releaseStart!: (value: { ts: string }) => void;
    slackApi.postSystemMessage.mockImplementationOnce(
      () =>
        new Promise<{ ts: string }>((resolve) => {
          releaseStart = resolve;
        }),
    );

    const starting = postCompactStartingIfNeeded(deps(session, slackApi), 'auto');
    const completing = postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' });
    // Let END reach its wait on the in-flight post.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(slackApi.updateMessage).not.toHaveBeenCalled();

    releaseStart({ ts: 'late_start_ts' });
    await Promise.all([starting, completing]);

    expect(slackApi.postSystemMessage).toHaveBeenCalledTimes(1);
    expect(slackApi.updateMessage).toHaveBeenCalledTimes(1);
    expect(slackApi.updateMessage).toHaveBeenCalledWith(
      'C1',
      'late_start_ts',
      expect.stringContaining('Compaction completed'),
    );
    expectCycleSealed(session);
  });

  it('a starting post that fails while END waits: END still posts the completion (compact)', async () => {
    const session = track(makeSession(COMPACT));
    const slackApi = makeSlackApi();
    let failStart!: (err: Error) => void;
    slackApi.postSystemMessage.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failStart = reject;
        }),
    );

    const starting = postCompactStartingIfNeeded(deps(session, slackApi), 'auto');
    const completing = postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    failStart(new Error('rate_limited'));
    await Promise.all([starting, completing]);

    expect(slackApi.postSystemMessage).toHaveBeenCalledTimes(2);
    expect(String(slackApi.postSystemMessage.mock.calls[1]?.[1])).toContain('Compaction completed');
    expectCycleSealed(session);
  });
});

describe('turn end closes a "starting" message that never got an END', () => {
  it.each([
    ['compact', COMPACT],
    ['compact, then minimal before the turn ends', LOG_MINIMAL],
  ])('%s: the message is updated once and the ticker cleared', async (_label, maskAtTurnEnd) => {
    const session = track(makeSession(COMPACT));
    const slackApi = makeSlackApi();
    await postCompactStartingIfNeeded(deps(session, slackApi), 'auto');
    expect(session.compactTickInterval).toBeDefined();
    session.logVerbosity = maskAtTurnEnd;

    await closeCompactStartingAtTurnEnd(deps(session, slackApi));

    expect(slackApi.updateMessage).toHaveBeenCalledTimes(1);
    expect(slackApi.updateMessage).toHaveBeenCalledWith('C1', 'start_ts', COMPACT_ENDED_WITHOUT_SIGNAL_TEXT);
    expect(session.compactTickInterval).toBeUndefined();
    expect(session.compactStartingMessageTs).toBeNull();
    // Bookkeeping is the END path's: the cycle is not sealed here.
    expect(session.compactPostedByEpoch?.[1]).toEqual({ pre: true, post: false });

    await closeCompactStartingAtTurnEnd(deps(session, slackApi));
    expect(slackApi.updateMessage).toHaveBeenCalledTimes(1);
  });

  it('after a normal END there is nothing to close', async () => {
    const session = track(makeSession(COMPACT));
    const slackApi = makeSlackApi();
    await postCompactStartingIfNeeded(deps(session, slackApi), 'auto');
    await postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' });
    slackApi.updateMessage.mockClear();

    await closeCompactStartingAtTurnEnd(deps(session, slackApi));

    expect(slackApi.updateMessage).not.toHaveBeenCalled();
  });

  it('at minimal nothing was posted, so nothing is updated', async () => {
    const session = track(makeSession(LOG_MINIMAL));
    const slackApi = makeSlackApi();
    await postCompactStartingIfNeeded(deps(session, slackApi), 'auto');

    await closeCompactStartingAtTurnEnd(deps(session, slackApi));

    expect(slackApi.postSystemMessage).not.toHaveBeenCalled();
    expect(slackApi.updateMessage).not.toHaveBeenCalled();
  });

  it('a starting post still in flight at turn end is waited for, then closed — no ticker left', async () => {
    const session = track(makeSession(COMPACT));
    const slackApi = makeSlackApi();
    let releaseStart!: (value: { ts: string }) => void;
    slackApi.postSystemMessage.mockImplementationOnce(
      () =>
        new Promise<{ ts: string }>((resolve) => {
          releaseStart = resolve;
        }),
    );

    const starting = postCompactStartingIfNeeded(deps(session, slackApi), 'auto');
    const closing = closeCompactStartingAtTurnEnd(deps(session, slackApi));
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseStart({ ts: 'late_start_ts' });
    await Promise.all([starting, closing]);

    expect(slackApi.updateMessage).toHaveBeenCalledWith('C1', 'late_start_ts', COMPACT_ENDED_WITHOUT_SIGNAL_TEXT);
    expect(session.compactTickInterval).toBeUndefined();
  });
});

describe('END does not wait forever for an in-flight START', () => {
  it('waits at most the deadline: posts its own completion (compact), then replaces the late START when it lands', async () => {
    vi.useFakeTimers();
    const session = track(makeSession(COMPACT));
    const slackApi = makeSlackApi();
    let releaseStart!: (value: { ts: string }) => void;
    slackApi.postSystemMessage
      .mockImplementationOnce(
        () =>
          new Promise<{ ts: string }>((resolve) => {
            releaseStart = resolve;
          }),
      )
      .mockResolvedValueOnce({ ts: 'end_ts' });

    const starting = postCompactStartingIfNeeded(deps(session, slackApi), 'auto');
    const completing = postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' });
    await vi.advanceTimersByTimeAsync(COMPACT_END_WAIT_FOR_START_MS);
    await completing;

    // Deadline passed: END sealed the cycle and posted its own completion.
    expect(slackApi.postSystemMessage).toHaveBeenCalledTimes(2);
    expect(String(slackApi.postSystemMessage.mock.calls[1]?.[1])).toContain('Compaction completed');
    expectCycleSealed(session);

    // The late START lands: it is replaced at once — no ticker on a closed cycle.
    releaseStart({ ts: 'late_ts' });
    await starting;
    expect(slackApi.updateMessage).toHaveBeenCalledWith(
      'C1',
      'late_ts',
      expect.stringContaining('Compaction completed'),
    );
    expect(session.compactTickInterval).toBeUndefined();
  });

  it('minimal: nothing is in flight, so END never waits and posts nothing', async () => {
    const session = track(makeSession(LOG_MINIMAL));
    const slackApi = makeSlackApi();

    await postCompactStartingIfNeeded(deps(session, slackApi), 'auto');
    await postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' });

    expect(slackApi.postSystemMessage).not.toHaveBeenCalled();
    expectCycleSealed(session);
  });

  it('a START that fails at the transport after the deadline changes nothing', async () => {
    vi.useFakeTimers();
    const session = track(makeSession(COMPACT));
    const slackApi = makeSlackApi();
    let failStart!: (err: Error) => void;
    slackApi.postSystemMessage
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            failStart = reject;
          }),
      )
      .mockResolvedValueOnce({ ts: 'end_ts' });

    const starting = postCompactStartingIfNeeded(deps(session, slackApi), 'auto');
    const completing = postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' });
    await vi.advanceTimersByTimeAsync(COMPACT_END_WAIT_FOR_START_MS);
    await completing;
    failStart(new Error('socket hang up'));
    await starting;

    expect(slackApi.postSystemMessage).toHaveBeenCalledTimes(2);
    expect(slackApi.updateMessage).not.toHaveBeenCalled();
    expect(session.compactTickInterval).toBeUndefined();
    expectCycleSealed(session);
  });
});

describe('two END signals while START is in flight', () => {
  it('exactly one completion update — the second END claims nothing', async () => {
    const session = track(makeSession(COMPACT));
    const slackApi = makeSlackApi();
    let releaseStart!: (value: { ts: string }) => void;
    slackApi.postSystemMessage.mockImplementationOnce(
      () =>
        new Promise<{ ts: string }>((resolve) => {
          releaseStart = resolve;
        }),
    );

    const starting = postCompactStartingIfNeeded(deps(session, slackApi), 'auto');
    const boundary = postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' });
    const hook = postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseStart({ ts: 'start_ts' });
    await Promise.all([starting, boundary, hook]);

    expect(slackApi.postSystemMessage).toHaveBeenCalledTimes(1);
    expect(slackApi.updateMessage).toHaveBeenCalledTimes(1);
    expect(slackApi.updateMessage).toHaveBeenCalledWith(
      'C1',
      'start_ts',
      expect.stringContaining('Compaction completed'),
    );
    expectCycleSealed(session);
  });

  it('two ENDs with no START at all: one fresh completion post', async () => {
    const session = track(makeSession(COMPACT, { compactEpoch: 0 }));
    const slackApi = makeSlackApi();

    await Promise.all([
      postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' }),
      postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' }),
    ]);

    expect(slackApi.postSystemMessage).toHaveBeenCalledTimes(1);
    expect(String(slackApi.postSystemMessage.mock.calls[0]?.[1])).toContain('Compaction completed');
  });
});

/** First line of every chat.update, as `ts <- line`. */
function updates(slackApi: ReturnType<typeof makeSlackApi>): string[] {
  return slackApi.updateMessage.mock.calls.map((c) => `${c[1]} <- ${String(c[2]).split('\n')[0]}`);
}

describe('turn-end close never overwrites an END in progress (END owns the message)', () => {
  it('END is awaiting its chat.update when the turn ends: the message ends as completed', async () => {
    const session = track(makeSession(COMPACT));
    const slackApi = makeSlackApi();
    await postCompactStartingIfNeeded(deps(session, slackApi), 'auto');
    let releaseEndUpdate!: () => void;
    slackApi.updateMessage.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          releaseEndUpdate = () => resolve(undefined);
        }),
    );

    const end = postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const close = closeCompactStartingAtTurnEnd(deps(session, slackApi));
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseEndUpdate();
    await Promise.all([end, close]);

    expect(updates(slackApi)).toEqual(['start_ts <- 🟢 🗜️ Compaction completed']);
    expectCycleSealed(session);
  });

  it('START and END both in flight when the turn ends: one completion update, no ticker', async () => {
    const session = track(makeSession(COMPACT));
    const slackApi = makeSlackApi();
    let releaseStart!: (value: { ts: string }) => void;
    slackApi.postSystemMessage.mockImplementationOnce(
      () =>
        new Promise<{ ts: string }>((resolve) => {
          releaseStart = resolve;
        }),
    );

    const starting = postCompactStartingIfNeeded(deps(session, slackApi), 'auto');
    const end = postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const close = closeCompactStartingAtTurnEnd(deps(session, slackApi));
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseStart({ ts: 'start_ts' });
    await Promise.all([starting, end, close]);

    expect(updates(slackApi)).toEqual(['start_ts <- 🟢 🗜️ Compaction completed']);
    expect(session.compactTickInterval).toBeUndefined();
  });
});

describe('a START abandoned by END (past the deadline) never becomes an orphan', () => {
  it("lands while END's own completion post is pending: it replaces itself with the completion, starts no ticker", async () => {
    vi.useFakeTimers();
    const session = track(makeSession(COMPACT));
    const slackApi = makeSlackApi();
    let releaseStart!: (value: { ts: string }) => void;
    let releaseEndPost!: (value: { ts: string }) => void;
    slackApi.postSystemMessage
      .mockImplementationOnce(
        () =>
          new Promise<{ ts: string }>((resolve) => {
            releaseStart = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<{ ts: string }>((resolve) => {
            releaseEndPost = resolve;
          }),
      );

    const starting = postCompactStartingIfNeeded(deps(session, slackApi), 'auto');
    const completing = postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' });
    await vi.advanceTimersByTimeAsync(COMPACT_END_WAIT_FOR_START_MS);
    // END is now inside its own fresh completion post.
    releaseStart({ ts: 'late_ts' });
    await starting;
    releaseEndPost({ ts: 'end_ts' });
    await completing;

    expect(updates(slackApi)).toEqual(['late_ts <- 🟢 🗜️ Compaction completed']);
    expect(session.compactTickInterval).toBeUndefined();
    expect(session.compactStartingMessageTs).toBeNull();

    await closeCompactStartingAtTurnEnd(deps(session, slackApi));
    expect(slackApi.updateMessage).toHaveBeenCalledTimes(1);
  });
});

describe('a failed completion releases its END claim', () => {
  it('concurrent ENDs: the first delivery rejects, the waiting second END delivers — one completion message', async () => {
    const session = track(makeSession(COMPACT));
    const slackApi = makeSlackApi();
    slackApi.postSystemMessage.mockRejectedValueOnce(new Error('rate_limited')).mockResolvedValueOnce({ ts: 'end_ts' });

    const first = postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' });
    const second = postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' });
    const outcomes = await Promise.allSettled([first, second]);

    expect(outcomes.map((o) => o.status)).toEqual(['rejected', 'fulfilled']);
    expect(slackApi.postSystemMessage).toHaveBeenCalledTimes(2);
    expect(String(slackApi.postSystemMessage.mock.calls[1]?.[1])).toContain('Compaction completed');
    expect(session.compactPostedByEpoch?.[1]?.post).toBe(true);

    // A third END for the sealed cycle posts nothing more.
    await postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' });
    expect(slackApi.postSystemMessage).toHaveBeenCalledTimes(2);
  });

  it('sequential: a later END retries after a failed one — the claim is not kept forever', async () => {
    const session = track(makeSession(COMPACT));
    const slackApi = makeSlackApi();
    slackApi.postSystemMessage.mockRejectedValueOnce(new Error('rate_limited')).mockResolvedValueOnce({ ts: 'end_ts' });

    await expect(
      postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' }),
    ).rejects.toThrow('rate_limited');
    expect(session.compactPostedByEpoch?.[1]?.post).toBe(false);

    await postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' });

    expect(slackApi.postSystemMessage).toHaveBeenCalledTimes(2);
    expect(session.compactPostedByEpoch?.[1]?.post).toBe(true);
  });
});

/**
 * The CLI awaits the PostCompact hook. In the usual ordering the stream's
 * fire-and-forget `compact_boundary` END claims the cycle first, so the hook
 * arrives as the DUPLICATE — and must not sit through the claimer's Slack
 * calls. It returns at once; its retry-on-failure runs in the background.
 */
describe('a duplicate END never blocks its caller (the CLI-awaited PostCompact hook)', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("the claimer's chat.update hangs: the duplicate hook returns promptly", async () => {
    const session = track(makeSession(COMPACT));
    const slackApi = makeSlackApi();
    await postCompactStartingIfNeeded(deps(session, slackApi), 'auto');
    slackApi.updateMessage.mockImplementationOnce(() => new Promise(() => {}));
    session.compactPreTokens = 150_000;

    void postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const hooks = buildCompactHooks(deps(session, slackApi));
    const t0 = Date.now();
    const outcome = await Promise.race([
      hooks
        .PostCompact({ hook_event_name: 'PostCompact', trigger: 'auto' } as unknown as PostCompactHookInput)
        .then(() => 'returned'),
      new Promise((resolve) => setTimeout(() => resolve('blocked'), 500)),
    ]);

    expect(outcome).toBe('returned');
    expect(Date.now() - t0).toBeLessThan(50);
    // Its synchronous bookkeeping still ran.
    expect(session.autoCompactPending).toBe(false);
    expect(session.pendingUserText).toBeNull();
  });

  it('the duplicate does not wait the 500 ms metadata window either when an END is already delivering', async () => {
    const session = track(makeSession(COMPACT));
    const slackApi = makeSlackApi();
    await postCompactStartingIfNeeded(deps(session, slackApi), 'auto');
    slackApi.updateMessage.mockImplementationOnce(() => new Promise(() => {}));
    // No boundary metadata: a hook that claimed would wait 500 ms for it.

    void postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const t0 = Date.now();
    await buildCompactHooks(deps(session, slackApi)).PostCompact({
      hook_event_name: 'PostCompact',
      trigger: 'auto',
    } as unknown as PostCompactHookInput);

    expect(Date.now() - t0).toBeLessThan(50);
  });

  it('the claimer then fails: the detached duplicate delivers the completion once', async () => {
    const session = track(makeSession(COMPACT));
    const slackApi = makeSlackApi();
    await postCompactStartingIfNeeded(deps(session, slackApi), 'auto');
    const hangingUpdate = deferred<undefined>();
    slackApi.updateMessage.mockImplementationOnce(() => hangingUpdate.promise);
    slackApi.postSystemMessage.mockRejectedValueOnce(new Error('fallback post failed'));
    session.compactPreTokens = 150_000;

    const claimer = postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await buildCompactHooks(deps(session, slackApi)).PostCompact({
      hook_event_name: 'PostCompact',
      trigger: 'auto',
    } as unknown as PostCompactHookInput);

    hangingUpdate.reject(new Error('message_not_found'));
    await expect(claimer).rejects.toThrow('fallback post failed');
    await vi.waitFor(() => expect(session.compactPostedByEpoch?.[1]?.post).toBe(true));

    // The failed claimer's update, then the detached retry's — both in place.
    // (The retry's line also carries the hook's `trigger=auto`.)
    const lines = updates(slackApi);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line.startsWith('start_ts <- 🟢 🗜️ Compaction completed')).toBe(true);
    // start + failed fallback: no further post — the retry updated in place.
    expect(slackApi.postSystemMessage).toHaveBeenCalledTimes(2);
  });
});

/**
 * The turn-end close skips a cycle whose END is still delivering (END owns
 * the message). If that delivery then fails for good — no other END waiting
 * to retry — the END path does the neutral close itself; otherwise the
 * "starting" message would stay with its ticker stopped and nothing to end it.
 */
describe('an END that fails after the turn ended closes the starting message itself', () => {
  it('update and fallback both reject after turn end deferred to END: the message ends neutral', async () => {
    const session = track(makeSession(COMPACT));
    const slackApi = makeSlackApi();
    await postCompactStartingIfNeeded(deps(session, slackApi), 'auto');
    let rejectUpdate!: (err: Error) => void;
    slackApi.updateMessage.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectUpdate = reject;
        }),
    );
    slackApi.postSystemMessage.mockRejectedValueOnce(new Error('fallback post failed'));

    const end = postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await closeCompactStartingAtTurnEnd(deps(session, slackApi));
    rejectUpdate(new Error('message_not_found'));
    await expect(end).rejects.toThrow('fallback post failed');

    expect(updates(slackApi)).toEqual([
      'start_ts <- 🟢 🗜️ Compaction completed',
      `start_ts <- ${COMPACT_ENDED_WITHOUT_SIGNAL_TEXT}`,
    ]);
    expect(session.compactStartingMessageTs).toBeNull();
    expect(session.compactTickInterval).toBeUndefined();
  });

  it('the same failure BEFORE the turn ends leaves the close to turn end (no early neutral line)', async () => {
    const session = track(makeSession(COMPACT));
    const slackApi = makeSlackApi();
    await postCompactStartingIfNeeded(deps(session, slackApi), 'auto');
    slackApi.updateMessage.mockRejectedValueOnce(new Error('message_not_found'));
    slackApi.postSystemMessage.mockRejectedValueOnce(new Error('fallback post failed'));

    await expect(
      postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' }),
    ).rejects.toThrow();
    expect(slackApi.updateMessage).toHaveBeenCalledTimes(1);

    await closeCompactStartingAtTurnEnd(deps(session, slackApi));
    const lines = updates(slackApi);
    expect(lines[lines.length - 1]).toBe(`start_ts <- ${COMPACT_ENDED_WITHOUT_SIGNAL_TEXT}`);
  });
});
