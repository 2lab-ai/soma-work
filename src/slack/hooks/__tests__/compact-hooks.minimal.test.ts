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
import { buildCompactHooks, postCompactCompleteIfNeeded, postCompactStartingIfNeeded } from '../compact-hooks';

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
