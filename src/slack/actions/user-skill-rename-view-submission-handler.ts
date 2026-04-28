import type { WebClient } from '@slack/web-api';
import { Logger } from '../../logger';
import { isValidSkillName, renameUserSkill, userSkillExists } from '../../user-skill-store';
import { buildUserSkillListBlocks } from '../commands/user-skills-list-handler';
import type { SlackApiHelper } from '../slack-api-helper';
import type { ViewAck } from './user-skill-edit-view-submission-handler';
import { USER_SKILL_RENAME_ACTION_ID, USER_SKILL_RENAME_BLOCK_ID } from './user-skill-menu-action-handler';

interface UserSkillRenameViewContext {
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
      const meta = parseMetadata(view?.private_metadata);
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
        // renders it under the input. The default branch is defensive — the
        // store always sets `error` on failure.
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
   * name) and post an ephemeral confirmation. Both are best-effort.
   */
  private async refreshListMessageAndConfirm(meta: ParsedMetadata, newName: string): Promise<void> {
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
        }
      } catch (err) {
        this.logger.warn('user_skill_rename submit: list refresh failed', {
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
          `✅ 이름 변경됨: \`$user:${meta.skillName}\` → \`$user:${newName}\``,
          meta.threadTs || undefined,
        );
      } catch (err) {
        this.logger.warn('user_skill_rename submit: postEphemeral failed', {
          channel: meta.channelId,
          requesterId: meta.requesterId,
          err: (err as Error)?.message ?? String(err),
        });
      }
    }
  }
}
