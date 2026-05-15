import type { PostCompactHookInput, PreCompactHookInput, SessionStartHookInput } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock compaction-context-builder before importing the module under test.
// buildCompactionContext returning a truthy string is what flips
// session.compactionOccurred in the SessionStart hook.
vi.mock('../../../session/compaction-context-builder', () => ({
  buildCompactionContext: vi.fn().mockReturnValue('<compaction-context>…</compaction-context>'),
  snapshotFromSession: vi.fn().mockReturnValue({}),
}));

import type { ConversationSession } from '../../../types';
import type { EventRouter } from '../../event-router';
import type { SlackApiHelper } from '../../slack-api-helper';
import { beginCompactionCycleIfNeeded, buildCompactHooks, getCurrentEpochForEnd } from '../compact-hooks';

function makeSession(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return {
    channelId: 'C1',
    threadTs: 'T1',
    compactionCount: 0,
    compactEpoch: 0,
    compactPostedByEpoch: {},
    compactionRehydratedByEpoch: {},
    preCompactUsagePct: null,
    lastKnownUsagePct: null,
    compactPreTokens: null,
    compactPostTokens: null,
    compactTrigger: null,
    compactDurationMs: null,
    compactStartingMessageTs: null,
    compactStartedAtMs: null,
    compactTickInterval: undefined,
    autoCompactPending: false,
    pendingUserText: null,
    pendingEventContext: null,
    ...overrides,
  } as ConversationSession;
}

/**
 * Teardown guard: tests that post a "starting" message leave behind a live
 * setInterval handle on the session. Clear it here so vitest doesn't hold
 * the worker open.
 */
function clearStartingTicker(session: ConversationSession): void {
  if (session.compactTickInterval) {
    clearInterval(session.compactTickInterval);
    session.compactTickInterval = undefined;
  }
}

/**
 * #617 — Compact hooks (PreCompact / PostCompact / SessionStart).
 * Covers AC4 (starting post), AC5 (complete post), AC6 (rehydration + dedupe).
 */
describe('Epoch helpers (#617 AC6 dedupe foundation)', () => {
  it('AC6: beginCompactionCycleIfNeeded bumps from epoch 0 → 1 on first call', () => {
    const session = makeSession();
    expect(beginCompactionCycleIfNeeded(session)).toBe(1);
    expect(session.compactEpoch).toBe(1);
    expect(session.compactPostedByEpoch?.[1]).toEqual({ pre: false, post: false });
  });

  it('AC6: beginCompactionCycleIfNeeded is idempotent inside an open cycle', () => {
    const session = makeSession();
    beginCompactionCycleIfNeeded(session); // 0 → 1
    beginCompactionCycleIfNeeded(session); // still 1
    expect(session.compactEpoch).toBe(1);
  });

  it('AC6: beginCompactionCycleIfNeeded bumps again once previous cycle closed (post=true)', () => {
    const session = makeSession();
    beginCompactionCycleIfNeeded(session);
    session.compactPostedByEpoch![1] = { pre: true, post: true };
    expect(beginCompactionCycleIfNeeded(session)).toBe(2);
    expect(session.compactEpoch).toBe(2);
  });

  it('AC6: getCurrentEpochForEnd NEVER bumps when a cycle is open', () => {
    const session = makeSession();
    beginCompactionCycleIfNeeded(session); // opens epoch 1
    expect(getCurrentEpochForEnd(session)).toBe(1);
    expect(session.compactEpoch).toBe(1);
  });

  it('AC6: getCurrentEpochForEnd initializes exactly one cycle when called first (dropped-START fallback)', () => {
    const session = makeSession();
    expect(getCurrentEpochForEnd(session)).toBe(1);
    expect(session.compactEpoch).toBe(1);
    expect(session.compactPostedByEpoch?.[1]).toEqual({ pre: false, post: false });
  });

  it('stale-metadata P1: beginCompactionCycleIfNeeded wipes prior cycle boundary metadata on bump', () => {
    const session = makeSession();
    // Simulate cycle N fully closed with SDK-populated boundary metadata.
    beginCompactionCycleIfNeeded(session); // epoch 0 → 1
    session.compactPostedByEpoch![1] = { pre: true, post: true };
    session.compactPreTokens = 160_000;
    session.compactPostTokens = 35_000;
    session.compactTrigger = 'auto';
    session.compactDurationMs = 5_200;

    // Cycle N+1 starts — the bump must clear the stale metadata so the
    // PostCompact grace window in postCompactCompleteIfNeeded actually
    // waits for the new onCompactBoundary payload instead of rendering
    // cycle N's numbers on cycle N+1's announcement.
    expect(beginCompactionCycleIfNeeded(session)).toBe(2);
    expect(session.compactPreTokens).toBeNull();
    expect(session.compactPostTokens).toBeNull();
    expect(session.compactTrigger).toBeNull();
    expect(session.compactDurationMs).toBeNull();
  });

  it('stale-metadata P1: idempotent bump inside an open cycle does NOT wipe live metadata', () => {
    const session = makeSession();
    beginCompactionCycleIfNeeded(session); // open epoch 1
    // onCompactBoundary already wrote cycle 1's metadata — the second
    // call (e.g. compacting-status fallback racing the PreCompact hook)
    // must be a true no-op, not a reset.
    session.compactPreTokens = 160_000;
    session.compactPostTokens = 35_000;
    session.compactTrigger = 'auto';
    session.compactDurationMs = 5_200;

    expect(beginCompactionCycleIfNeeded(session)).toBe(1);
    expect(session.compactPreTokens).toBe(160_000);
    expect(session.compactPostTokens).toBe(35_000);
    expect(session.compactTrigger).toBe('auto');
    expect(session.compactDurationMs).toBe(5_200);
  });
});

