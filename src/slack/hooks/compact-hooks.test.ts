import type { PostCompactHookInput, PreCompactHookInput, SessionStartHookInput } from '@anthropic-ai/claude-agent-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock compaction-context-builder before importing the module under test.
// buildCompactionContext returning a truthy string is what flips
// session.compactionOccurred in the SessionStart hook.
vi.mock('../../session/compaction-context-builder', () => ({
  buildCompactionContext: vi.fn().mockReturnValue('<compaction-context>…</compaction-context>'),
  snapshotFromSession: vi.fn().mockReturnValue({}),
}));

import type { ConversationSession } from '../../types';
import type { EventRouter } from '../event-router';
import type { SlackApiHelper } from '../slack-api-helper';
import { beginCompactionCycleIfNeeded, buildCompactHooks, getCurrentEpochForEnd } from './compact-hooks';

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
    autoCompactPending: false,
    pendingUserText: null,
    pendingEventContext: null,
    ...overrides,
  } as ConversationSession;
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
});

describe('buildCompactHooks — PreCompact (#617 AC4)', () => {
  let slackApi: { postSystemMessage: ReturnType<typeof vi.fn> };
  let session: ConversationSession;

  beforeEach(() => {
    slackApi = { postSystemMessage: vi.fn().mockResolvedValue(undefined) };
    session = makeSession({ lastKnownUsagePct: 82 });
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

  it('AC4: posts "starting · trigger=manual" and bumps epoch + snapshots preCompactUsagePct', async () => {
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
    expect(slackApi.postSystemMessage).toHaveBeenCalledWith('C1', '🗜️ Compaction starting · trigger=manual', {
      threadTs: 'T1',
    });
    expect(session.compactPostedByEpoch?.[1]?.pre).toBe(true);
  });

  it('AC4: posts "trigger=auto" for auto trigger', async () => {
    const hooks = buildCompactHooks({
      session,
      channel: 'C1',
      threadTs: 'T1',
      slackApi: slackApi as unknown as SlackApiHelper,
    });
    await hooks.PreCompact(payloadOf('auto') as any);
    expect(slackApi.postSystemMessage).toHaveBeenCalledWith('C1', '🗜️ Compaction starting · trigger=auto', {
      threadTs: 'T1',
    });
  });

  it('AC4: second PreCompact call inside same cycle does NOT re-post (pre=true dedupe)', async () => {
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
});

describe('buildCompactHooks — PostCompact (#617 AC5)', () => {
  let slackApi: { postSystemMessage: ReturnType<typeof vi.fn> };
  let eventRouter: { dispatchPendingUserMessage: ReturnType<typeof vi.fn> };
  let session: ConversationSession;

  beforeEach(() => {
    slackApi = { postSystemMessage: vi.fn().mockResolvedValue(undefined) };
    eventRouter = { dispatchPendingUserMessage: vi.fn().mockResolvedValue(undefined) };
    session = makeSession({ preCompactUsagePct: 83, lastKnownUsagePct: 45 });
    // Open a cycle so PostCompact has a marker to flip.
    beginCompactionCycleIfNeeded(session);
    session.compactPostedByEpoch![1].pre = true;
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

  it('AC5: posts "complete · was ~83% → now ~45%" on first PostCompact call', async () => {
    const hooks = buildCompactHooks({
      session,
      channel: 'C1',
      threadTs: 'T1',
      slackApi: slackApi as unknown as SlackApiHelper,
      eventRouter: eventRouter as unknown as EventRouter,
    });
    await hooks.PostCompact(postPayload() as any);
    expect(slackApi.postSystemMessage).toHaveBeenCalledWith('C1', '✅ Compaction complete · was ~83% → now ~45%', {
      threadTs: 'T1',
    });
    expect(session.compactPostedByEpoch?.[1]?.post).toBe(true);
    expect(session.autoCompactPending).toBe(false);
  });

  it('AC5: falls back to "?" when preCompactUsagePct is null', async () => {
    session.preCompactUsagePct = null;
    session.lastKnownUsagePct = 30;
    const hooks = buildCompactHooks({
      session,
      channel: 'C1',
      threadTs: 'T1',
      slackApi: slackApi as unknown as SlackApiHelper,
    });
    await hooks.PostCompact(postPayload() as any);
    expect(slackApi.postSystemMessage).toHaveBeenCalledWith('C1', '✅ Compaction complete · was ~?% → now ~30%', {
      threadTs: 'T1',
    });
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
    expect(slackApi.postSystemMessage).toHaveBeenCalledTimes(1);
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
