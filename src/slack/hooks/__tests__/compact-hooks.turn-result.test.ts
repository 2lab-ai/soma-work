/**
 * Dashboard SSOT 2026-10-27 T2 — a compaction's END hands its numbers to the
 * conversation recorder (through `recordConversationCompact` →
 * `streamExecutorProviders.recordCompactResult`), once per cycle, whichever
 * path signals. The recorder writes them onto the `/compact` turn.
 */

import type { PostCompactHookInput, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
import { LOG_MINIMAL } from '@soma/slack/output-flags';
import {
  type CompactTurnResult,
  resetWorkLogDropWarningsForTests,
  setStreamExecutorProviders,
} from '@soma/slack/pipeline/stream-executor';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../session/compaction-context-builder', () => ({
  buildCompactionContext: vi.fn().mockReturnValue('<compaction-context/>'),
  snapshotFromSession: vi.fn().mockReturnValue({}),
}));

import type { ConversationSession } from '../../../types';
import type { SlackApiHelper } from '../../slack-api-helper';
import { buildCompactHooks, postCompactCompleteIfNeeded, postCompactStartingIfNeeded } from '../compact-hooks';

const sessions: ConversationSession[] = [];
function makeSession(conversationId: string | null = 'conv-1'): ConversationSession {
  const session = {
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
    logVerbosity: LOG_MINIMAL,
    ...(conversationId ? { conversationId } : {}),
  } as unknown as ConversationSession;
  sessions.push(session);
  return session;
}
function deps(session: ConversationSession) {
  const slackApi = {
    postSystemMessage: vi.fn().mockResolvedValue({ ts: 'start_ts' }),
    updateMessage: vi.fn().mockResolvedValue(undefined),
  };
  return { session, channel: 'C1', threadTs: 'T1', slackApi: slackApi as unknown as SlackApiHelper };
}

const results: Array<[string, CompactTurnResult]> = [];
setStreamExecutorProviders({
  recordCompactResult: (conversationId, result) => {
    results.push([conversationId, result]);
  },
});
afterEach(() => {
  results.length = 0;
  for (const s of sessions.splice(0)) if (s.compactTickInterval) clearInterval(s.compactTickInterval);
  resetWorkLogDropWarningsForTests();
});

describe('T2.1 — the compaction result reaches the recorder once per cycle', () => {
  it('hooks + fallback both signal → one result with the SDK numbers', async () => {
    const session = makeSession();
    const hooks = buildCompactHooks(deps(session));
    await hooks.PreCompact({ hook_event_name: 'PreCompact', trigger: 'manual' } as unknown as PreCompactHookInput);
    await postCompactStartingIfNeeded(deps(session), 'unknown (fallback)');
    session.compactPreTokens = 182_340;
    session.compactPostTokens = 31_020;
    session.compactTrigger = 'manual';
    session.compactDurationMs = 134_000;
    await postCompactCompleteIfNeeded(deps(session), { source: 'on-compact-boundary' });
    await hooks.PostCompact({ hook_event_name: 'PostCompact', trigger: 'manual' } as unknown as PostCompactHookInput);

    expect(results).toEqual([
      [
        'conv-1',
        {
          endedAt: expect.any(Number),
          durationMs: 134_000,
          preTokens: 182_340,
          postTokens: 31_020,
          trigger: 'manual',
        },
      ],
    ]);
  });

  it('the boundary lands after the hook sealed the cycle without numbers → they reach the recorder', async () => {
    const session = makeSession();
    const hooks = buildCompactHooks(deps(session));
    await hooks.PreCompact({ hook_event_name: 'PreCompact', trigger: 'auto' } as unknown as PreCompactHookInput);
    await hooks.PostCompact({ hook_event_name: 'PostCompact', trigger: 'auto' } as unknown as PostCompactHookInput);
    expect(results).toHaveLength(1);
    expect(results[0][1].preTokens).toBeUndefined();

    session.compactPreTokens = 160_000;
    session.compactPostTokens = 35_000;
    session.compactDurationMs = 41_000;
    await postCompactCompleteIfNeeded(deps(session), { source: 'on-compact-boundary' });
    expect(results).toHaveLength(2);
    expect(results[1][1]).toMatchObject({ preTokens: 160_000, postTokens: 35_000, durationMs: 41_000 });
  });

  it('no SDK duration → the time since START', async () => {
    const session = makeSession();
    await postCompactStartingIfNeeded(deps(session), 'auto');
    session.compactStartedAtMs = Date.now() - 42_000;
    await postCompactCompleteIfNeeded(deps(session), { source: 'on-compact-boundary' });

    expect(results).toHaveLength(1);
    const [, r] = results[0];
    expect(r.durationMs).toBeGreaterThanOrEqual(42_000);
    expect(r.durationMs).toBeLessThan(60_000);
    expect(r.preTokens).toBeUndefined();
  });

  it('a session with no conversation records nothing', async () => {
    const session = makeSession(null);
    await postCompactStartingIfNeeded(deps(session), 'auto');
    await postCompactCompleteIfNeeded(deps(session), { source: 'on-compact-boundary' });
    expect(results).toEqual([]);
  });

  it('a throwing provider is ignored — the cycle still seals', async () => {
    setStreamExecutorProviders({
      recordCompactResult: () => {
        throw new Error('disk full');
      },
    });
    try {
      const session = makeSession();
      await postCompactStartingIfNeeded(deps(session), 'auto');
      await postCompactCompleteIfNeeded(deps(session), { source: 'on-compact-boundary' });
      expect(session.compactPostedByEpoch?.[session.compactEpoch ?? 0]).toEqual({ pre: true, post: true });
      expect(session.autoCompactPending).toBe(false);
    } finally {
      setStreamExecutorProviders({
        recordCompactResult: (conversationId, result) => {
          results.push([conversationId, result]);
        },
      });
    }
  });
});
