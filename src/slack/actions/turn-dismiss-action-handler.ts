/**
 * Handles the 🗑 dismiss `icon_button` on the turn-completion card (#1064).
 *
 * Action ID: `turn_dismiss_v1` (registered in `src/slack/actions/index.ts`).
 * The button `value` encodes `<turnId>\u0000<ownerUserId>` — see
 * `@soma/slack/turn-feedback-block-builder`. Deletes the completion card and
 * forgets it in the CompletionMessageTracker so auto-delete won't retry it.
 *
 * The button is owner-only (`visible_to_user_ids`); this handler also verifies
 * the actor server-side as defence in depth.
 */

import type { CompletionMessageTracker } from '@soma/slack/completion-message-tracker';
import { parseDismissValue } from '@soma/slack/turn-feedback-block-builder';
import { Logger } from '../../logger';
import type { SlackApiHelper } from '../slack-api-helper';
import type { RespondFn } from './types';

export interface TurnDismissActionContext {
  slackApi: SlackApiHelper;
  completionMessageTracker?: CompletionMessageTracker;
}

/** Slack delete errors that mean "already gone" — treat as success. */
const ALREADY_GONE = new Set(['message_not_found', 'cant_delete_message']);

export class TurnDismissActionHandler {
  private logger = new Logger('TurnDismissActionHandler');

  constructor(private ctx: TurnDismissActionContext) {}

  async handleDismiss(body: any, _respond: RespondFn): Promise<void> {
    const action = body?.actions?.[0];
    const parsed = parseDismissValue(action?.value);
    if (!parsed) {
      this.logger.warn('turn_dismiss_v1: unparseable value', { value: action?.value });
      return;
    }

    // Defence in depth on top of `visible_to_user_ids`: only the turn owner may
    // dismiss. A spoofed click from another user is ignored.
    const clicker = body?.user?.id;
    if (clicker && clicker !== parsed.ownerUserId) {
      this.logger.info('turn_dismiss_v1: non-owner click ignored', {
        clicker,
        owner: parsed.ownerUserId,
      });
      return;
    }

    const channel = body?.channel?.id ?? body?.container?.channel_id;
    // Delete the message the button lives on — never a ts from `value`.
    const messageTs = body?.message?.ts ?? body?.container?.message_ts;
    const threadTs = body?.message?.thread_ts ?? messageTs;
    if (!channel || !messageTs) {
      this.logger.warn('turn_dismiss_v1: missing channel/message ts', {
        turnId: parsed.turnId,
        hasChannel: !!channel,
        hasMessageTs: !!messageTs,
      });
      return;
    }

    // Forget BEFORE deleting so a racing auto-delete can't re-add it.
    // sessionKey mirrors SlackBlockKitChannel.track(): `${channel}-${threadTs}`.
    this.ctx.completionMessageTracker?.untrack(`${channel}-${threadTs}`, messageTs);

    try {
      await this.ctx.slackApi.deleteMessage(channel, messageTs);
    } catch (err) {
      const code = (err as { data?: { error?: string } })?.data?.error ?? (err as Error)?.message;
      if (code && ALREADY_GONE.has(code)) return; // already dismissed — fine
      this.logger.warn('turn_dismiss_v1: failed to delete card', {
        turnId: parsed.turnId,
        err: code ?? String(err),
      });
    }
  }
}