describe('buildCompactHooks — PreCompact (#617 AC4, live ticker v2)', () => {
  let slackApi: {
    postSystemMessage: ReturnType<typeof vi.fn>;
    updateMessage: ReturnType<typeof vi.fn>;
  };
  let session: ConversationSession;

  beforeEach(() => {
    slackApi = {
      postSystemMessage: vi.fn().mockResolvedValue({ ts: '1700000000.000100', channel: 'C1' }),
      updateMessage: vi.fn().mockResolvedValue(undefined),
    };
    session = makeSession({ lastKnownUsagePct: 82 });
  });

  afterEach(() => {
    clearStartingTicker(session);
    vi.useRealTimers();
  });

  const payloadOf = (trigger: 'manual' | 'auto'): PreCompactHookInput =>
    ({
      session_id: 'sess-1',
      transcript_path: '/tmp/t',
      cwd: '/tmp',
      hook_event_name: 'PreCompact',
      trigger,
      custom_instructions: null,
    }) as unknown as PreCompactHookInput;

  it('AC4 v2: posts "⏳ 🗜️ Compaction starting · trigger=manual", bumps epoch, snapshots preCompactUsagePct, captures message ts', async () => {
    const hooks = buildCompactHooks({
      session,
      channel: 'C1',
      threadTs: 'T1',
      slackApi: slackApi as unknown as SlackApiHelper,
    });

    const res = (await hooks.PreCompact(payloadOf('manual') as any)) as { continue?: boolean };
    expect(res.continue).toBe(true);
    expect(session.compactEpoch).toBe(1);
    expect(session.preCompactUsagePct).toBe(82);
    expect(slackApi.postSystemMessage).toHaveBeenCalledWith('C1', '⏳ 🗜️ Compaction starting · trigger=manual', {
      threadTs: 'T1',
    });
    expect(session.compactPostedByEpoch?.[1]?.pre).toBe(true);
    // Runtime handles captured for the ticker path.
    expect(session.compactStartingMessageTs).toBe('1700000000.000100');
    expect(typeof session.compactStartedAtMs).toBe('number');
    expect(session.compactTickInterval).toBeDefined();
  });

  it('AC4 v2: auto trigger → starting text includes `trigger=auto`', async () => {
    const hooks = buildCompactHooks({
      session,
      channel: 'C1',
      threadTs: 'T1',
      slackApi: slackApi as unknown as SlackApiHelper,
    });
    await hooks.PreCompact(payloadOf('auto') as any);
    expect(slackApi.postSystemMessage).toHaveBeenCalledWith('C1', '⏳ 🗜️ Compaction starting · trigger=auto', {
      threadTs: 'T1',
    });
  });

  it('AC4 v2: second PreCompact call inside same cycle does NOT re-post (pre=true dedupe)', async () => {
    const hooks = buildCompactHooks({
      session,
      channel: 'C1',
      threadTs: 'T1',
      slackApi: slackApi as unknown as SlackApiHelper,
    });
    await hooks.PreCompact(payloadOf('manual') as any);
    await hooks.PreCompact(payloadOf('manual') as any);
    expect(slackApi.postSystemMessage).toHaveBeenCalledTimes(1);
  });

  it('AC4 v2: ticker fires chat.update with elapsed `— 3s` / `— 6s` as time advances', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const hooks = buildCompactHooks({
      session,
      channel: 'C1',
      threadTs: 'T1',
      slackApi: slackApi as unknown as SlackApiHelper,
    });

    await hooks.PreCompact(payloadOf('auto') as any);
    expect(slackApi.updateMessage).not.toHaveBeenCalled();

    // First tick at T+3s
    await vi.advanceTimersByTimeAsync(3_000);
    expect(slackApi.updateMessage).toHaveBeenCalledWith(
      'C1',
      '1700000000.000100',
      '⏳ 🗜️ Compaction starting · trigger=auto — 3s',
    );

    // Second tick at T+6s
    await vi.advanceTimersByTimeAsync(3_000);
    expect(slackApi.updateMessage).toHaveBeenLastCalledWith(
      'C1',
      '1700000000.000100',
      '⏳ 🗜️ Compaction starting · trigger=auto — 6s',
    );
  });
});

