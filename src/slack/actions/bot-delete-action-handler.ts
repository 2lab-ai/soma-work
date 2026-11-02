import { Logger } from '../../logger';
import { type BotDeleteDecision, type BotDeleteSlackApi, decideBotDelete } from '../bot-delete-decision';
import type { RespondFn } from './types';

/**
 * 승인 / 거절 on the admins' bot-message delete DM. The decision is
 * {@link decideBotDelete} — the same one the dashboard's admin approvals take
 * (#623): only an admin, exactly once, every admin's DM copy rewritten.
 */
export class BotDeleteActionHandler {
  private logger = new Logger('BotDeleteActionHandler');

  constructor(private readonly deps: { slackApi: BotDeleteSlackApi }) {}

  async handleApprove(body: any, respond: RespondFn): Promise<void> {
    await this.handle(body, respond, 'approve');
  }

  async handleReject(body: any, respond: RespondFn): Promise<void> {
    await this.handle(body, respond, 'reject');
  }

  private async handle(body: any, respond: RespondFn, decision: BotDeleteDecision): Promise<void> {
    let value: { requestId?: unknown; requesterId?: unknown; targetChannel?: unknown; targetTs?: unknown };
    try {
      value = JSON.parse(body.actions?.[0]?.value || '{}');
    } catch {
      value = {};
    }
    const actor = body.user?.id;
    const legacy =
      typeof value.requesterId === 'string' &&
      typeof value.targetChannel === 'string' &&
      typeof value.targetTs === 'string'
        ? { requesterId: value.requesterId, targetChannel: value.targetChannel, targetTs: value.targetTs }
        : undefined;
    if ((!legacy && typeof value.requestId !== 'string') || !actor) {
      this.logger.warn('Invalid dm delete payload', { actor });
      return;
    }
    const result = await decideBotDelete({
      ...(typeof value.requestId === 'string' ? { requestId: value.requestId } : {}),
      ...(legacy ? { legacy } : {}),
      decision,
      actor,
      via: 'slack',
      slackApi: this.deps.slackApi,
    });
    if (!result.ok) {
      await respond({
        text: result.message,
        ...(result.reason === 'failed'
          ? { replace_original: false }
          : { response_type: 'ephemeral', replace_original: false }),
      });
      return;
    }
    await respond({ text: result.text, replace_original: true });
    await result.effects;
  }
}
