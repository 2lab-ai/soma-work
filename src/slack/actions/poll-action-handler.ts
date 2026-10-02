/**
 * Native button poll — Slack button handlers.
 *
 * Routes (registered in `@soma/slack/actions`):
 *   - `poll_v1_vote_<idx>` — ANY user votes (value = pollId, idx = option index)
 *   - `poll_v1_close` / `poll_v1_cancel` — creator-only (authorized against the
 *     stored creatorId inside the service, never against the button value)
 *
 * The router acks first (3s budget), then calls these. Each handler calls the
 * service SYNCHRONOUSLY before its first await so the click claims its lane
 * slot in arrival order. Replies are ephemeral (only the clicker sees them);
 * the card itself is updated by the service.
 */

import { POLL_ACTION_VOTE_PREFIX } from '@soma/slack/poll/poll-blocks';
import type { CancelResult, CloseResult, PollService, VoteResult } from '@soma/slack/poll/poll-service';
import { Logger } from '../../logger';
import type { RespondFn } from './types';

export interface PollActionHandlerContext {
  getService: () => Pick<PollService, 'castVote' | 'close' | 'cancel'> | undefined;
}

interface ParsedClick {
  pollId: string;
  userId: string;
  channel: string;
  messageTs: string;
  actionId: string;
  actionTs: string;
}

export class PollActionHandler {
  private logger = new Logger('PollActionHandler');

  constructor(private ctx: PollActionHandlerContext) {}

  handleVote(body: any, respond: RespondFn): Promise<void> {
    const click = this.parse(body);
    if (!click) return Promise.resolve();
    const idxText = click.actionId.slice(POLL_ACTION_VOTE_PREFIX.length);
    if (!/^\d+$/.test(idxText)) {
      this.logger.warn('poll vote: malformed action_id', { actionId: click.actionId });
      return Promise.resolve();
    }
    const service = this.ctx.getService();
    if (!service) return this.reply(respond, '⚠️ 지금은 투표 기능을 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.');
    const pending = service.castVote({
      pollId: click.pollId,
      userId: click.userId,
      optionIndex: Number(idxText),
      actionTs: click.actionTs,
      channel: click.channel,
      messageTs: click.messageTs,
    });
    return pending.then(
      (result) => this.replyForVote(respond, result),
      (error) => {
        this.logger.error('poll vote failed', { pollId: click.pollId, error: String(error) });
        return this.reply(respond, '⚠️ 투표를 처리하지 못했습니다. 다시 눌러 주세요.');
      },
    );
  }

  handleClose(body: any, respond: RespondFn): Promise<void> {
    const click = this.parse(body);
    if (!click) return Promise.resolve();
    const service = this.ctx.getService();
    if (!service) return this.reply(respond, '⚠️ 지금은 투표 기능을 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.');
    const pending = service.close({
      pollId: click.pollId,
      actorId: click.userId,
      channel: click.channel,
      messageTs: click.messageTs,
    });
    return pending.then(
      (result) => this.replyForClose(respond, result),
      (error) => {
        this.logger.error('poll close failed', { pollId: click.pollId, error: String(error) });
        return this.reply(respond, '⚠️ 마감하지 못했습니다. 다시 시도해 주세요.');
      },
    );
  }

  handleCancel(body: any, respond: RespondFn): Promise<void> {
    const click = this.parse(body);
    if (!click) return Promise.resolve();
    const service = this.ctx.getService();
    if (!service) return this.reply(respond, '⚠️ 지금은 투표 기능을 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.');
    const pending = service.cancel({
      pollId: click.pollId,
      actorId: click.userId,
      channel: click.channel,
      messageTs: click.messageTs,
    });
    return pending.then(
      (result) => this.replyForCancel(respond, result),
      (error) => {
        this.logger.error('poll cancel failed', { pollId: click.pollId, error: String(error) });
        return this.reply(respond, '⚠️ 투표를 취소하지 못했습니다. 다시 시도해 주세요.');
      },
    );
  }

  private parse(body: any): ParsedClick | undefined {
    const action = body?.actions?.[0];
    const pollId = typeof action?.value === 'string' ? action.value : '';
    const userId = body?.user?.id;
    const channel = body?.channel?.id ?? body?.container?.channel_id;
    const messageTs = body?.message?.ts ?? body?.container?.message_ts;
    const actionId = typeof action?.action_id === 'string' ? action.action_id : '';
    const actionTs = typeof action?.action_ts === 'string' ? action.action_ts : '';
    if (!pollId || !userId || !channel || !messageTs || !actionId) {
      this.logger.warn('poll action: incomplete payload', {
        hasPollId: !!pollId,
        hasUser: !!userId,
        hasChannel: !!channel,
        hasMessageTs: !!messageTs,
      });
      return undefined;
    }
    return { pollId, userId, channel, messageTs, actionId, actionTs: actionTs || '0' };
  }

  private replyForVote(respond: RespondFn, result: VoteResult): Promise<void> {
    switch (result.kind) {
      case 'recorded':
        return this.reply(
          respond,
          `✅ *${result.optionIndex + 1}. ${result.label}*에 투표했습니다. 바꾸려면 다른 메뉴를 누르세요.`,
        );
      case 'unchanged':
        return this.reply(respond, `이미 *${result.optionIndex + 1}. ${result.label}*에 투표했습니다.`);
      case 'closed':
        return this.reply(respond, '마감된 투표입니다.');
      case 'invalid_option':
        return this.reply(respond, '알 수 없는 메뉴입니다.');
      case 'mismatch':
      case 'not_found':
        return this.reply(respond, '이 투표 카드는 유효하지 않습니다. 새 투표를 시작해 주세요.');
      case 'stale':
        return Promise.resolve(); // an older click arrived late — the newer one already answered
    }
  }

  private replyForClose(respond: RespondFn, result: CloseResult): Promise<void> {
    switch (result) {
      case 'closed':
        return Promise.resolve(); // the card itself turns into the result
      case 'forbidden':
        return this.reply(respond, '투표를 시작한 사람만 마감할 수 있습니다.');
      case 'already':
        return this.reply(respond, '이미 마감된 투표입니다.');
      default:
        return this.reply(respond, '이 투표 카드는 유효하지 않습니다.');
    }
  }

  private replyForCancel(respond: RespondFn, result: CancelResult): Promise<void> {
    switch (result) {
      case 'canceled':
        return Promise.resolve();
      case 'forbidden':
        return this.reply(respond, '투표를 시작한 사람만 취소할 수 있습니다.');
      case 'already':
        return this.reply(respond, '이미 취소된 투표입니다.');
      default:
        return this.reply(respond, '이 투표 카드는 유효하지 않습니다.');
    }
  }

  private async reply(respond: RespondFn, text: string): Promise<void> {
    try {
      await respond({ response_type: 'ephemeral', replace_original: false, text });
    } catch (error) {
      this.logger.warn('poll action: ephemeral reply failed', { error: String(error) });
    }
  }
}
