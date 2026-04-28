/**
 * Dashboard `[⋯]` propose-lifecycle handler factory (#758 PR4 fix loop #2).
 *
 * The dashboard's per-instruction menu posts to
 *   POST /api/dashboard/instructions/:id/propose-lifecycle
 * which forwards to a host-supplied `lifecycleProposeHandler`. This module
 * builds that handler with the production seams.
 *
 * Pre-fix the handler in `src/index.ts` synthesised a malformed pending
 * entry (no `instructionOperations`, `by.type='user'`, no Slack post). The
 * resulting `applyConfirmedLifecycle` call rejected with `INVALID_OP` even
 * if the user clicked y, and in practice the user never saw a y/n prompt at
 * all because no Slack message was posted.
 *
 * The fix:
 *   1. Build a sealed `payload.instructionOperations` from the dashboard op:
 *        - 'complete' → { action: 'complete', id, evidence }
 *        - 'cancel'   → { action: 'cancel', id }
 *        - 'rename'   → { action: 'rename', id, text }   (text from payload)
 *        - 'add'      → { action: 'add', text }          (text from payload)
 *        - 'link'     → { action: 'link', id, sessionKey } (sessionKey from payload)
 *   2. Use the sealed actor descriptor `{ type: 'slack-user', id: userId }`.
 *   3. Resolve a real Slack thread (channel + threadTs) from the
 *      instruction's first linked session and post the y/n confirm message
 *      there, then update `messageTs` on the pending entry so the y/n
 *      handler can later edit the post to the resolved state.
 *
 * If the instruction has no linked session, we throw — the dashboard route
 * surfaces a 5xx so the user knows the proposal could not be raised. Pre-fix
 * we silently created an unusable pending entry.
 */

import { randomUUID } from 'crypto';
import type { LifecycleProposeRequest } from './conversation/dashboard';
import { Logger } from './logger';
import type { LifecycleConfirmMeta, SessionRegistry } from './session-registry';
import type {
  PendingInstructionConfirm,
  PendingInstructionConfirmStore,
  PendingInstructionConfirmType,
} from './slack/actions/pending-instruction-confirm-store';
import {
  buildInstructionConfirmBlocks,
  buildInstructionConfirmFallbackText,
  buildInstructionSupersededBlocks,
} from './slack/instruction-confirm-blocks';
import type { ConversationSession, SessionInstructionOperation, SessionResourceUpdateRequest } from './types';
import { getUserSessionStore } from './user-session-store';

const logger = new Logger('DashboardLifecyclePropose');

/**
 * Minimal duck-typed Slack post seam — narrower than the full SlackApiHelper
 * so tests can supply a stub without faking enqueue queues.
 *
 * `updateMessage` mirrors `SlackApiHelper.updateMessage(channel, ts, text,
 * blocks?)` — used to mark a superseded pending message so the user does
 * not see two live y/n posts in the thread (parity with stream-executor
 * supersede branch).
 */
interface SlackPostSeam {
  postMessage(
    channel: string,
    text: string,
    options?: { blocks?: unknown[]; threadTs?: string; unfurlLinks?: boolean; unfurlMedia?: boolean },
  ): Promise<{ ts?: string; channel?: string }>;
  updateMessage(channel: string, ts: string, text: string, blocks?: unknown[]): Promise<void>;
}

/**
 * Minimal seam over SessionRegistry — the handler needs to resolve a
 * channelId/threadTs from a linked session key AND record the same
 * lifecycle audit rows the model path emits. The seam is duck-typed so
 * tests can inject a wrapper without booting the full registry.
 *
 * `recordRequestedLifecycle` and `recordSupersededLifecycle` mirror
 * stream-executor.ts:3037-3055 / :3119-3126 — failures are warn-logged
 * by the caller, not surfaced to the user, so the audit append never
 * reverts a successful Slack post (PR4 round-3 P1-NEW-AUDIT-REQUESTED /
 * P1-NEW-SUPERSEDE forgiveness parity).
 */
interface SessionResolver {
  getSessionByKey(sessionKey: string): ConversationSession | undefined;
  recordRequestedLifecycle(session: ConversationSession, meta: LifecycleConfirmMeta): void;
  recordSupersededLifecycle(session: ConversationSession, meta: LifecycleConfirmMeta): void;
}

