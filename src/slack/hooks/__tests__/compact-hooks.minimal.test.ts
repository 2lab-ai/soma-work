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

import { setStreamExecutorProviders } from '@soma/slack/pipeline/stream-executor';
import type { WorkLogInput } from '@soma/slack/work-log';
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

/**
 * Spec 10 §3.3 — compaction notices are conversation-level: compact-hooks
 * records them against `session.conversationId` through the one global path
 * (`recordConversationWorkLog` → `streamExecutorProviders.appendWorkLog`), with
 * no turn involved. Exactly one start and one completion per cycle, whichever
 * path signals, at every level; Slack posting is unchanged (gating above).
 */
describe('compaction work-log notices: one start and one completion per cycle', () => {
  const recorded: Array<[string, WorkLogInput]> = [];
  setStreamExecutorProviders({
    appendWorkLog: (conversationId, entry) => {
      recorded.push([conversationId, entry]);
    },
  });
  afterEach(() => {
    recorded.length = 0;
  });

  /** `conversationId: null` = a session with no conversation. */
  function conversationSession(mask: unknown, conversationId: string | null = 'conv-1') {
    const session = track(makeSession(mask));
    if (conversationId) session.conversationId = conversationId;
    return { session, slackApi: makeSlackApi() };
  }
  const notices = () => recorded.map(([conversationId, entry]) => ({ conversationId, ...entry }));

  it.each([
    ['minimal', LOG_MINIMAL],
    ['compact', COMPACT],
  ])('%s: hook-only cycle (PreCompact + PostCompact)', async (_label, mask) => {
    const { session, slackApi } = conversationSession(mask);
    const hooks = buildCompactHooks(deps(session, slackApi));

    await hooks.PreCompact({ hook_event_name: 'PreCompact', trigger: 'auto' } as unknown as PreCompactHookInput);
    session.compactPreTokens = 160_000;
    session.compactPostTokens = 35_000;
    await hooks.PostCompact({ hook_event_name: 'PostCompact', trigger: 'auto' } as unknown as PostCompactHookInput);

    expect(notices()).toEqual([
      { conversationId: 'conv-1', kind: 'notice', text: 'Compaction starting', ts: expect.any(Number) },
      {
        conversationId: 'conv-1',
        kind: 'notice',
        text: 'Compaction completed · trigger=auto · 160000 → 35000 tokens',
        ts: expect.any(Number),
      },
    ]);
    expect(recorded.every(([, entry]) => entry.turnId === undefined)).toBe(true);
  });

  it.each([
    ['minimal', LOG_MINIMAL],
    ['compact', COMPACT],
  ])('%s: fallback-only cycle (compacting status twice + compact_boundary)', async (_label, mask) => {
    const { session, slackApi } = conversationSession(mask);

    await postCompactStartingIfNeeded(deps(session, slackApi), 'unknown (fallback)');
    await postCompactStartingIfNeeded(deps(session, slackApi), 'unknown (fallback)');
    session.compactTrigger = 'auto';
    await postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' });

    expect(notices().map((n) => n.text)).toEqual(['Compaction starting', 'Compaction completed · trigger=auto']);
  });

  it.each([
    ['minimal', LOG_MINIMAL],
    ['compact', COMPACT],
  ])('%s: both paths signal (hooks + fallbacks)', async (_label, mask) => {
    const { session, slackApi } = conversationSession(mask);
    const hooks = buildCompactHooks(deps(session, slackApi));

    await hooks.PreCompact({ hook_event_name: 'PreCompact', trigger: 'auto' } as unknown as PreCompactHookInput);
    await postCompactStartingIfNeeded(deps(session, slackApi), 'unknown (fallback)');
    session.compactPreTokens = 160_000;
    session.compactPostTokens = 35_000;
    session.compactTrigger = 'auto';
    await postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' });
    await hooks.PostCompact({ hook_event_name: 'PostCompact', trigger: 'auto' } as unknown as PostCompactHookInput);

    expect(notices().map((n) => n.text)).toEqual([
      'Compaction starting',
      'Compaction completed · trigger=auto · 160000 → 35000 tokens',
    ]);
  });

  it('two racing ENDs record one completion', async () => {
    const { session, slackApi } = conversationSession(COMPACT);
    await postCompactStartingIfNeeded(deps(session, slackApi), 'auto');

    await Promise.all([
      postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' }),
      postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' }),
    ]);

    expect(notices().filter((n) => n.text.startsWith('Compaction completed'))).toHaveLength(1);
  });

  it('recording needs no bound executing turn: a later PostCompact completion is still recorded', async () => {
    // No executing turn is bound anywhere — recording goes straight to the
    // conversation, so a completion arriving after START still lands.
    const { session, slackApi } = conversationSession(LOG_MINIMAL);
    await postCompactStartingIfNeeded(deps(session, slackApi), 'auto');
    await new Promise((resolve) => setTimeout(resolve, 0));

    await buildCompactHooks(deps(session, slackApi)).PostCompact({
      hook_event_name: 'PostCompact',
      trigger: 'manual',
    } as unknown as PostCompactHookInput);

    expect(notices().map((n) => n.text)).toEqual(['Compaction starting', 'Compaction completed · trigger=manual']);
  });

  it('a new cycle records its own pair', async () => {
    const { session, slackApi } = conversationSession(LOG_MINIMAL);
    for (let cycle = 0; cycle < 2; cycle++) {
      await postCompactStartingIfNeeded(deps(session, slackApi), 'auto');
      await postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' });
    }

    expect(notices().map((n) => n.text.split(' ·')[0])).toEqual([
      'Compaction starting',
      'Compaction completed',
      'Compaction starting',
      'Compaction completed',
    ]);
  });

  it('a throwing appendWorkLog provider is ignored — the cycle still seals', async () => {
    setStreamExecutorProviders({
      appendWorkLog: () => {
        throw new Error('disk full');
      },
    });
    try {
      const { session, slackApi } = conversationSession(LOG_MINIMAL);
      await postCompactStartingIfNeeded(deps(session, slackApi), 'auto');
      await postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' });
      expectCycleSealed(session);
    } finally {
      setStreamExecutorProviders({
        appendWorkLog: (conversationId, entry) => {
          recorded.push([conversationId, entry]);
        },
      });
    }
  });

  it('no conversationId: nothing is recorded', async () => {
    const { session, slackApi } = conversationSession(LOG_MINIMAL, null);
    expect(session.conversationId).toBeUndefined();

    await postCompactStartingIfNeeded(deps(session, slackApi), 'auto');
    await postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' });

    expect(recorded).toEqual([]);
    expectCycleSealed(session);
  });

  it.each([
    ['minimal', LOG_MINIMAL, 0],
    ['compact', COMPACT, 1],
  ])('%s: recording changes no Slack call', async (_label, mask, posts) => {
    const { session, slackApi } = conversationSession(mask);

    await postCompactStartingIfNeeded(deps(session, slackApi), 'auto');
    await postCompactCompleteIfNeeded(deps(session, slackApi), { source: 'on-compact-boundary' });

    expect(slackApi.postSystemMessage).toHaveBeenCalledTimes(posts);
    expect(slackApi.updateMessage).toHaveBeenCalledTimes(posts);
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
