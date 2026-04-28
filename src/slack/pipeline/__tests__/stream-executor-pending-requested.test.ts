/**
 * stream-executor × pending-confirm × requested-state audit (#755 P1-3).
 *
 * Sealed contract: every model-emitted instructionOperations request that
 * the host queues for y/n confirmation gets exactly one
 * `state: 'requested'` lifecycleEvents row at queue-time, plus exactly one
 * terminal row ('confirmed' | 'rejected' | 'superseded' | 'manual') when
 * the user clicks (or the entry is evicted).
 *
 * This file pins the request-side half: `interceptInstructionOperationsForConfirm`
 * MUST call `claudeHandler.recordRequestedLifecycle` exactly once with the
 * derived lifecycle meta.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationSession, SessionResourceUpdateRequest } from '../../../types';
import { StreamExecutor } from '../stream-executor';

interface PendingStoreEntry {
  requestId: string;
  sessionKey: string;
  channelId: string;
  threadTs: string;
  payload: SessionResourceUpdateRequest;
  createdAt: number;
  requesterId: string;
  type: 'add' | 'link' | 'complete' | 'cancel' | 'rename';
  by: { type: 'slack-user'; id: string };
}

function mkSession(): ConversationSession {
  return {
    ownerId: 'U-OWN',
    userId: 'U-OWN',
    channelId: 'C-PR3',
    threadTs: 'T-PR3',
    currentInitiatorId: 'U-OWN',
    isActive: true,
    lastActivity: new Date(),
  } as ConversationSession;
}

function mkContext() {
  return {
    channel: 'C-PR3',
    threadTs: 'T-PR3',
    sessionKey: 'C-PR3|T-PR3',
    say: vi.fn(),
  };
}

function mkExecutor() {
  const recordRequestedLifecycle = vi.fn();
  const recordSupersededLifecycle = vi.fn();
  const slackApi = {
    postMessage: vi.fn().mockResolvedValue({ ts: 'posted-ts' }),
    updateMessage: vi.fn().mockResolvedValue(undefined),
  };
  const pendingStore = {
    set: vi.fn((entry: PendingStoreEntry) => undefined),
    updateMessageTs: vi.fn(),
    delete: vi.fn(),
  };
  const claudeHandler = {
    recordRequestedLifecycle,
    recordSupersededLifecycle,
  };
  const deps = {
    claudeHandler,
    slackApi,
    pendingInstructionConfirmStore: pendingStore,
  } as any;
  const executor = new StreamExecutor(deps);
  return { executor, recordRequestedLifecycle, recordSupersededLifecycle, pendingStore, slackApi };
}

describe('stream-executor pending-requested audit (#755 P1-3)', () => {
  it('records exactly one state="requested" lifecycle row when an add request is queued', async () => {
    const { executor, recordRequestedLifecycle, pendingStore } = mkExecutor();
    const session = mkSession();
    const context = mkContext();

    const request: SessionResourceUpdateRequest = {
      instructionOperations: [{ action: 'add', text: 'queued write' }],
    };

    await (executor as any).interceptInstructionOperationsForConfirm(request, session, context);

    expect(pendingStore.set).toHaveBeenCalledTimes(1);
    expect(recordRequestedLifecycle).toHaveBeenCalledTimes(1);

    // The meta passed to recordRequestedLifecycle must match the entry we
    // just queued — same requestId, same lifecycle type, same actor.
    const setEntry = pendingStore.set.mock.calls[0][0] as PendingStoreEntry;
    const metaArg = recordRequestedLifecycle.mock.calls[0][1] as {
      requestId: string;
      type: string;
      by: { type: string; id: string };
      ops: unknown[];
    };
    expect(metaArg.requestId).toBe(setEntry.requestId);
    expect(metaArg.type).toBe('add');
    expect(metaArg.by).toEqual({ type: 'slack-user', id: 'U-OWN' });
    expect(metaArg.ops).toEqual([{ action: 'add', text: 'queued write' }]);
  });

  it('records the requested row for non-add lifecycle ops (cancel)', async () => {
    const { executor, recordRequestedLifecycle } = mkExecutor();
    const session = mkSession();
    const context = mkContext();

    const request: SessionResourceUpdateRequest = {
      instructionOperations: [{ action: 'cancel', id: 'inst-X' }],
    };

    await (executor as any).interceptInstructionOperationsForConfirm(request, session, context);

    expect(recordRequestedLifecycle).toHaveBeenCalledTimes(1);
    const metaArg = recordRequestedLifecycle.mock.calls[0][1] as { type: string };
    expect(metaArg.type).toBe('cancel');
  });

  // -------------------------------------------------------------------------
  // PR2 fix loop #2 P1-C — orphan audit on Slack-post failure.
  //
  // Pre-fix `recordRequestedLifecycle` was written BEFORE the Slack post,
  // and the failure path deleted the pending entry without writing a
  // terminal audit row. Result: lifecycleEvents had a 'requested' row
  // with no 'rejected'/'superseded'/'confirmed' counterpart — orphan audit.
  //
  // Sealed contract (option a): "requested" semantically means "user has
  // been asked". When the Slack post fails the user was never asked, so
  // NO 'requested' row must be written. The store entry is still cleaned
  // up (existing behaviour at stream-executor.ts:3081).
  // -------------------------------------------------------------------------
  it('does NOT record a requested lifecycle row when Slack post fails (P1-C orphan-audit fix)', async () => {
    const { executor, recordRequestedLifecycle, pendingStore, slackApi } = mkExecutor();
    slackApi.postMessage = vi.fn().mockRejectedValue(new Error('slack rate limited'));
    const session = mkSession();
    const context = mkContext();

    const request: SessionResourceUpdateRequest = {
      instructionOperations: [{ action: 'add', text: 'queued write' }],
    };

    await (executor as any).interceptInstructionOperationsForConfirm(request, session, context);

    // Slack post failed — the audit log must NOT carry a 'requested' row
    // because the user was never actually asked. Otherwise the dashboard
    // shows an orphan 'requested' with no terminal counterpart.
    expect(recordRequestedLifecycle).not.toHaveBeenCalled();

    // Cleanup invariant: the dangling pending-store entry is dropped so a
    // future click cannot resolve against it.
    expect(pendingStore.delete).toHaveBeenCalledTimes(1);
  });

  it('records the requested row only AFTER Slack post resolves successfully', async () => {
    // Capture call order across slackApi.postMessage and recordRequestedLifecycle.
    const calls: string[] = [];
    const recordRequestedLifecycle = vi.fn(() => {
      calls.push('record');
    });
    const recordSupersededLifecycle = vi.fn();
    const slackApi = {
      postMessage: vi.fn(async () => {
        calls.push('post');
        return { ts: 'posted-ts' };
      }),
      updateMessage: vi.fn().mockResolvedValue(undefined),
    };
    const pendingStore = {
      set: vi.fn(() => undefined),
      updateMessageTs: vi.fn(),
      delete: vi.fn(),
    };
    const claudeHandler = { recordRequestedLifecycle, recordSupersededLifecycle };
    const executor = new StreamExecutor({
      claudeHandler,
      slackApi,
      pendingInstructionConfirmStore: pendingStore,
    } as any);

    const session = mkSession();
    const context = mkContext();
    const request: SessionResourceUpdateRequest = {
      instructionOperations: [{ action: 'add', text: 'queued write' }],
    };

    await (executor as any).interceptInstructionOperationsForConfirm(request, session, context);

    expect(recordRequestedLifecycle).toHaveBeenCalledTimes(1);
    // The audit row must NOT precede the Slack post — pre-fix it did.
    expect(calls).toEqual(['post', 'record']);
  });
});
