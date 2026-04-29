import type { WebClient } from '@slack/web-api';
import { Logger } from '../../logger';
import { deleteUserSkill, isValidSkillName, userSkillExists } from '../../user-skill-store';
import type { SlackApiHelper } from '../slack-api-helper';
import type { ViewAck } from './user-skill-edit-view-submission-handler';
import {
  parseSkillViewMetadataBase,
  postSkillEphemeral,
  refreshSkillListMessage,
  type SkillViewMetadataBase,
} from './user-skill-view-submission-shared';

interface UserSkillDeleteViewContext {
  slackApi: SlackApiHelper;
}

/**
 * View-submission handler for the delete confirmation modal opened by
 * {@link UserSkillMenuActionHandler.handleDelete}.
 *
 * The modal has no editable input — submission is itself the confirmation.
 * Inline errors (`response_action: 'errors'`) here use a synthetic block_id
 * `delete_confirm_root` because there's no input to attach to; Slack still
 * shows the error at the top of the modal.
 */
const SYNTHETIC_ERROR_BLOCK_ID = 'user_skill_delete_root';

export class UserSkillDeleteConfirmViewSubmissionHandler {
  private logger = new Logger('UserSkillDeleteConfirmViewSubmissionHandler');

  constructor(private ctx: UserSkillDeleteViewContext) {}

  async handleSubmit(ack: ViewAck, body: any, _client: WebClient): Promise<void> {
    try {
      const view = body?.view;
      const meta = parseSkillViewMetadataBase(view?.private_metadata);
      if (!meta) {
        this.logger.warn('user_skill_delete submit: invalid private_metadata');
        await ack({
          response_action: 'errors',
          errors: { [SYNTHETIC_ERROR_BLOCK_ID]: '메타데이터가 손상되어 삭제할 수 없습니다.' },
        });
        return;
      }

      const submitterId = body?.user?.id;
      if (!submitterId || submitterId !== meta.requesterId) {
        this.logger.warn('user_skill_delete submit: submitter mismatch', {
          submitterId,
          requesterId: meta.requesterId,
        });
        await ack({
          response_action: 'errors',
          errors: { [SYNTHETIC_ERROR_BLOCK_ID]: '권한이 없는 사용자의 제출입니다.' },
        });
        return;
      }

      if (!isValidSkillName(meta.skillName)) {
        await ack({
          response_action: 'errors',
          errors: { [SYNTHETIC_ERROR_BLOCK_ID]: '잘못된 스킬 이름입니다.' },
        });
        return;
      }

      if (!userSkillExists(meta.requesterId, meta.skillName)) {
        // Race: skill was deleted between modal open and submit. ack as
        // success and post an informational ephemeral so the user knows
        // the desired end state was reached even though we did nothing.
        await ack({ response_action: 'clear' });
        await postSkillEphemeral(this.ctx.slackApi, meta, `ℹ️ 이미 삭제됨: \`$user:${meta.skillName}\``, this.logger);
        return;
      }

      const result = deleteUserSkill(meta.requesterId, meta.skillName);
      if (!result.ok) {
        await ack({
          response_action: 'errors',
          errors: { [SYNTHETIC_ERROR_BLOCK_ID]: result.message },
        });
        return;
      }

      await ack({ response_action: 'clear' });

      await this.refreshListMessageAndConfirm(meta);
      this.logger.info('user_skill_delete submit: deleted', {
        requesterId: meta.requesterId,
        skillName: meta.skillName,
      });
    } catch (error) {
      this.logger.error('Error processing user skill delete submission', error);
      try {
        await ack({
          response_action: 'errors',
          errors: { [SYNTHETIC_ERROR_BLOCK_ID]: '예상치 못한 오류로 삭제에 실패했습니다.' },
        });
      } catch (ackErr) {
        this.logger.warn('user_skill_delete submit: ack-after-error failed', {
          err: (ackErr as Error)?.message ?? String(ackErr),
        });
      }
    }
  }

  /**
   * Refresh the originating list message (replacing with an empty-state
   * placeholder when the user just deleted their last skill) and post an
   * ephemeral confirmation. Both halves best-effort via the shared helpers.
   */
  private async refreshListMessageAndConfirm(meta: SkillViewMetadataBase): Promise<void> {
    await refreshSkillListMessage(this.ctx.slackApi, meta, this.logger, '📭 등록된 personal skill이 없습니다.');
    await postSkillEphemeral(this.ctx.slackApi, meta, `🗑 삭제됨: \`$user:${meta.skillName}\``, this.logger);
  }
}
