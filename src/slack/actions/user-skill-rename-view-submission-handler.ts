import type { WebClient } from '@slack/web-api';
import { Logger } from '../../logger';
import { isValidSkillName, renameUserSkill, userSkillExists } from '../../user-skill-store';
import type { SlackApiHelper } from '../slack-api-helper';
import type { ViewAck } from './user-skill-edit-view-submission-handler';
import { USER_SKILL_RENAME_ACTION_ID, USER_SKILL_RENAME_BLOCK_ID } from './user-skill-menu-action-handler';
import {
  parseSkillViewMetadataBase,
  postSkillEphemeral,
  refreshSkillListMessage,
  type SkillViewMetadataBase,
} from './user-skill-view-submission-shared';

interface UserSkillRenameViewContext {
  slackApi: SlackApiHelper;
}

function extractNewName(view: any): string | null {
  const v = view?.state?.values?.[USER_SKILL_RENAME_BLOCK_ID]?.[USER_SKILL_RENAME_ACTION_ID]?.value;
  return typeof v === 'string' ? v.trim() : null;
}

/**
 * View-submission handler for the rename modal opened by
 * {@link UserSkillMenuActionHandler.handleRename}.
 *
 * Flow:
 *   1. Parse `private_metadata` (requesterId, oldSkillName, channel, thread, messageTs).
 *   2. Verify submitter == requesterId (defense in depth — modal isn't shown
 *      to others, but private_metadata can be tampered with).
 *   3. Re-validate old skill name (kebab-case) for path-segment safety.
 *   4. Confirm source skill still exists; if not, surface as inline error.
 *   5. Extract new name from input. Trim, then re-validate against the same
 *      `isValidSkillName` predicate the store uses.
 *   6. Call `renameUserSkill(requesterId, oldName, newName)` — the store
 *      enforces all the invariants (length cap, target collision, case-only
 *      semantics). On failure, map the granular `error` discriminant onto an
 *      inline modal error string.
 *   7. ack with `clear` to close the modal.
 *   8. Update the originating list message in place to reflect the new name,
 *      then post an ephemeral confirmation. Best-effort — failure here does
 *      not block the (already-completed) rename.
 */
export class UserSkillRenameViewSubmissionHandler {
  private logger = new Logger('UserSkillRenameViewSubmissionHandler');

  constructor(private ctx: UserSkillRenameViewContext) {}

  async handleSubmit(ack: ViewAck, body: any, _client: WebClient): Promise<void> {
    try {
      const view = body?.view;
      const meta = parseSkillViewMetadataBase(view?.private_metadata);
      if (!meta) {
        this.logger.warn('user_skill_rename submit: invalid private_metadata');
        await ack({
          response_action: 'errors',
          errors: { [USER_SKILL_RENAME_BLOCK_ID]: '메타데이터가 손상되어 변경할 수 없습니다.' },
        });
        return;
      }

      const submitterId = body?.user?.id;
      if (!submitterId || submitterId !== meta.requesterId) {
        this.logger.warn('user_skill_rename submit: submitter mismatch', {
          submitterId,
          requesterId: meta.requesterId,
        });
        await ack({
          response_action: 'errors',
          errors: { [USER_SKILL_RENAME_BLOCK_ID]: '권한이 없는 사용자의 제출입니다.' },
        });
        return;
      }

      if (!isValidSkillName(meta.skillName)) {
        await ack({
          response_action: 'errors',
          errors: { [USER_SKILL_RENAME_BLOCK_ID]: '잘못된 원본 스킬 이름입니다.' },
        });
        return;
      }

      if (!userSkillExists(meta.requesterId, meta.skillName)) {
        await ack({
          response_action: 'errors',
          errors: {
            [USER_SKILL_RENAME_BLOCK_ID]: `스킬이 더 이상 존재하지 않습니다: $user:${meta.skillName}`,
          },
        });
        return;
      }

      const newNameRaw = extractNewName(view);
      if (newNameRaw === null || newNameRaw.length === 0) {
        await ack({
          response_action: 'errors',
          errors: { [USER_SKILL_RENAME_BLOCK_ID]: '새 이름을 입력해주세요.' },
        });
        return;
      }

      // Predicate check before storage so the user sees a snappier error
      // (the store would also catch this and return INVALID, but inline
      // validation gives a less generic message for the most-common case).
      if (!isValidSkillName(newNameRaw)) {
        await ack({
          response_action: 'errors',
          errors: {
            [USER_SKILL_RENAME_BLOCK_ID]: 'kebab-case (소문자/숫자/하이픈, 첫 글자는 영숫자) 만 허용됩니다.',
          },
        });
        return;
      }

      const result = renameUserSkill(meta.requesterId, meta.skillName, newNameRaw);
      if (!result.ok) {
        // Map granular error code → inline modal message. Same wording as
        // the storage layer's `message` field, but block-id-keyed so Slack
        // renders it under the input.
        await ack({
          response_action: 'errors',
          errors: { [USER_SKILL_RENAME_BLOCK_ID]: result.message },
        });
        return;
      }

      await ack({ response_action: 'clear' });

      // Best-effort post-ack updates. Failures are logged but never bubble —
      // the rename has already succeeded and the modal is gone, so we cannot
      // re-open an inline error.
      await this.refreshListMessageAndConfirm(meta, newNameRaw);
      this.logger.info('user_skill_rename submit: renamed', {
        requesterId: meta.requesterId,
        oldName: meta.skillName,
        newName: newNameRaw,
      });
    } catch (error) {
      this.logger.error('Error processing user skill rename submission', error);
      try {
        await ack({
          response_action: 'errors',
          errors: { [USER_SKILL_RENAME_BLOCK_ID]: '예상치 못한 오류로 변경에 실패했습니다.' },
        });
      } catch (ackErr) {
        this.logger.warn('user_skill_rename submit: ack-after-error failed', {
          err: (ackErr as Error)?.message ?? String(ackErr),
        });
      }
    }
  }

  /**
   * Re-render the list message in place (so the renamed entry shows its new
   * name) and post an ephemeral confirmation. Both halves best-effort via the
   * shared helpers in `user-skill-view-submission-shared.ts`.
   *
   * Empty-state placeholder is unreachable here (rename never deletes the last
   * skill) but the shared helper requires the parameter — pass the canonical
   * "no skills" string so a future code path that DOES leave the user with
   * zero skills (e.g. if rename ever soft-deletes on conflict) renders the
   * same UX as the delete handler.
   */
  private async refreshListMessageAndConfirm(meta: SkillViewMetadataBase, newName: string): Promise<void> {
    await refreshSkillListMessage(this.ctx.slackApi, meta, this.logger, '📭 등록된 personal skill이 없습니다.');
    await postSkillEphemeral(
      this.ctx.slackApi,
      meta,
      `✅ 이름 변경됨: \`$user:${meta.skillName}\` → \`$user:${newName}\``,
      this.logger,
    );
  }
}