export interface DashboardLifecycleProposeDeps {
  pendingStore: PendingInstructionConfirmStore;
  sessionRegistry:
    | Pick<SessionRegistry, 'getSessionByKey' | 'recordRequestedLifecycle' | 'recordSupersededLifecycle'>
    | SessionResolver;
  slackApi: SlackPostSeam;
  /**
   * Resolve the user-session doc to look up the instruction's linked
   * sessions. Defaults to `getUserSessionStore().load(userId)` so production
   * gets the real store; tests inject a stub.
   */
  loadUserDoc?: (userId: string) => { instructions: Array<{ id: string; linkedSessionIds: string[] }> } | null;
}

function buildOpsForDashboardOp(req: LifecycleProposeRequest): SessionInstructionOperation[] {
  const id = req.instructionId;
  // Dashboard payload is `unknown` per the route shape; we narrow defensively.
  const payload = (req.payload ?? {}) as { text?: unknown; sessionKey?: unknown; evidence?: unknown };
  switch (req.op) {
    case 'add': {
      const text = typeof payload.text === 'string' ? payload.text : '';
      return [{ action: 'add', text }];
    }
    case 'link': {
      const sessionKey = typeof payload.sessionKey === 'string' ? payload.sessionKey : '';
      return [{ action: 'link', id, sessionKey }];
    }
    case 'complete': {
      // Dashboard-initiated complete carries no model-level evidence; record
      // the source so the audit trail explains who closed it. The sealed
      // `evidence` field is required.
      const evidence =
        typeof payload.evidence === 'string' && payload.evidence.length > 0
          ? payload.evidence
          : 'Dashboard-initiated completion (user proposed via [⋯] menu)';
      return [{ action: 'complete', id, evidence }];
    }
    case 'cancel': {
      return [{ action: 'cancel', id }];
    }
    case 'rename': {
      const text = typeof payload.text === 'string' ? payload.text : '';
      return [{ action: 'rename', id, text }];
    }
  }
}

/**
 * Build the production `lifecycleProposeHandler` for `wireDashboardInstructionAccessors`.
 */
