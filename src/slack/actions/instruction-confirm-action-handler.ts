/**
 * Handles the y/n buttons produced by the user-instruction confirmation flow.
 *
 * `Yes` → commit the deferred `UPDATE_SESSION.instructionOperations` via
 *         `ClaudeHandler.updateSessionResources`. Clear the session's
 *         systemPrompt snapshot so the next turn rebuilds with the fresh
 *         SSOT.
 * `No`  → drop the proposal and set `session.pendingInstructionRejection`
 *         so the next stream-executor turn injects a rejection notice.
 *
 * Action IDs: `instr_confirm_y:<requestId>` / `instr_confirm_n:<requestId>`
 * — the prefix is matched by the router in `src/slack/actions/index.ts`.
 */

import type { ClaudeHandler } from '../../claude-handler';
import { Logger } from '../../logger';
import type { LifecycleConfirmMeta } from '../../session-registry';
import type { ConversationSession, SessionInstructionOperation, SessionResourceUpdateRequest } from '../../types';
import {
  buildInstructionAppliedBlocks,
  buildInstructionRejectedBlocks,
  INSTRUCTION_CONFIRM_NO_ACTION,
  INSTRUCTION_CONFIRM_YES_ACTION,
} from '../instruction-confirm-blocks';
import type { SlackApiHelper } from '../slack-api-helper';
import type { PendingInstructionConfirm, PendingInstructionConfirmStore } from './pending-instruction-confirm-store';
import type { RespondFn } from './types';

export interface InstructionConfirmActionContext {
  slackApi: SlackApiHelper;
  claudeHandler: ClaudeHandler;
  store: PendingInstructionConfirmStore;
}

export class InstructionConfirmActionHandler {
  private logger = new Logger('InstructionConfirmActionHandler');

  constructor(private ctx: InstructionConfirmActionContext) {}

  /**
   * Extract the `requestId` from the click payload. Tolerant of both
   * `action.value` (preferred) and the action_id suffix (`…:<requestId>`).
   */
  private parseRequestId(body: any): string | undefined {
    const action = body?.actions?.[0];
    if (!action) return undefined;
    if (typeof action.value === 'string' && action.value.length > 0) return action.value;
    if (typeof action.action_id === 'string') {
      const [, requestId] = action.action_id.split(':');
      if (requestId) return requestId;
    }
    return undefined;
  }

  async handleYes(body: any, _respond: RespondFn): Promise<void> {
    const requestId = this.parseRequestId(body);
    if (!requestId) {
      this.logger.warn('instr_confirm_y: missing requestId');
      return;
    }
    const entry = this.ctx.store.get(requestId);
    if (!entry) {
      this.logger.warn('instr_confirm_y: no pending entry', { requestId });
      return;
    }

    const session = this.ctx.claudeHandler.getSessionByKey(entry.sessionKey);
    if (!session) {
      this.logger.warn('instr_confirm_y: session not found — dropping pending entry', {
        requestId,
        sessionKey: entry.sessionKey,
      });
      this.ctx.store.delete(requestId);
      return;
    }

    // Owner guard — only the session owner or the user who originally
    // triggered this instruction write (snapshotted at queue time as
    // `entry.requesterId`) may approve. We deliberately do NOT consult
    // `session.currentInitiatorId` here: that field mutates every turn, so
    // a newer initiator would otherwise be able to approve a proposal
    // raised during someone else's turn.
    const clicker = body?.user?.id;
    if (clicker && session.ownerId !== clicker && entry.requesterId !== clicker) {
      this.logger.info('instr_confirm_y: non-owner click ignored', {
        clicker,
        ownerId: session.ownerId,
        requesterId: entry.requesterId,
      });
      return;
    }

    // Sealed (#755) y-confirm: commit a single 4-step lifecycle transaction
    // over the user master AND session pointer AND pending-store. The pending
    // entry's `type` and `by` are the authoritative metadata source
    // (snapshotted at queue time) so the audit row can never drift on later
    // session shifts. PR2 P1-1: the pending-store delete is now passed as a
    // callback that runs INSIDE the rollback envelope — pre-fix the delete
    // ran AFTER applyConfirmedLifecycle returned ok=true, so a delete failure
    // would leave the user master mutated with a stranded pending entry.
    const meta = this.buildLifecycleMeta(entry);
    const result = this.ctx.claudeHandler.applyConfirmedLifecycle(session, meta, () => {
      this.ctx.store.delete(requestId);
    });
    if (!result.ok) {
      this.logger.warn('instr_confirm_y: applyConfirmedLifecycle failed', {
        requestId,
        reason: result.reason,
        error: result.error,
      });
      // Leave the pending entry intact so the user can retry once the
      // underlying issue (corrupt store, ENOSPC, …) clears.
      return;
    }

    // applyConfirmedLifecycle already invalidates `session.systemPrompt`
    // on success — re-asserting here so a future contract change cannot
    // silently regress the prompt-cache invalidation.
    session.systemPrompt = undefined;

    // Terminal message — no buttons, just the applied summary. `block_id`
    // left unset so Slack assigns fresh ids (update requires unique ids —
    // docs/slack-block-kit.md §1.2).
    if (entry.messageTs) {
      try {
        await this.ctx.slackApi.updateMessage(
          entry.channelId,
          entry.messageTs,
          '✅ Instruction write applied.',
          buildInstructionAppliedBlocks(entry.request),
        );
      } catch (err) {
        this.logger.warn('instr_confirm_y: failed to update confirm message', {
          requestId,
          err,
        });
      }
    }
    // pending-store delete already happened inside applyConfirmedLifecycle.
  }

