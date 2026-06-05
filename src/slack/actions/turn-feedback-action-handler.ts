/**
 * Handles 👍/👎 clicks on the turn-completion feedback affordance (#1064).
 *
 * Action ID: `turn_feedback_v1` (registered in `src/slack/actions/index.ts`).
 * The button `value` encodes `up:<turnId>` / `down:<turnId>` — see
 * `@soma/slack/turn-feedback-block-builder`.
 *
 * Flow: parse sentiment+turnId → persist (idempotent upsert on turnId+userId)
 * → replace the feedback buttons with an acknowledgment line. The route wrapper
 * in `index.ts` calls `ack()` before delegating, so the 3s ACK is satisfied.
 */

import {
  buildFeedbackAckBlock,
  keepIconButtonsOnly,
  parseFeedbackValue,
} from '@soma/slack/turn-feedback-block-builder';
import type { TurnFeedbackStore } from '@soma/slack/turn-feedback-store';
import { Logger } from '../../logger';
import type { SlackApiHelper } from '../slack-api-helper';
import type { RespondFn } from './types';

export interface TurnFeedbackActionContext {
  slackApi: SlackApiHelper;
  store: TurnFeedbackStore;
}

export class TurnFeedbackActionHandler {
  private logger = new Logger('TurnFeedbackActionHandler');

  constructor(private ctx: TurnFeedbackActionContext) {}

  async handleFeedback(body: any, _respond: RespondFn): Promise<void> {
    const action = body?.actions?.[0];
    const parsed = parseFeedbackValue(action?.value);
    if (!parsed) {
      this.logger.warn('turn_feedback_v1: unparseable value', { value: action?.value });
      return;
    }

    const userId = body?.user?.id;
    if (!userId) {
      this.logger.warn('turn_feedback_v1: missing user id');
      return;
    }

    const channel = body?.channel?.id ?? body?.container?.channel_id;
    const messageTs = body?.message?.ts ?? body?.container?.message_ts;
    const threadTs = body?.message?.thread_ts ?? messageTs;
    if (!channel || !messageTs) {
      this.logger.warn('turn_feedback_v1: missing channel/message ts', {
        turnId: parsed.turnId,
        hasChannel: !!channel,
        hasMessageTs: !!messageTs,
      });
      return;
    }

    // Idempotent upsert — a repeated click stores the same record; a flipped
    // sentiment updates in place.
    this.ctx.store.record({
      turnId: parsed.turnId,
      userId,
      channel,
      threadTs,
      messageTs,
      category: 'WorkflowComplete',
      sentiment: parsed.sentiment,
    });

    // Acknowledge the feedback in place: insert a plain `context` ack block and
    // drop the answered `feedback_buttons` — but KEEP any `icon_button` (the 🗑
    // dismiss) so the card stays dismissible. Swapping interactive elements for
    // a plain `context` block also avoids stale `block_id` reuse (docs §1.2).
    const currentBlocks: any[] = Array.isArray(body?.message?.blocks) ? body.message.blocks : [];
    const ackBlock = buildFeedbackAckBlock(parsed.sentiment);
    const nextBlocks = currentBlocks.length
      ? currentBlocks.flatMap((b) => {
          if (b?.type !== 'context_actions') return [stripBlockId(b)];
          const iconsOnly = keepIconButtonsOnly(b);
          return iconsOnly ? [ackBlock, iconsOnly] : [ackBlock];
        })
      : [ackBlock];

    try {
      await this.ctx.slackApi.updateMessage(channel, messageTs, '🙏 피드백 감사합니다', nextBlocks);
    } catch (err) {
      // Persisted already — a failed cosmetic update must not lose the signal.
      this.logger.warn('turn_feedback_v1: failed to update message', {
        turnId: parsed.turnId,
        err: (err as Error)?.message ?? String(err),
      });
    }
  }
}

/**
 * Drop `block_id` from a block before re-sending it on `chat.update`. Slack
 * rejects an update that reuses a `block_id` that changed shape; the surviving
 * blocks are unchanged in shape so this is belt-and-suspenders for any block
 * Slack auto-assigned an id to on the original post.
 */
function stripBlockId(block: any): any {
  if (block && typeof block === 'object' && 'block_id' in block) {
    const { block_id: _omit, ...rest } = block;
    return rest;
  }
  return block;
}