export function createDashboardLifecycleProposeHandler(
  deps: DashboardLifecycleProposeDeps,
): (req: LifecycleProposeRequest) => Promise<{ requestId: string }> {
  const loadUserDoc = deps.loadUserDoc ?? ((userId: string) => getUserSessionStore().load(userId));

  return async (req: LifecycleProposeRequest): Promise<{ requestId: string }> => {
    const requestId = `dash-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;

    // 1. Find the linked sessions for the instruction.
    const doc = loadUserDoc(req.userId);
    const inst = doc?.instructions.find((i) => i.id === req.instructionId);
    const linkedSessionKeys: string[] = inst?.linkedSessionIds ?? [];

    // 2. Pick the first linked session that resolves to a live thread.
    let resolved: { sessionKey: string; channelId: string; threadTs: string } | undefined;
    for (const sessionKey of linkedSessionKeys) {
      const live = deps.sessionRegistry.getSessionByKey(sessionKey);
      if (live?.channelId && live?.threadTs) {
        resolved = { sessionKey, channelId: live.channelId, threadTs: live.threadTs };
        break;
      }
    }

    if (!resolved) {
      // No thread to post the y/n in. Surface a clear error so the dashboard
      // returns 5xx rather than silently queueing an unconfirmable entry.
      // Manual-override (dashboard direct mutation, no Slack post) is #759.
      throw new Error(
        `Cannot post lifecycle proposal: instruction ${req.instructionId} has no linked session with a live Slack thread`,
      );
    }

    // 3. Build the sealed pending entry.
    const ops = buildOpsForDashboardOp(req);
    const lifecycleType: PendingInstructionConfirmType = req.op;

    const payloadForStore: SessionResourceUpdateRequest = {
      operations: [],
      instructionOperations: ops,
    };

    const entry: PendingInstructionConfirm = {
      requestId,
      sessionKey: resolved.sessionKey,
      channelId: resolved.channelId,
      threadTs: resolved.threadTs,
      messageTs: undefined,
      payload: payloadForStore,
      createdAt: Date.now(),
      requesterId: req.userId,
      type: lifecycleType,
      // Sealed actor: dashboard click is by the slack-authenticated user.
      by: { type: 'slack-user', id: req.userId },
    };

    const evicted = deps.pendingStore.set(entry);

    // 3a. Supersede parity (#758 PR4 round-3 P1-NEW-SUPERSEDE) — mirrors
    // stream-executor.ts:3037-3055. When `pendingStore.set` evicts a prior
    // entry for the same session, the audit log gets a 'superseded' row
    // for the dropped intent AND the old Slack message is chat.updated to
    // '[superseded]' so the user no longer has two live y/n posts in the
    // thread. Both calls are best-effort — the new proposal is the source
    // of truth and any failure is warn-logged.
    if (evicted) {
      const evictedSession = deps.sessionRegistry.getSessionByKey(evicted.sessionKey);
      if (evictedSession) {
        try {
          deps.sessionRegistry.recordSupersededLifecycle(evictedSession, {
            requestId: evicted.requestId,
            type: evicted.type,
            by: evicted.by,
            ops: evicted.payload.instructionOperations ?? [],
          });
        } catch (err) {
          logger.warn('Failed to record superseded lifecycle audit (dashboard)', {
            sessionKey: evicted.sessionKey,
            evictedRequestId: evicted.requestId,
            err,
          });
        }
      } else {
        logger.warn('Superseded entry: session no longer exists, skipping audit', {
          sessionKey: evicted.sessionKey,
          evictedRequestId: evicted.requestId,
        });
      }
      if (evicted.messageTs) {
        try {
          await deps.slackApi.updateMessage(
            evicted.channelId,
            evicted.messageTs,
            '⚠️ [superseded] — a newer instruction proposal replaced this one.',
            buildInstructionSupersededBlocks(evicted.payload),
          );
        } catch (err) {
          logger.warn('Failed to update superseded confirm message (dashboard)', {
            sessionKey: evicted.sessionKey,
            evictedRequestId: evicted.requestId,
            err,
          });
        }
      }
    }

    // 4. Post the y/n message to the resolved Slack thread.
    const blocks = buildInstructionConfirmBlocks(payloadForStore, requestId);
    const fallback = buildInstructionConfirmFallbackText(payloadForStore);
    let postSucceeded = false;
    try {
      const post = await deps.slackApi.postMessage(resolved.channelId, fallback, {
        threadTs: resolved.threadTs,
        blocks,
        unfurlLinks: false,
        unfurlMedia: false,
      });
      if (post.ts) {
        deps.pendingStore.updateMessageTs(requestId, post.ts);
        postSucceeded = true;
      } else {
        // No ts → the user can't click. Drop the entry and surface as failure.
        deps.pendingStore.delete(requestId);
        throw new Error('Slack post returned no ts — dashboard proposal not raised');
      }
    } catch (err) {
      // Best-effort cleanup: if the post fails the user can't confirm.
      deps.pendingStore.delete(requestId);
      throw err;
    }

    // 5. Audit-row parity (#758 PR4 round-3 P1-NEW-AUDIT-REQUESTED) — mirrors
    // stream-executor.ts:3119-3126. Append a `state: 'requested'`
    // lifecycleEvents row only after the Slack post has succeeded so that
    // 'requested' semantically means "the user was actually asked". Failure
    // here is warn-logged — the post already happened and the user can
    // still click; the dashboard latency calc just loses one data point.
    if (postSucceeded) {
      const session = deps.sessionRegistry.getSessionByKey(resolved.sessionKey);
      if (session) {
        try {
          deps.sessionRegistry.recordRequestedLifecycle(session, {
            requestId,
            type: lifecycleType,
            by: { type: 'slack-user', id: req.userId },
            ops: ops,
          });
        } catch (err) {
          logger.warn('Failed to record requested lifecycle audit (dashboard)', {
            sessionKey: resolved.sessionKey,
            requestId,
            err,
          });
        }
      } else {
        logger.warn('Requested-audit: session no longer exists, skipping', {
          sessionKey: resolved.sessionKey,
          requestId,
        });
      }
    }

    logger.info('Dashboard: lifecycle proposal enqueued + posted', {
      requestId,
      userId: req.userId,
      instructionId: req.instructionId,
      op: req.op,
      sessionKey: resolved.sessionKey,
      supersededPrior: !!evicted,
    });

    return { requestId };
  };
}