  async handleNo(body: any, _respond: RespondFn): Promise<void> {
    const requestId = this.parseRequestId(body);
    if (!requestId) {
      this.logger.warn('instr_confirm_n: missing requestId');
      return;
    }
    const entry = this.ctx.store.get(requestId);
    if (!entry) {
      this.logger.warn('instr_confirm_n: no pending entry', { requestId });
      return;
    }

    const session = this.ctx.claudeHandler.getSessionByKey(entry.sessionKey);
    if (session) {
      // Owner guard — same snapshot rule as handleYes.
      const clicker = body?.user?.id;
      if (clicker && session.ownerId !== clicker && entry.requesterId !== clicker) {
        this.logger.info('instr_confirm_n: non-owner click ignored', {
          clicker,
          ownerId: session.ownerId,
          requesterId: entry.requesterId,
        });
        return;
      }
      // Runtime-only flag — stream-executor consumes + clears on next turn.
      session.pendingInstructionRejection = { at: Date.now(), request: entry.request };

      // Sealed (#755) n-confirm: append a state='rejected' lifecycle audit
      // row on the user master. No data mutation.
      const meta = this.buildLifecycleMeta(entry);
      this.ctx.claudeHandler.recordRejectedLifecycle(session, meta);
    }

    if (entry.messageTs) {
      try {
        await this.ctx.slackApi.updateMessage(
          entry.channelId,
          entry.messageTs,
          '❌ Instruction write rejected.',
          buildInstructionRejectedBlocks(entry.request),
        );
      } catch (err) {
        this.logger.warn('instr_confirm_n: failed to update confirm message', {
          requestId,
          err,
        });
      }
    }

    this.ctx.store.delete(requestId);
  }

  /**
   * Build the sealed `LifecycleConfirmMeta` (#755) from a pending entry.
   * The entry's `type`/`by` were snapshotted at queue time by
   * stream-executor; the request's instructionOperations array is the
   * payload the SessionRegistry tx replays.
   */
  private buildLifecycleMeta(entry: PendingInstructionConfirm): LifecycleConfirmMeta {
    const ops: SessionInstructionOperation[] = entry.request.instructionOperations ?? [];
    return {
      requestId: entry.requestId,
      type: entry.type,
      by: entry.by,
      ops,
    };
  }

  /** Action ID prefixes — exposed for the ActionRouter. */
  static readonly ACTION_ID_YES_PREFIX = `${INSTRUCTION_CONFIRM_YES_ACTION}:`;
  static readonly ACTION_ID_NO_PREFIX = `${INSTRUCTION_CONFIRM_NO_ACTION}:`;
}
