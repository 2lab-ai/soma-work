import { Logger } from '../../logger';
import { autoskillExists } from '../../skill-locator';
import { userSettingsStore } from '../../user-settings-store';
import {
  AUTOSKILL_ADD_BLOCK_ID,
  AUTOSKILL_ADD_SELECT_ACTION_ID,
  buildAutoskillCard,
  parseAutoskillModalMetadata,
} from '../autoskill-blocks';
import type { SlackApiHelper } from '../slack-api-helper';

/** Slack Bolt view-submission `ack` callback (mirrors the skill-edit handler). */
export type ViewAck = (response?: {
  response_action?: 'errors' | 'clear' | 'update' | 'push';
  errors?: Record<string, string>;
  view?: any;
}) => Promise<void> | unknown;

interface AutoskillAddSubmitContext {
  slackApi: SlackApiHelper;
}

/**
 * View-submission handler for the autoskill add modal
 * (`AUTOSKILL_ADD_MODAL_CALLBACK_ID`). Reads the multi-select, validates each
 * name still resolves, appends them to the user's list, then re-renders the
 * source card and posts an ephemeral summary.
 */
export class AutoskillAddViewSubmissionHandler {
  private logger = new Logger('AutoskillAddViewSubmissionHandler');

  constructor(private ctx: AutoskillAddSubmitContext) {}

  async handleSubmit(ack: ViewAck, body: any, _client?: unknown): Promise<void> {
    try {
      const view = body?.view;
      const meta = parseAutoskillModalMetadata(view?.private_metadata);
      if (!meta) {
        await ack({
          response_action: 'errors',
          errors: { [AUTOSKILL_ADD_BLOCK_ID]: '메타데이터가 손상되었습니다. 다시 시도해주세요.' },
        });
        return;
      }

      const submitterId: string | undefined = body?.user?.id;
      if (!submitterId || submitterId !== meta.requesterId) {
        await ack({
          response_action: 'errors',
          errors: { [AUTOSKILL_ADD_BLOCK_ID]: '본인만 이 모달을 제출할 수 있습니다.' },
        });
        return;
      }

      const selected: Array<{ value?: unknown }> =
        view?.state?.values?.[AUTOSKILL_ADD_BLOCK_ID]?.[AUTOSKILL_ADD_SELECT_ACTION_ID]?.selected_options ?? [];
      const names = selected.map((o) => (typeof o.value === 'string' ? o.value : '')).filter((s) => s.length > 0);

      if (names.length === 0) {
        await ack({
          response_action: 'errors',
          errors: { [AUTOSKILL_ADD_BLOCK_ID]: '하나 이상의 스킬을 선택하세요.' },
        });
        return;
      }

      const added: string[] = [];
      const skipped: string[] = [];
      for (const name of names) {
        if (!autoskillExists(name, meta.requesterId)) {
          skipped.push(name);
          continue;
        }
        if (userSettingsStore.addUserAutoskill(meta.requesterId, name)) added.push(name);
        else skipped.push(name);
      }

      // Close the modal.
      await ack({ response_action: 'clear' });

      // Re-render the source card so the new entries show immediately.
      if (meta.channelId && meta.messageTs) {
        const skills = userSettingsStore.getUserAutoskills(meta.requesterId);
        const card = buildAutoskillCard({ requesterId: meta.requesterId, skills });
        await this.ctx.slackApi
          .updateMessage(meta.channelId, meta.messageTs, card.text, card.blocks, [])
          .catch((err: unknown) =>
            this.logger.warn('autoskill add: card rerender failed', {
              err: (err as Error)?.message ?? String(err),
            }),
          );
      }

      // Best-effort ephemeral summary.
      if (meta.channelId) {
        let text =
          added.length > 0
            ? `✅ autoskill 추가: ${added.map((s) => `\`${s}\``).join(', ')}`
            : '추가된 새 스킬이 없습니다.';
        if (skipped.length > 0) {
          text += `\n⚠️ 건너뜀(이미 등록/한도 초과/없음): ${skipped.map((s) => `\`${s}\``).join(', ')}`;
        }
        await this.ctx.slackApi
          .postEphemeral(meta.channelId, meta.requesterId, text, meta.threadTs || undefined)
          .catch((err: unknown) =>
            this.logger.warn('autoskill add: ephemeral summary failed', {
              err: (err as Error)?.message ?? String(err),
            }),
          );
      }

      this.logger.info('autoskill add submitted', { requesterId: meta.requesterId, added, skipped });
    } catch (error) {
      this.logger.error('Error processing autoskill add submission', error);
      try {
        await ack({
          response_action: 'errors',
          errors: { [AUTOSKILL_ADD_BLOCK_ID]: '처리 중 오류가 발생했습니다.' },
        });
      } catch (ackErr) {
        this.logger.warn('autoskill add: ack-after-error failed', {
          err: (ackErr as Error)?.message ?? String(ackErr),
        });
      }
    }
  }
}
