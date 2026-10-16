/**
 * Spec 10 §3.2-4 — below `compact` the compaction start/complete notices are
 * not posted to the thread (stream-executor records them as work-log
 * `notice` entries instead). Only the Slack posts are gated: the epoch
 * markers, the usage snapshot, `autoCompactPending`, `skipThresholdCheckOnce`
 * and the deferred re-dispatch all still happen. At compact and above the
 * behavior is main's, unchanged (covered by compact-hooks.test.ts).
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

function makeSession(logVerbosity: unknown) {
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
  } as unknown as ConversationSession;
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
  it('minimal: START and END post nothing, and every side effect still happens', async () => {
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

  it('minimal START, then a switch to compact before END: END posts a fresh completion', async () => {
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

  it('compact START posted, then a switch to minimal: END replaces it in place', async () => {
    const session = track(makeSession(COMPACT));
    const slackApi = makeSlackApi();

    await postCompactStartingIfNeeded(deps(session, slackApi), 'auto');
    expect(String(slackApi.postSystemMessage.mock.calls[0]?.[1])).toContain('Compaction starting');
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

  it.each([
    ['compact', COMPACT],
    ['no mask (legacy session)', undefined],
    ['a non-numeric mask', 'detail'],
  ])('%s behaves like detail: START posts, END replaces it in place', async (_label, mask) => {
    const session = track(makeSession(mask));
    const slackApi = makeSlackApi();

    await postCompactStartingIfNeeded(deps(session, slackApi), 'auto');
    expect(slackApi.postSystemMessage).toHaveBeenCalledTimes(1);
    expect(String(slackApi.postSystemMessage.mock.calls[0]?.[1])).toContain('Compaction starting');

    await postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' });

    expect(slackApi.postSystemMessage).toHaveBeenCalledTimes(1);
    expect(slackApi.updateMessage).toHaveBeenCalledWith(
      'C1',
      'start_ts',
      expect.stringContaining('Compaction completed'),
    );
    expectCycleSealed(session);
  });
});
