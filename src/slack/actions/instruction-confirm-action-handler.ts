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
import {
  buildInstructionAppliedBlocks,
  buildInstructionRejectedBlocks,
  INSTRUCTION_CONFIRM_NO_ACTION,
  INSTRUCTION_CONFIRM_YES_ACTION,
} from '../instruction-confirm-blocks';
import type { SlackApiHelper } from '../slack-api-helper';
import type { PendingInstructionConfirmStore } from './pending-instruction-confirm-store';
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

    // Owner guard — only the session owner (or the current initiator) may
    // approve. Matches the compact-confirm UX.
    const clicker = body?.user?.id;
    if (clicker && session.ownerId !== clicker && session.currentInitiatorId !== clicker) {
      this.logger.info('instr_confirm_y: non-owner click ignored', {
        clicker,
        ownerId: session.ownerId,
      });
      return;
    }

    const result = this.ctx.claudeHandler.updateSessionResources(session.channelId, session.threadTs, entry.request);
    if (!result.ok) {
      this.logger.warn('instr_confirm_y: updateSessionResources failed', {
        requestId,
        reason: result.reason,
        error: result.error,
      });
      return;
    }

    // Snapshot invalidation — next claude-handler call rebuilds the prompt
    // with the new SSOT. See PLAN §2.
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

    this.ctx.store.delete(requestId);
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
      const clicker = body?.user?.id;
      if (clicker && session.ownerId !== clicker && session.currentInitiatorId !== clicker) {
        this.logger.info('instr_confirm_n: non-owner click ignored', { clicker });
        return;
      }
      // Runtime-only flag — stream-executor consumes + clears on next turn.
      session.pendingInstructionRejection = { at: Date.now(), request: entry.request };
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

  /** Action ID prefixes — exposed for the ActionRouter. */
  static readonly ACTION_ID_YES_PREFIX = `${INSTRUCTION_CONFIRM_YES_ACTION}:`;
  static readonly ACTION_ID_NO_PREFIX = `${INSTRUCTION_CONFIRM_NO_ACTION}:`;
}
