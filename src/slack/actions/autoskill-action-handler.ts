import type { WebClient } from '@slack/web-api';
import { Logger } from '../../logger';
import { listAvailableSkills } from '../../skill-locator';
import { userSettingsStore } from '../../user-settings-store';
import {
  AUTOSKILL_ADD_OPEN_ACTION_ID,
  AUTOSKILL_REMOVE_ACTION_ID,
  buildAutoskillAddModal,
  buildAutoskillCard,
  parseAutoskillButtonValue,
} from '../autoskill-blocks';
import type { SlackApiHelper } from '../slack-api-helper';
import type { RespondFn } from './types';

interface AutoskillActionContext {
  slackApi: SlackApiHelper;
}

/**
 * Handles clicks on the autoskill management card:
 *   - `autoskill_remove`    → delete one skill, re-render the card in place.
 *   - `autoskill_add_open`  → open the multi-select add modal.
 *
 * Every button value carries `requesterId`; only that user may mutate the card
 * (other clickers get an ephemeral reject and the card stays live).
 */
export class AutoskillActionHandler {
  private logger = new Logger('AutoskillActionHandler');

  constructor(private ctx: AutoskillActionContext) {}

  async handleAction(body: any, respond: RespondFn, client?: WebClient): Promise<void> {
    try {
      const action = body?.actions?.[0];
      const actionId: string = action?.action_id ?? '';
      const value = parseAutoskillButtonValue(action?.value);
      if (!value) {
        this.logger.warn('autoskill action: malformed value', { actionId });
        return;
      }

      const clickerId: string | undefined = body?.user?.id;
      if (!clickerId || clickerId !== value.requesterId) {
        await respond({
          response_type: 'ephemeral',
          replace_original: false,
          text: `⚠️ 이 autoskill 카드는 <@${value.requesterId}>님 전용입니다.`,
        });
        return;
      }

      if (actionId === AUTOSKILL_REMOVE_ACTION_ID) {
        await this.handleRemove(body, value.requesterId, value.skillName);
        return;
      }
      if (actionId === AUTOSKILL_ADD_OPEN_ACTION_ID) {
        await this.handleAddOpen(body, respond, value.requesterId, client);
        return;
      }
      this.logger.warn('autoskill action: unknown action_id', { actionId });
    } catch (error) {
      this.logger.error('Error processing autoskill action', error);
      try {
        await respond({
          response_type: 'ephemeral',
          replace_original: false,
          text: '⚠️ autoskill 처리 중 오류가 발생했습니다.',
        });
      } catch {
        // best-effort
      }
    }
  }

  private async handleRemove(body: any, requesterId: string, skillName?: string): Promise<void> {
    if (!skillName) {
      this.logger.warn('autoskill remove: missing skillName');
      return;
    }
    userSettingsStore.removeUserAutoskill(requesterId, skillName);
    await this.rerenderCard(body, requesterId);
    this.logger.info('autoskill removed', { requesterId, skillName });
  }

  private async handleAddOpen(body: any, respond: RespondFn, requesterId: string, client?: WebClient): Promise<void> {
    const triggerId: string | undefined = body?.trigger_id;
    if (!triggerId || !client) {
      await respond({
        response_type: 'ephemeral',
        replace_original: false,
        text: '⚠️ 모달을 여는 데 필요한 정보가 누락되었습니다 (trigger_id missing).',
      });
      return;
    }

    const available = listAvailableSkills(requesterId);
    const registered = userSettingsStore.getUserAutoskills(requesterId);
    const channelId: string = body?.channel?.id ?? '';
    const messageTs: string = body?.message?.ts ?? '';
    const threadTs: string = body?.message?.thread_ts ?? messageTs;

    const modal = buildAutoskillAddModal({
      available,
      alreadyRegistered: registered,
      privateMetadata: { requesterId, channelId, messageTs, threadTs },
    });
    if (!modal) {
      await respond({
        response_type: 'ephemeral',
        replace_original: false,
        text: '➕ 추가할 수 있는 스킬이 더 없습니다 (이미 전부 등록되었거나 사용 가능한 스킬이 없습니다).',
      });
      return;
    }

    try {
      await client.views.open({ trigger_id: triggerId, view: modal as any });
      this.logger.info('autoskill add modal opened', { requesterId });
    } catch (err) {
      this.logger.error('autoskill add: views.open failed', {
        err: (err as Error)?.message ?? String(err),
      });
      await respond({
        response_type: 'ephemeral',
        replace_original: false,
        text: `⚠️ 추가 모달을 여는 데 실패했습니다: ${(err as Error)?.message ?? String(err)}`,
      });
    }
  }

  /** Re-render the card message in place after a mutation. */
  private async rerenderCard(body: any, requesterId: string): Promise<void> {
    const channelId: string | undefined = body?.channel?.id;
    const messageTs: string | undefined = body?.message?.ts;
    if (!channelId || !messageTs) return;
    const skills = userSettingsStore.getUserAutoskills(requesterId);
    const card = buildAutoskillCard({ requesterId, skills });
    await this.ctx.slackApi.updateMessage(channelId, messageTs, card.text, card.blocks, []).catch((err: unknown) =>
      this.logger.warn('autoskill rerender: updateMessage failed', {
        err: (err as Error)?.message ?? String(err),
      }),
    );
  }
}