describe('buildCompactHooks — PostCompact (#617 AC5, chat.update v2)', () => {
  let slackApi: {
    postSystemMessage: ReturnType<typeof vi.fn>;
    updateMessage: ReturnType<typeof vi.fn>;
  };
  let eventRouter: { dispatchPendingUserMessage: ReturnType<typeof vi.fn> };
  let session: ConversationSession;

  beforeEach(() => {
    slackApi = {
      postSystemMessage: vi.fn().mockResolvedValue({ ts: undefined, channel: 'C1' }),
      updateMessage: vi.fn().mockResolvedValue(undefined),
    };
    eventRouter = { dispatchPendingUserMessage: vi.fn().mockResolvedValue(undefined) };
    session = makeSession({ preCompactUsagePct: 83, lastKnownUsagePct: 45 });
    // Open a cycle so PostCompact has a marker to flip.
    beginCompactionCycleIfNeeded(session);
    session.compactPostedByEpoch![1].pre = true;
    // Simulate the ticker state left behind by a prior `postCompactStartingIfNeeded` call.
    session.compactStartingMessageTs = '1700000000.000100';
    session.compactStartedAtMs = Date.now();
  });

  afterEach(() => {
    clearStartingTicker(session);
  });

  const postPayload = (): PostCompactHookInput =>
    ({
      session_id: 'sess-1',
      transcript_path: '/tmp/t',
      cwd: '/tmp',
      hook_event_name: 'PostCompact',
      trigger: 'manual',
      compact_summary: 'summary',
    }) as unknown as PostCompactHookInput;

  it('AC5 v2: replaces the starting message in-place via chat.update, not postSystemMessage', async () => {
    const hooks = buildCompactHooks({
      session,
      channel: 'C1',
      threadTs: 'T1',
      slackApi: slackApi as unknown as SlackApiHelper,
      eventRouter: eventRouter as unknown as EventRouter,
    });
    await hooks.PostCompact(postPayload() as any);
    // #617 followup v2: PostCompact payload carries trigger=manual, so the
    // completion message header includes `· trigger=manual` (handlePostCompact
    // writes session.compactTrigger when onCompactBoundary hasn't set it yet).
    expect(slackApi.updateMessage).toHaveBeenCalledWith(
      'C1',
      '1700000000.000100',
      '🟢 🗜️ Compaction completed · trigger=manual\nContext: now ~45% ← was ~83%',
    );
    expect(slackApi.postSystemMessage).not.toHaveBeenCalled();
    expect(session.compactPostedByEpoch?.[1]?.post).toBe(true);
    expect(session.autoCompactPending).toBe(false);
    // Runtime-only START tracking cleared.
    expect(session.compactStartingMessageTs).toBeNull();
    expect(session.compactStartedAtMs).toBeNull();
  });

  it('AC5 v2: with full SDK metadata → rich 2-line completed message', async () => {
    session.compactPreTokens = 160_000;
    session.compactPostTokens = 35_000;
    session.preCompactUsagePct = 80;
    session.lastKnownUsagePct = 16;
    session.compactTrigger = 'auto';
    session.compactDurationMs = 5_200;
    session.compactionCount = 3;

    const hooks = buildCompactHooks({
      session,
      channel: 'C1',
      threadTs: 'T1',
      slackApi: slackApi as unknown as SlackApiHelper,
    });
    await hooks.PostCompact(postPayload() as any);
    expect(slackApi.updateMessage).toHaveBeenCalledWith(
      'C1',
      '1700000000.000100',
      '🟢 🗜️ Compaction completed · trigger=auto (5.2s)\n' +
        'Context: now 16% (35k/200k) ← was 80% (160k/200k) · compaction #3',
    );
  });

  it('AC5 v2: no starting ts captured (Slack failed on START) → falls back to fresh postSystemMessage', async () => {
    session.compactStartingMessageTs = null;
    const hooks = buildCompactHooks({
      session,
      channel: 'C1',
      threadTs: 'T1',
      slackApi: slackApi as unknown as SlackApiHelper,
    });
    await hooks.PostCompact(postPayload() as any);
    expect(slackApi.updateMessage).not.toHaveBeenCalled();
    expect(slackApi.postSystemMessage).toHaveBeenCalledWith(
      'C1',
      '🟢 🗜️ Compaction completed · trigger=manual\nContext: now ~45% ← was ~83%',
      { threadTs: 'T1' },
    );
  });

  it('AC5 v2: chat.update fails → falls back to fresh postSystemMessage (no silent drop)', async () => {
    slackApi.updateMessage = vi.fn().mockRejectedValueOnce(new Error('message_not_found'));
    const hooks = buildCompactHooks({
      session,
      channel: 'C1',
      threadTs: 'T1',
      slackApi: slackApi as unknown as SlackApiHelper,
    });
    await hooks.PostCompact(postPayload() as any);
    expect(slackApi.updateMessage).toHaveBeenCalledTimes(1);
    expect(slackApi.postSystemMessage).toHaveBeenCalledWith(
      'C1',
      '🟢 🗜️ Compaction completed · trigger=manual\nContext: now ~45% ← was ~83%',
      { threadTs: 'T1' },
    );
  });

  it('AC6 dedupe: second PostCompact in same epoch does NOT re-post', async () => {
    const hooks = buildCompactHooks({
      session,
      channel: 'C1',
      threadTs: 'T1',
      slackApi: slackApi as unknown as SlackApiHelper,
    });
    await hooks.PostCompact(postPayload() as any);
    await hooks.PostCompact(postPayload() as any);
    expect(slackApi.updateMessage).toHaveBeenCalledTimes(1);
    expect(slackApi.postSystemMessage).not.toHaveBeenCalled();
  });

  it('AC3 re-dispatch: PostCompact consumes pendingUserText via eventRouter exactly once', async () => {
    session.pendingUserText = 'original user text';
    session.pendingEventContext = { channel: 'C1', threadTs: 'T1', user: 'U1', ts: '171.0' };

    const hooks = buildCompactHooks({
      session,
      channel: 'C1',
      threadTs: 'T1',
      slackApi: slackApi as unknown as SlackApiHelper,
      eventRouter: eventRouter as unknown as EventRouter,
    });
    await hooks.PostCompact(postPayload() as any);

    expect(eventRouter.dispatchPendingUserMessage).toHaveBeenCalledTimes(1);
    expect(eventRouter.dispatchPendingUserMessage).toHaveBeenCalledWith(
      { channel: 'C1', threadTs: 'T1', user: 'U1', ts: '171.0' },
      'original user text',
    );
    // Cleared after atomic consume — second END signal cannot re-dispatch.
    expect(session.pendingUserText).toBeNull();
    expect(session.pendingEventContext).toBeNull();
  });

  it('AC3 re-dispatch: no eventRouter injected → silently skips without throwing', async () => {
    session.pendingUserText = 'x';
    session.pendingEventContext = { channel: 'C1', threadTs: 'T1', user: 'U1', ts: '0' };
    const hooks = buildCompactHooks({
      session,
      channel: 'C1',
      threadTs: 'T1',
      slackApi: slackApi as unknown as SlackApiHelper,
      // no eventRouter
    });
    await expect(hooks.PostCompact(postPayload() as any)).resolves.toEqual({ continue: true });
    // pendingUserText NOT cleared because no router — next turn still has it.
    expect(session.pendingUserText).toBe('x');
  });
});

