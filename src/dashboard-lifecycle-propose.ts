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
import type { SessionRegistry } from './session-registry';
import type {
  PendingInstructionConfirm,
  PendingInstructionConfirmStore,
  PendingInstructionConfirmType,
} from './slack/actions/pending-instruction-confirm-store';
import { buildInstructionConfirmBlocks, buildInstructionConfirmFallbackText } from './slack/instruction-confirm-blocks';
import type { SessionInstructionOperation, SessionResourceUpdateRequest } from './types';
import { getUserSessionStore } from './user-session-store';

const logger = new Logger('DashboardLifecyclePropose');

/**
 * Minimal duck-typed Slack post seam — narrower than the full SlackApiHelper
 * so tests can supply a stub without faking enqueue queues.
 */
interface SlackPostSeam {
  postMessage(
    channel: string,
    text: string,
    options?: { blocks?: unknown[]; threadTs?: string; unfurlLinks?: boolean; unfurlMedia?: boolean },
  ): Promise<{ ts?: string; channel?: string }>;
}

/**
 * Minimal seam over SessionRegistry — the handler needs to resolve a
 * channelId/threadTs from a linked session key, but does not need any of
 * the mutation methods.
 */
interface SessionResolver {
  getSessionByKey(sessionKey: string): { channelId: string; threadTs: string } | undefined;
}

export interface DashboardLifecycleProposeDeps {
  pendingStore: PendingInstructionConfirmStore;
  sessionRegistry: Pick<SessionRegistry, 'getSessionByKey'> | SessionResolver;
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

    deps.pendingStore.set(entry);

    // 4. Post the y/n message to the resolved Slack thread.
    const blocks = buildInstructionConfirmBlocks(payloadForStore, requestId);
    const fallback = buildInstructionConfirmFallbackText(payloadForStore);
    try {
      const post = await deps.slackApi.postMessage(resolved.channelId, fallback, {
        threadTs: resolved.threadTs,
        blocks,
        unfurlLinks: false,
        unfurlMedia: false,
      });
      if (post.ts) {
        deps.pendingStore.updateMessageTs(requestId, post.ts);
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

    logger.info('Dashboard: lifecycle proposal enqueued + posted', {
      requestId,
      userId: req.userId,
      instructionId: req.instructionId,
      op: req.op,
      sessionKey: resolved.sessionKey,
    });

    return { requestId };
  };
}
