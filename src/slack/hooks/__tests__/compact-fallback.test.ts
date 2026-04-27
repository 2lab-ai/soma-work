/**
 * #617 AC4 fallback — when the SDK `PreCompact` hook never fires, the
 * `status === 'compacting'` stream signal in stream-executor must still
 * post a thread-visible "starting" message and mark the epoch.
 *
 * The fallback code lives in `stream-executor.ts::onStatusUpdate('compacting')`
 * and calls `postCompactStartingIfNeeded` with the `'unknown (fallback)'`
 * trigger. Since this function is the actual SUT, these tests invoke it
 * directly (rather than an inline replica) so any drift between "what the
 * fallback posts" and "what the real code posts" is caught immediately.
 *
 * Regression follow-up (#617 v2): the literal `trigger=unknown (fallback)`
 * noise was removed — when trigger is unknown we drop the `· trigger=…`
 * segment entirely rather than print a lie.
 */

import type { PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../session/compaction-context-builder', () => ({
  buildCompactionContext: vi.fn().mockReturnValue('<context/>'),
  snapshotFromSession: vi.fn().mockReturnValue({}),
}));

import type { ConversationSession } from '../../../types';
import type { SlackApiHelper } from '../../slack-api-helper';
import { buildCompactHooks, postCompactStartingIfNeeded } from '../compact-hooks';

function makeSession(): ConversationSession {
  return {
    channelId: 'C1',
    threadTs: 'T1',
    compactionCount: 0,
    compactEpoch: 0,
    compactPostedByEpoch: {},
    compactionRehydratedByEpoch: {},
    preCompactUsagePct: null,
    lastKnownUsagePct: 70,
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
  } as ConversationSession;
}

function stopTicker(session: ConversationSession): void {
  if (session.compactTickInterval) {
    clearInterval(session.compactTickInterval);
    session.compactTickInterval = undefined;
  }
}

describe('PreCompact fallback via status="compacting" (#617 AC4 fallback, v2)', () => {
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
    session = makeSession();
  });

  afterEach(() => {
    stopTicker(session);
  });

  const preCompactPayload = (trigger: 'manual' | 'auto'): PreCompactHookInput =>
    ({
      session_id: 'sess-1',
      transcript_path: '/tmp/t',
      cwd: '/tmp',
      hook_event_name: 'PreCompact',
      trigger,
      custom_instructions: null,
    }) as unknown as PreCompactHookInput;

  it('AC4 v2: fallback posts "⏳ 🗜️ Compaction starting" (no trigger suffix for unknown)', async () => {
    await postCompactStartingIfNeeded(
      { session, channel: 'C1', threadTs: 'T1', slackApi: slackApi as unknown as SlackApiHelper },
      'unknown (fallback)',
    );

    expect(session.compactEpoch).toBe(1);
    expect(session.compactPostedByEpoch?.[1]?.pre).toBe(true);
    expect(session.preCompactUsagePct).toBe(70); // snapshotted from lastKnownUsagePct
    expect(slackApi.postSystemMessage).toHaveBeenCalledWith('C1', '⏳ 🗜️ Compaction starting', { threadTs: 'T1' });
    expect(slackApi.postSystemMessage).toHaveBeenCalledTimes(1);
  });

  it('AC4 v2: PreCompact fires first → fallback sees pre=true → skips (no duplicate post)', async () => {
    // 1. PreCompact hook fires first (primary path) with the REAL trigger.
    const hooks = buildCompactHooks({
      session,
      channel: 'C1',
      threadTs: 'T1',
      slackApi: slackApi as unknown as SlackApiHelper,
    });
    await hooks.PreCompact(preCompactPayload('manual') as any);
    expect(slackApi.postSystemMessage).toHaveBeenCalledTimes(1);
    expect(slackApi.postSystemMessage.mock.calls[0][1]).toContain('trigger=manual');

    // 2. Then the `compacting` status event arrives — fallback must skip.
    await postCompactStartingIfNeeded(
      { session, channel: 'C1', threadTs: 'T1', slackApi: slackApi as unknown as SlackApiHelper },
      'unknown (fallback)',
    );

    // Still exactly one post; no fallback duplicate.
    expect(slackApi.postSystemMessage).toHaveBeenCalledTimes(1);
    expect(slackApi.postSystemMessage.mock.calls[0][1]).toContain('trigger=manual');
  });

  it('AC4 v2: reverse order — fallback first then PreCompact → only fallback post (hook dedupes)', async () => {
    await postCompactStartingIfNeeded(
      { session, channel: 'C1', threadTs: 'T1', slackApi: slackApi as unknown as SlackApiHelper },
      'unknown (fallback)',
    );
    expect(slackApi.postSystemMessage).toHaveBeenCalledTimes(1);
    expect(slackApi.postSystemMessage.mock.calls[0][1]).toBe('⏳ 🗜️ Compaction starting');

    // Now the real PreCompact hook fires later; it must see pre=true and skip.
    const hooks = buildCompactHooks({
      session,
      channel: 'C1',
      threadTs: 'T1',
      slackApi: slackApi as unknown as SlackApiHelper,
    });
    await hooks.PreCompact(preCompactPayload('manual') as any);

    expect(slackApi.postSystemMessage).toHaveBeenCalledTimes(1);
  });

  it('AC4 v2: second fallback invocation inside same open cycle does NOT re-post', async () => {
    await postCompactStartingIfNeeded(
      { session, channel: 'C1', threadTs: 'T1', slackApi: slackApi as unknown as SlackApiHelper },
      'unknown (fallback)',
    );
    await postCompactStartingIfNeeded(
      { session, channel: 'C1', threadTs: 'T1', slackApi: slackApi as unknown as SlackApiHelper },
      'unknown (fallback)',
    );
    expect(slackApi.postSystemMessage).toHaveBeenCalledTimes(1);
  });
});