describe('buildCompactHooks — SessionStart (#617 AC6)', () => {
  let slackApi: { postSystemMessage: ReturnType<typeof vi.fn> };
  let session: ConversationSession;

  beforeEach(() => {
    slackApi = { postSystemMessage: vi.fn().mockResolvedValue(undefined) };
    session = makeSession();
    beginCompactionCycleIfNeeded(session);
  });

  const sessionPayload = (source: 'startup' | 'resume' | 'clear' | 'compact'): SessionStartHookInput =>
    ({
      session_id: 'sess-1',
      transcript_path: '/tmp/t',
      cwd: '/tmp',
      hook_event_name: 'SessionStart',
      source,
    }) as unknown as SessionStartHookInput;

  it('AC6: source=compact → flips compactionOccurred and rehydrated map', async () => {
    const hooks = buildCompactHooks({
      session,
      channel: 'C1',
      threadTs: 'T1',
      slackApi: slackApi as unknown as SlackApiHelper,
    });
    await hooks.SessionStart(sessionPayload('compact') as any);
    expect(session.compactionOccurred).toBe(true);
    expect(session.compactionRehydratedByEpoch?.[1]).toBe(true);
  });

  it('AC6: source=startup → no-op (does NOT set compactionOccurred)', async () => {
    const hooks = buildCompactHooks({
      session,
      channel: 'C1',
      threadTs: 'T1',
      slackApi: slackApi as unknown as SlackApiHelper,
    });
    await hooks.SessionStart(sessionPayload('startup') as any);
    expect(session.compactionOccurred).toBeFalsy();
    expect(session.compactionRehydratedByEpoch?.[1]).toBeFalsy();
  });

  it('AC6: source=resume → no-op', async () => {
    const hooks = buildCompactHooks({
      session,
      channel: 'C1',
      threadTs: 'T1',
      slackApi: slackApi as unknown as SlackApiHelper,
    });
    await hooks.SessionStart(sessionPayload('resume') as any);
    expect(session.compactionOccurred).toBeFalsy();
  });

  it('AC6: idempotent — second source=compact with rehydrated flag skips rebuild', async () => {
    session.compactionRehydratedByEpoch = { 1: true };
    const hooks = buildCompactHooks({
      session,
      channel: 'C1',
      threadTs: 'T1',
      slackApi: slackApi as unknown as SlackApiHelper,
    });
    await hooks.SessionStart(sessionPayload('compact') as any);
    // compactionOccurred must NOT flip because rehydration already happened
    // via the stream-executor compact_boundary path.
    expect(session.compactionOccurred).toBeFalsy();
  });
});

