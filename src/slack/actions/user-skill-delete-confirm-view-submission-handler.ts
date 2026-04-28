import type { WebClient } from '@slack/web-api';
import { Logger } from '../../logger';
import { deleteUserSkill, isValidSkillName, userSkillExists } from '../../user-skill-store';
import { buildUserSkillListBlocks } from '../commands/user-skills-list-handler';
import type { SlackApiHelper } from '../slack-api-helper';
import type { ViewAck } from './user-skill-edit-view-submission-handler';

interface UserSkillDeleteViewContext {
  slackApi: SlackApiHelper;
}

interface ParsedMetadata {
  requesterId: string;
  skillName: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
}

function parseMetadata(raw: unknown): ParsedMetadata | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed.requesterId !== 'string' || typeof parsed.skillName !== 'string') {
    return null;
  }
  return {
    requesterId: parsed.requesterId,
    skillName: parsed.skillName,
    channelId: typeof parsed.channelId === 'string' ? parsed.channelId : '',
    threadTs: typeof parsed.threadTs === 'string' ? parsed.threadTs : '',
    messageTs: typeof parsed.messageTs === 'string' ? parsed.messageTs : '',
  };
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
      const meta = parseMetadata(view?.private_metadata);
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
        if (meta.channelId) {
          try {
            await this.ctx.slackApi.postEphemeral(
              meta.channelId,
              meta.requesterId,
              `ℹ️ 이미 삭제됨: \`$user:${meta.skillName}\``,
              meta.threadTs || undefined,
            );
          } catch (err) {
            this.logger.debug('user_skill_delete submit: postEphemeral failed', {
              err: (err as Error)?.message ?? String(err),
            });
          }
        }
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
   * Refresh the originating list message (or replace it with a placeholder
   * when the user just deleted their last skill) and post an ephemeral
   * confirmation. Best-effort.
   */
  private async refreshListMessageAndConfirm(meta: ParsedMetadata): Promise<void> {
    if (meta.channelId && meta.messageTs) {
      try {
        const refreshed = buildUserSkillListBlocks(meta.requesterId);
        if (refreshed) {
          await this.ctx.slackApi.updateMessage(
            meta.channelId,
            meta.messageTs,
            refreshed.fallback,
            refreshed.blocks,
            [],
          );
        } else {
          // No skills left — replace the list with a small empty-state note.
          await this.ctx.slackApi.updateMessage(
            meta.channelId,
            meta.messageTs,
            '📭 등록된 personal skill이 없습니다.',
            [
              {
                type: 'section',
                text: { type: 'mrkdwn', text: '📭 등록된 personal skill이 없습니다.' },
              },
            ],
            [],
          );
        }
      } catch (err) {
        this.logger.warn('user_skill_delete submit: list refresh failed', {
          channel: meta.channelId,
          messageTs: meta.messageTs,
          err: (err as Error)?.message ?? String(err),
        });
      }
    }

    if (meta.channelId) {
      try {
        await this.ctx.slackApi.postEphemeral(
          meta.channelId,
          meta.requesterId,
          `🗑 삭제됨: \`$user:${meta.skillName}\``,
          meta.threadTs || undefined,
        );
      } catch (err) {
        this.logger.warn('user_skill_delete submit: postEphemeral failed', {
          channel: meta.channelId,
          requesterId: meta.requesterId,
          err: (err as Error)?.message ?? String(err),
        });
      }
    }
  }
}
