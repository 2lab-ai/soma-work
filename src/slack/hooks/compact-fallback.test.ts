/**
 * #617 AC4 fallback — when the SDK `PreCompact` hook never fires, the
 * `status === 'compacting'` stream signal in stream-executor must still
 * post a thread-visible "starting" message and mark the epoch.
 *
 * The fallback code lives in `stream-executor.ts:836-861` (onStatusUpdate
 * branch). These tests reproduce that exact sequence against the shared
 * epoch helpers and `slackApi.postSystemMessage` mock to verify:
 *
 *   1. PreCompact never fires → fallback posts once, epoch bumped, pre=true.
 *   2. PreCompact fires first  → fallback sees pre=true → skips (no duplicate).
 *
 * We reproduce the sequence inline (vs. booting StreamExecutor) because the
 * full executor requires ~15 unrelated deps; the invariant under test is the
 * epoch/marker contract, not the executor plumbing.
 */

import type { PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../session/compaction-context-builder', () => ({
  buildCompactionContext: vi.fn().mockReturnValue('<context/>'),
  snapshotFromSession: vi.fn().mockReturnValue({}),
}));

import type { ConversationSession } from '../../types';
import type { SlackApiHelper } from '../slack-api-helper';
import { beginCompactionCycleIfNeeded, buildCompactHooks } from './compact-hooks';

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
    autoCompactPending: false,
    pendingUserText: null,
    pendingEventContext: null,
  } as ConversationSession;
}

/**
 * Inline replica of the fallback block at stream-executor.ts:844-861.
 * Keeps tests honest — any divergence from the real block will be caught
 * when the fallback test is re-read against the source.
 */
async function runCompactingFallback(
  session: ConversationSession,
  slackApi: { postSystemMessage: ReturnType<typeof vi.fn> },
): Promise<void> {
  const epoch = beginCompactionCycleIfNeeded(session);
  const marker = (session.compactPostedByEpoch ??= {})[epoch];
  if (marker && !marker.pre) {
    session.preCompactUsagePct = session.lastKnownUsagePct ?? null;
    await (slackApi.postSystemMessage as (...args: any[]) => Promise<void>)(
      'C1',
      '🗜️ Compaction starting · trigger=unknown (fallback)',
      { threadTs: 'T1' },
    );
    marker.pre = true;
  }
}

describe('PreCompact fallback via status="compacting" (#617 AC4 fallback)', () => {
  let slackApi: { postSystemMessage: ReturnType<typeof vi.fn> };
  let session: ConversationSession;

  beforeEach(() => {
    slackApi = { postSystemMessage: vi.fn().mockResolvedValue(undefined) };
    session = makeSession();
  });

  it('AC4 fallback: PreCompact never fires → fallback posts once, epoch bumped, pre=true', async () => {
    await runCompactingFallback(session, slackApi);

    expect(session.compactEpoch).toBe(1);
    expect(session.compactPostedByEpoch?.[1]?.pre).toBe(true);
    expect(session.preCompactUsagePct).toBe(70); // snapshotted from lastKnownUsagePct
    expect(slackApi.postSystemMessage).toHaveBeenCalledWith(
      'C1',
      '🗜️ Compaction starting · trigger=unknown (fallback)',
      { threadTs: 'T1' },
    );
    expect(slackApi.postSystemMessage).toHaveBeenCalledTimes(1);
  });

  it('AC4 fallback: PreCompact fires first → fallback sees pre=true → skips (idempotent by epoch pre flag)', async () => {
    // 1. PreCompact hook fires first (primary path).
    const hooks = buildCompactHooks({
      session,
      channel: 'C1',
      threadTs: 'T1',
      slackApi: slackApi as unknown as SlackApiHelper,
    });
    const payload: PreCompactHookInput = {
      session_id: 'sess-1',
      transcript_path: '/tmp/t',
      cwd: '/tmp',
      hook_event_name: 'PreCompact',
      trigger: 'manual',
      custom_instructions: null,
    } as unknown as PreCompactHookInput;

    await hooks.PreCompact(payload as any);
    expect(slackApi.postSystemMessage).toHaveBeenCalledTimes(1);
    expect(slackApi.postSystemMessage.mock.calls[0][1]).toContain('trigger=manual');

    // 2. Then the `compacting` status event arrives — fallback must skip.
    await runCompactingFallback(session, slackApi);

    // Still exactly one post; no "(fallback)" duplicate.
    expect(slackApi.postSystemMessage).toHaveBeenCalledTimes(1);
    expect(slackApi.postSystemMessage.mock.calls[0][1]).not.toContain('fallback');
  });

  it('AC4 fallback: reverse order — fallback first then PreCompact → only fallback post (hook dedupes)', async () => {
    await runCompactingFallback(session, slackApi);
    expect(slackApi.postSystemMessage).toHaveBeenCalledTimes(1);

    // Now the real PreCompact hook fires later; it must see pre=true and skip.
    const hooks = buildCompactHooks({
      session,
      channel: 'C1',
      threadTs: 'T1',
      slackApi: slackApi as unknown as SlackApiHelper,
    });
    const payload: PreCompactHookInput = {
      session_id: 'sess-1',
      transcript_path: '/tmp/t',
      cwd: '/tmp',
      hook_event_name: 'PreCompact',
      trigger: 'manual',
      custom_instructions: null,
    } as unknown as PreCompactHookInput;

    await hooks.PreCompact(payload as any);
    expect(slackApi.postSystemMessage).toHaveBeenCalledTimes(1);
    expect(slackApi.postSystemMessage.mock.calls[0][1]).toContain('fallback');
  });

  it('AC4 fallback: second fallback invocation inside same open cycle does NOT re-post', async () => {
    await runCompactingFallback(session, slackApi);
    await runCompactingFallback(session, slackApi);
    expect(slackApi.postSystemMessage).toHaveBeenCalledTimes(1);
  });
});