/**
 * #617 followup v2 — three post-deploy bugs:
 *   Bug 1: duplicate "starting" message when PreCompact + compacting-status
 *          fire concurrently (check-then-act race on marker.pre).
 *   Bug 2: runaway ticker — the second race winner overwrites
 *          `session.compactTickInterval`, leaking the first setInterval.
 *   Bug 3: auto-compact completion shows `~?% ← was ~?%` when PostCompact
 *          races onCompactBoundary.
 * See docs/issues/compact-bugs-trace/trace.md.
 */
describe('Compact follow-up fixes (#617 v2 bugs 1/2/3)', () => {
  let slackApi: {
    postSystemMessage: ReturnType<typeof vi.fn>;
    updateMessage: ReturnType<typeof vi.fn>;
  };
  let session: ConversationSession;

  beforeEach(() => {
    slackApi = {
      postSystemMessage: vi.fn().mockResolvedValue({ ts: '1700000000.000100', channel: 'C1' }),
      updateMessage: vi.fn().mockResolvedValue(undefined),
    };
    session = makeSession({ lastKnownUsagePct: 80 });
  });

  afterEach(() => {
    clearStartingTicker(session);
    vi.useRealTimers();
  });

  const preCompactPayload = (): PreCompactHookInput =>
    ({
      session_id: 'sess-1',
      transcript_path: '/tmp/t',
      cwd: '/tmp',
      hook_event_name: 'PreCompact',
      trigger: 'manual',
      custom_instructions: null,
    }) as unknown as PreCompactHookInput;

  const postCompactPayload = (trigger: 'manual' | 'auto' = 'manual'): PostCompactHookInput =>
    ({
      session_id: 'sess-1',
      transcript_path: '/tmp/t',
      cwd: '/tmp',
      hook_event_name: 'PostCompact',
      trigger,
      compact_summary: 'summary',
    }) as unknown as PostCompactHookInput;

  /**
   * Bug 1+2 RED — previously `marker.pre = true` was set AFTER
   * `await postSystemMessage`, so two concurrent callers would both pass the
   * `!marker.pre` guard synchronously, then each post + start a ticker. The
   * second `setInterval` would overwrite the first pointer on the session,
   * and the first ticker would tick forever.
   *
   * After the fix (atomic marker + defensive stopStartingTicker), two
   * parallel calls produce exactly ONE post and leave exactly ONE interval
   * handle on the session.
   */
  it('Bug 1+2: two parallel PreCompact-style calls post once + leave one ticker', async () => {
    // Make the Slack post block briefly so both callers cross the await.
    let resolvePost!: (value: { ts: string; channel: string }) => void;
    slackApi.postSystemMessage = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePost = resolve;
        }),
    );

    const hooks = buildCompactHooks({
      session,
      channel: 'C1',
      threadTs: 'T1',
      slackApi: slackApi as unknown as SlackApiHelper,
    });

    // Fire the two racing START paths. Neither has awaited yet.
    const a = hooks.PreCompact(preCompactPayload() as any);
    const b = hooks.PreCompact(preCompactPayload() as any);

    resolvePost({ ts: '1700000000.000100', channel: 'C1' });
    await Promise.all([a, b]);

    expect(slackApi.postSystemMessage).toHaveBeenCalledTimes(1);
    expect(session.compactPostedByEpoch?.[1]?.pre).toBe(true);
    // Exactly one ticker handle stored on the session.
    expect(session.compactTickInterval).toBeDefined();
  });

  /**
   * Bug 3 RED — when PostCompact arrives before onCompactBoundary has
   * populated session.compactPreTokens/PostTokens/DurationMs, the completion
   * message used to render `~?% ← was ~?%`. Fix 2 introduces a 500 ms grace
   * window: if the boundary callback races in during the wait and seals the
   * cycle, the PostCompact path becomes a no-op.
   */
  it('Bug 3: PostCompact-first waits ~500ms and yields to onCompactBoundary if it arrives', async () => {
    // Open a cycle (PreCompact-style setup).
    beginCompactionCycleIfNeeded(session);
    session.compactPostedByEpoch![1].pre = true;
    session.compactStartingMessageTs = '1700000000.000100';
    session.compactStartedAtMs = Date.now();

    const hooks = buildCompactHooks({
      session,
      channel: 'C1',
      threadTs: 'T1',
      slackApi: slackApi as unknown as SlackApiHelper,
    });

    // Fire PostCompact — metadata missing, so it enters the 500ms wait.
    const pending = hooks.PostCompact(postCompactPayload('auto') as any);

    // Simulate onCompactBoundary racing in DURING the wait:
    // populate metadata and seal the cycle (marker.post = true) as the
    // stream-executor path does.
    session.compactPreTokens = 160_000;
    session.compactPostTokens = 35_000;
    session.compactTrigger = 'auto';
    session.compactDurationMs = 5_200;
    session.compactPostedByEpoch![1].post = true;

    await pending;

    // The PostCompact path yielded to the boundary callback.
    expect(slackApi.updateMessage).not.toHaveBeenCalled();
    expect(slackApi.postSystemMessage).not.toHaveBeenCalled();
  });

  /**
   * Bug 3 RED — when neither boundary callback nor subsequent metadata
   * population races in during the grace window, the hook eventually posts
   * with whatever it has (including the PostCompact-captured trigger).
   */
  it('Bug 3: PostCompact with no metadata after grace window still posts, with captured trigger', async () => {
    beginCompactionCycleIfNeeded(session);
    session.compactPostedByEpoch![1].pre = true;
    session.compactStartingMessageTs = '1700000000.000100';
    session.compactStartedAtMs = Date.now();

    const hooks = buildCompactHooks({
      session,
      channel: 'C1',
      threadTs: 'T1',
      slackApi: slackApi as unknown as SlackApiHelper,
    });

    await hooks.PostCompact(postCompactPayload('auto') as any);

    expect(session.compactTrigger).toBe('auto');
    expect(slackApi.updateMessage).toHaveBeenCalledTimes(1);
    const [, , text] = (slackApi.updateMessage as any).mock.calls[0];
    expect(text).toContain('trigger=auto');
  });

  /**
   * Bug 3 RED — PostCompact must NOT clobber an already-set trigger
   * (onCompactBoundary is authoritative; both signals carry the same value
   * in practice, but if they ever differ the boundary wins).
   */
  it('Bug 3: handlePostCompact preserves a pre-set compactTrigger from onCompactBoundary', async () => {
    beginCompactionCycleIfNeeded(session);
    session.compactPostedByEpoch![1].pre = true;
    session.compactStartingMessageTs = '1700000000.000100';
    session.compactStartedAtMs = Date.now();
    // onCompactBoundary already set trigger=auto and metadata.
    session.compactTrigger = 'auto';
    session.compactPreTokens = 160_000;
    session.compactPostTokens = 35_000;

    const hooks = buildCompactHooks({
      session,
      channel: 'C1',
      threadTs: 'T1',
      slackApi: slackApi as unknown as SlackApiHelper,
    });
    // PostCompact arrives with trigger='manual' — must NOT overwrite.
    await hooks.PostCompact(postCompactPayload('manual') as any);

    expect(session.compactTrigger).toBe('auto');
  });
});

