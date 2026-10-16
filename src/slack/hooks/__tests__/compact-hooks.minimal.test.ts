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
import {
  bindCompactWorkLog,
  buildCompactHooks,
  postCompactCompleteIfNeeded,
  postCompactStartingIfNeeded,
} from '../compact-hooks';

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

/**
 * Spec 10 §3.3 — the work log gets exactly one start and one completion
 * `notice` per cycle, whichever path signals (SDK hooks, the stream's
 * status / compact_boundary fallbacks, or both), at every level. The sink is
 * the running turn's, bound by stream-executor (`bindCompactWorkLog`).
 */
describe('compaction work-log notices: one start and one completion per cycle', () => {
  function bound(mask: unknown) {
    const session = track(makeSession(mask));
    const slackApi = makeSlackApi();
    const entries: Array<{ kind: string; text: string }> = [];
    const unbind = bindCompactWorkLog(session, (entry) => {
      entries.push(entry);
    });
    return { session, slackApi, entries, unbind };
  }

  it.each([
    ['minimal', LOG_MINIMAL],
    ['compact', COMPACT],
  ])('%s: PreCompact hook + compacting status, then compact_boundary + PostCompact hook', async (_label, mask) => {
    const { session, slackApi, entries } = bound(mask);
    const hooks = buildCompactHooks(deps(session, slackApi));

    await hooks.PreCompact({ hook_event_name: 'PreCompact', trigger: 'auto' } as unknown as PreCompactHookInput);
    await postCompactStartingIfNeeded(deps(session, slackApi), 'unknown (fallback)');
    await postCompactStartingIfNeeded(deps(session, slackApi), 'unknown (fallback)');
    // The boundary callback writes the SDK metadata before signalling END.
    session.compactPreTokens = 160_000;
    session.compactPostTokens = 35_000;
    session.compactTrigger = 'auto';
    await postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' });
    await hooks.PostCompact({ hook_event_name: 'PostCompact', trigger: 'auto' } as unknown as PostCompactHookInput);

    expect(entries).toEqual([
      { kind: 'notice', text: 'Compaction starting' },
      { kind: 'notice', text: 'Compaction completed · trigger=auto · 160000 → 35000 tokens' },
    ]);
  });

  it('a completion that arrives ONLY through the PostCompact hook still records its notice', async () => {
    const { session, slackApi, entries } = bound(LOG_MINIMAL);
    session.compactPreTokens = 150_000;
    const hooks = buildCompactHooks(deps(session, slackApi));

    await hooks.PostCompact({ hook_event_name: 'PostCompact', trigger: 'manual' } as unknown as PostCompactHookInput);

    expect(entries).toEqual([{ kind: 'notice', text: 'Compaction completed · trigger=manual' }]);
  });

  it('two racing ENDs record one completion notice', async () => {
    const { session, slackApi, entries } = bound(COMPACT);
    await postCompactStartingIfNeeded(deps(session, slackApi), 'auto');

    await Promise.all([
      postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' }),
      postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' }),
    ]);

    expect(entries.filter((e) => e.text.startsWith('Compaction completed'))).toHaveLength(1);
  });

  it('a new cycle records its own pair; nothing is recorded once unbound', async () => {
    const { session, slackApi, entries, unbind } = bound(LOG_MINIMAL);
    await postCompactStartingIfNeeded(deps(session, slackApi), 'auto');
    await postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' });
    await postCompactStartingIfNeeded(deps(session, slackApi), 'auto');
    await postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' });
    expect(entries.map((e) => e.text.split(' ·')[0])).toEqual([
      'Compaction starting',
      'Compaction completed',
      'Compaction starting',
      'Compaction completed',
    ]);

    unbind();
    await postCompactStartingIfNeeded(deps(session, slackApi), 'auto');
    expect(entries).toHaveLength(4);
  });

  it('a throwing sink never breaks the cycle', async () => {
    const session = track(makeSession(LOG_MINIMAL));
    const slackApi = makeSlackApi();
    bindCompactWorkLog(session, () => {
      throw new Error('disk full');
    });

    await postCompactStartingIfNeeded(deps(session, slackApi), 'auto');
    await postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' });

    expectCycleSealed(session);
  });
});

describe('gating edge cases', () => {
  it('minimal, completion only (no START), then a duplicate completion: no post, one pending promotion', async () => {
    const session = track(makeSession(LOG_MINIMAL));
    const slackApi = makeSlackApi();

    await postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' });
    await postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' });

    expect(slackApi.postSystemMessage).not.toHaveBeenCalled();
    expect(slackApi.updateMessage).not.toHaveBeenCalled();
    expect(session.compactPendingDispatches).toEqual([
      { ctx: { channel: 'C1', threadTs: 'T1', user: 'U1', ts: '1.1' }, text: 'typed during compaction' },
    ]);
    expect(session.compactPostedByEpoch?.[1]).toEqual({ pre: false, post: true });
  });

  // Main's fallback, pinned: a starting message is on the thread, so its
  // replacement is owed whatever the level — when chat.update fails, the
  // completion is posted fresh.
  it('compact START, switch to minimal, chat.update rejects: the completion is posted fresh (main fallback)', async () => {
    const session = track(makeSession(COMPACT));
    const slackApi = makeSlackApi();
    await postCompactStartingIfNeeded(deps(session, slackApi), 'auto');
    session.logVerbosity = LOG_MINIMAL;
    slackApi.updateMessage.mockRejectedValueOnce(new Error('message_not_found'));

    await postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' });

    expect(slackApi.updateMessage).toHaveBeenCalledTimes(1);
    expect(slackApi.postSystemMessage).toHaveBeenCalledTimes(2);
    expect(String(slackApi.postSystemMessage.mock.calls[1]?.[1])).toContain('Compaction completed');
    expectCycleSealed(session);
  });
});