/**
 * Stale "now %" bug — user-reported (auto-compact 후 남은 컨텍스트량 계산 오류).
 *
 * Reproduces the actual Slack output Zhuge saw:
 *   `Compaction completed · trigger=manual`
 *   `Context: now ~83% ← was ~83% (edited)`
 *
 * Root cause: `postCompactStartingIfNeeded` snapshots `preCompactUsagePct =
 * lastKnownUsagePct` but leaves `lastKnownUsagePct` untouched. When the SDK
 * doesn't fire `onCompactBoundary` with `post_tokens` (or fires it without
 * the field), `buildCompactCompleteMessage` falls into the
 * `now ~${lastKnownUsagePct}%` branch — which is now the SAME value as
 * `preCompactUsagePct`. Result: both segments print 83, which lies to the
 * user about what compaction did.
 *
 * Fix: invalidate `lastKnownUsagePct` at PreCompact time. The next
 * authoritative source (`onCompactBoundary` post_tokens, or a fresh turn-end
 * usage sample) repopulates it. Until then, the completion message honestly
 * shows `now ~?%`.
 */
describe('Stale lastKnownUsagePct after PreCompact (user-reported)', () => {
  let slackApi: {
    postSystemMessage: ReturnType<typeof vi.fn>;
    updateMessage: ReturnType<typeof vi.fn>;
  };
  let session: ConversationSession;

  beforeEach(() => {
    slackApi = {
      postSystemMessage: vi.fn().mockResolvedValue({ ts: '1700000000.000100', channel: 'C1' }),
      updateMessage: vi.fn().mockResolvedValue(undefined),
    };
    // Pre-compact heuristic at 83% (matches user's transcript).
    session = makeSession({ lastKnownUsagePct: 83 });
  });

  afterEach(() => {
    clearStartingTicker(session);
  });

  const preCompactPayload = (): PreCompactHookInput =>
    ({
      session_id: 'sess-1',
      transcript_path: '/tmp/t',
      cwd: '/tmp',
      hook_event_name: 'PreCompact',
      trigger: 'manual',
      custom_instructions: null,
    }) as unknown as PreCompactHookInput;

  const postCompactPayload = (): PostCompactHookInput =>
    ({
      session_id: 'sess-1',
      transcript_path: '/tmp/t',
      cwd: '/tmp',
      hook_event_name: 'PostCompact',
      trigger: 'manual',
      compact_summary: 'summary',
    }) as unknown as PostCompactHookInput;

  it('PreCompact captures preCompactUsagePct AND invalidates lastKnownUsagePct', async () => {
    const hooks = buildCompactHooks({
      session,
      channel: 'C1',
      threadTs: 'T1',
      slackApi: slackApi as unknown as SlackApiHelper,
    });
    await hooks.PreCompact(preCompactPayload() as any);

    expect(session.preCompactUsagePct).toBe(83);
    // Critical: lastKnownUsagePct must NOT remain at 83 — that's the value
    // we just promoted to "was". Leaving it would cause the completion
    // message to print "now ~83% ← was ~83%" if no fresh sample arrives.
    expect(session.lastKnownUsagePct).toBeNull();
  });

  it('user-reported scenario: PreCompact → no boundary metadata → PostCompact prints "now ~?% ← was ~83%"', async () => {
    const hooks = buildCompactHooks({
      session,
      channel: 'C1',
      threadTs: 'T1',
      slackApi: slackApi as unknown as SlackApiHelper,
    });

    // Full lifecycle: PreCompact then PostCompact, with NO `onCompactBoundary`
    // metadata in between (the missing-tokens case from the user's report).
    await hooks.PreCompact(preCompactPayload() as any);
    await hooks.PostCompact(postCompactPayload() as any);

    expect(slackApi.updateMessage).toHaveBeenCalledWith(
      'C1',
      '1700000000.000100',
      '🟢 🗜️ Compaction completed · trigger=manual\nContext: now ~?% ← was ~83%',
    );
  });

  it('boundary metadata still works: post_tokens repopulates lastKnownUsagePct → real now %', async () => {
    const hooks = buildCompactHooks({
      session,
      channel: 'C1',
      threadTs: 'T1',
      slackApi: slackApi as unknown as SlackApiHelper,
    });
    await hooks.PreCompact(preCompactPayload() as any);

    // Simulate stream-executor's onCompactBoundary firing with full metadata
    // between PreCompact and PostCompact (the happy path that already worked).
    session.compactPreTokens = 160_000;
    session.compactPostTokens = 35_000;
    // stream-executor.ts:1167-1178 also overwrites the usagePct fields:
    session.preCompactUsagePct = 80;
    session.lastKnownUsagePct = 16;

    await hooks.PostCompact(postCompactPayload() as any);

    expect(slackApi.updateMessage).toHaveBeenCalledWith(
      'C1',
      '1700000000.000100',
      expect.stringContaining('Context: now 16% (35k/200k) ← was 80% (160k/200k)'),
    );
  });

  it('PostCompact sets skipThresholdCheckOnce so the threshold checker skips the very next turn', async () => {
    const hooks = buildCompactHooks({
      session,
      channel: 'C1',
      threadTs: 'T1',
      slackApi: slackApi as unknown as SlackApiHelper,
    });
    await hooks.PreCompact(preCompactPayload() as any);
    await hooks.PostCompact(postCompactPayload() as any);

    // After a successful completion post the next threshold check must
    // be suppressed once. Without this, the immediately-following turn
    // re-trips the threshold (user reported "Context usage 83% ≥ threshold
    // 80%" firing right after the completion message — auto-compact loop).
    expect(session.skipThresholdCheckOnce).toBe(true);
  });

  it('duplicate START path does NOT clobber preCompactUsagePct with null (PR #932 codex review)', async () => {
    // Two START paths exist for the same cycle: PreCompact hook AND the
    // `status === 'compacting'` fallback in stream-executor.ts:777. If the
    // snapshot/invalidate ran BEFORE the marker.pre dedupe guard, the second
    // caller would read lastKnownUsagePct === null (already invalidated by
    // the first caller) and overwrite preCompactUsagePct with null. The
    // completion message would then print "was ~?%" instead of "was ~83%".
    const hooks = buildCompactHooks({
      session,
      channel: 'C1',
      threadTs: 'T1',
      slackApi: slackApi as unknown as SlackApiHelper,
    });

    // First PreCompact: snapshots 83 → preCompactUsagePct=83, lastKnown=null
    await hooks.PreCompact(preCompactPayload() as any);
    expect(session.preCompactUsagePct).toBe(83);
    expect(session.lastKnownUsagePct).toBeNull();

    // Second START in the same cycle (e.g. compacting-status fallback fires
    // after PreCompact). Must be a no-op for snapshot — preCompactUsagePct
    // must remain 83, NOT get overwritten to null.
    await hooks.PreCompact(preCompactPayload() as any);
    expect(session.preCompactUsagePct).toBe(83);
    expect(session.lastKnownUsagePct).toBeNull();

    // And the completion message still has the pre-compact value to render.
    await hooks.PostCompact(postCompactPayload() as any);
    expect(slackApi.updateMessage).toHaveBeenCalledWith(
      'C1',
      '1700000000.000100',
      '🟢 🗜️ Compaction completed · trigger=manual\nContext: now ~?% ← was ~83%',
    );
  });

  it('captures completion message ts on session for deferred update when boundary metadata is missing', async () => {
    // After PR #932 the user still saw `now ~?% ← was ~80%` because
    // onCompactBoundary doesn't always provide post_tokens. The product fix
    // is to remember the completion message ts so the next turn-end usage
    // sample can chat.update it in-place with a real post-compact %.
    const hooks = buildCompactHooks({
      session,
      channel: 'C1',
      threadTs: 'T1',
      slackApi: slackApi as unknown as SlackApiHelper,
    });
    await hooks.PreCompact(preCompactPayload() as any);
    await hooks.PostCompact(postCompactPayload() as any);

    // Must capture the just-posted completion message ts so the deferred
    // update path (compact-threshold-checker on next turn-end) can find it.
    expect(session.compactCompletionMessageTs).toBe('1700000000.000100');
  });

  it('does NOT capture completion message ts when boundary metadata IS present (no deferral needed)', async () => {
    const hooks = buildCompactHooks({
      session,
      channel: 'C1',
      threadTs: 'T1',
      slackApi: slackApi as unknown as SlackApiHelper,
    });
    await hooks.PreCompact(preCompactPayload() as any);

    // Simulate onCompactBoundary supplying authoritative post_tokens BEFORE
    // PostCompact fires (the happy path).
    session.compactPreTokens = 160_000;
    session.compactPostTokens = 35_000;
    session.preCompactUsagePct = 80;
    session.lastKnownUsagePct = 16;

    await hooks.PostCompact(postCompactPayload() as any);

    // No deferral: the completion message already shows real numbers.
    expect(session.compactCompletionMessageTs).toBeFalsy();
  });

  it('second PostCompact in same cycle does NOT re-arm skipThresholdCheckOnce after consume', async () => {
    // Lifecycle guard: when both PostCompact hook and onCompactBoundary fire
    // (race observed in production), `postCompactCompleteIfNeeded` re-enters
    // with marker.post=true and takes the no-post branch. The suppression
    // flag must NOT re-arm — otherwise a legitimate threshold check on a
    // later turn (after the first one consumed the flag) would be wrongly
    // skipped.
    const hooks = buildCompactHooks({
      session,
      channel: 'C1',
      threadTs: 'T1',
      slackApi: slackApi as unknown as SlackApiHelper,
    });
    await hooks.PreCompact(preCompactPayload() as any);
    await hooks.PostCompact(postCompactPayload() as any);

    // Simulate the next turn-end consuming the flag (as the threshold
    // checker does at compact-threshold-checker.ts:78-81).
    expect(session.skipThresholdCheckOnce).toBe(true);
    session.skipThresholdCheckOnce = false;

    // Now a second END signal fires — e.g. onCompactBoundary arrives after
    // the PostCompact hook already sealed the cycle. The function re-enters
    // with marker.post=true.
    await hooks.PostCompact(postCompactPayload() as any);

    // Must remain false — re-arming would silently suppress a legitimate
    // threshold check on a future turn.
    expect(session.skipThresholdCheckOnce).toBe(false);
    // Sanity: only one Slack post for the whole cycle.
    expect(slackApi.updateMessage).toHaveBeenCalledTimes(1);
  });
});
