import type { WebClient } from '@slack/web-api';
import { Logger } from '../../logger';
import {
  computeContentHash,
  getUserSkill,
  isSingleFileSkill,
  isValidSkillName,
  updateUserSkill,
} from '../../user-skill-store';
import type { SlackApiHelper } from '../slack-api-helper';
import { USER_SKILL_EDIT_ACTION_ID, USER_SKILL_EDIT_BLOCK_ID } from './user-skill-menu-action-handler';
import { postSkillEphemeral } from './user-skill-view-submission-shared';

interface UserSkillEditViewContext {
  slackApi: SlackApiHelper;
}

/**
 * Slack Bolt `view_submission` ack.
 *
 * Bolt 4.x types `app.view` ack as `AckFn<void> | AckFn<ViewResponseAction>`
 * (a union over `view_submission` vs `view_closed`). For `view_submission`
 * the runtime arm is `AckFn<ViewResponseAction>`, but the static type cannot
 * prove it from the call site. Bolt also does not re-export `AckFn` /
 * `ViewResponseAction` from its public surface — we depend on the SHAPE
 * here, not the symbol, so a cast at the wiring site (`actions/index.ts`)
 * is the cleanest bridge. The narrowed shape is exported so that cast can
 * land on a name instead of `unknown`.
 */
export type ViewAck = (response?: {
  response_action?: 'errors' | 'clear' | 'update' | 'push';
  errors?: Record<string, string>;
  view?: any;
}) => Promise<void> | unknown;

interface ParsedMetadata {
  requesterId: string;
  skillName: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  contentHash: string;
}

function parseMetadata(raw: unknown): ParsedMetadata | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed.requesterId !== 'string' ||
    typeof parsed.skillName !== 'string' ||
    typeof parsed.contentHash !== 'string'
  ) {
    return null;
  }
  return {
    requesterId: parsed.requesterId,
    skillName: parsed.skillName,
    channelId: typeof parsed.channelId === 'string' ? parsed.channelId : '',
    threadTs: typeof parsed.threadTs === 'string' ? parsed.threadTs : '',
    messageTs: typeof parsed.messageTs === 'string' ? parsed.messageTs : '',
    contentHash: parsed.contentHash,
  };
}

function extractNewBody(view: any): string | null {
  const v = view?.state?.values?.[USER_SKILL_EDIT_BLOCK_ID]?.[USER_SKILL_EDIT_ACTION_ID]?.value;
  return typeof v === 'string' ? v : null;
}

/**
 * View-submission handler for the inline-edit modal opened by
 * {@link UserSkillMenuActionHandler.handleEdit}.
 *
 * 9-step flow (issue #750 §3):
 *   1. Parse `private_metadata` (requesterId, skillName, hash, channel, thread, messageTs).
 *   2. Verify the submitting Slack user id == `requesterId` — defense in
 *      depth (modal is not visible to other users, but we re-check).
 *   3. Re-validate skill name (kebab-case). Defensive against tampered metadata.
 *   4. Re-read SKILL.md → if missing OR no longer single-file, surface the
 *      blocking reason as an inline modal error (`response_action: 'errors'`).
 *   5. Compute current hash + compare to metadata's hash → mismatch ⇒ stale.
 *   6. Extract new body. If `newBody === currentContent`, no-op skip — ack
 *      with `clear` and skip the store call entirely (handler nit: avoid
 *      pointless writes).
 *   7. Call `updateUserSkill(requesterId, skillName, newBody)`. Inline errors
 *      from validation (empty / oversize / invalid name) become inline modal
 *      errors via `response_action: 'errors'`.
 *   8. ack with `clear` so Slack closes the modal.
 *   9. Post an ephemeral confirmation to the originating channel/thread.
 *      Wrapped in its own try/catch so transport failures here don't leak
 *      past the (already-closed) modal.
 *
 * Outer try/catch logs unexpected exceptions; an unstructured throw will
 * cause Bolt to close the modal silently — acceptable, since the user can
 * just retry.
 */
export class UserSkillEditViewSubmissionHandler {
  private logger = new Logger('UserSkillEditViewSubmissionHandler');

  constructor(private ctx: UserSkillEditViewContext) {}

  async handleSubmit(ack: ViewAck, body: any, _client: WebClient): Promise<void> {
    try {
      const view = body?.view;
      const meta = parseMetadata(view?.private_metadata);
      if (!meta) {
        this.logger.warn('user_skill_edit submit: invalid private_metadata');
        await ack({
          response_action: 'errors',
          errors: {
            [USER_SKILL_EDIT_BLOCK_ID]: '메타데이터가 손상되어 저장할 수 없습니다. 다시 시도해주세요.',
          },
        });
        return;
      }

      // Step 2 — submitter verification.
      const submitterId = body?.user?.id;
      if (!submitterId || submitterId !== meta.requesterId) {
        this.logger.warn('user_skill_edit submit: submitter mismatch', {
          submitterId,
          requesterId: meta.requesterId,
        });
        await ack({
          response_action: 'errors',
          errors: {
            [USER_SKILL_EDIT_BLOCK_ID]: '권한이 없는 사용자의 제출입니다.',
          },
        });
        return;
      }

      // Step 3 — defensive skill-name re-validation. Same predicate the
      // store uses (kebab-case + path-segment safety), not just the bare
      // regex — `private_metadata` came from the modal payload and is not
      // intrinsically trusted.
      if (!isValidSkillName(meta.skillName)) {
        this.logger.warn('user_skill_edit submit: invalid skillName', { skillName: meta.skillName });
        await ack({
          response_action: 'errors',
          errors: { [USER_SKILL_EDIT_BLOCK_ID]: '잘못된 스킬 이름입니다.' },
        });
        return;
      }

      // Step 4 — re-read + single-file recheck.
      const detail = getUserSkill(meta.requesterId, meta.skillName);
      if (!detail) {
        await ack({
          response_action: 'errors',
          errors: {
            [USER_SKILL_EDIT_BLOCK_ID]: `스킬이 더 이상 존재하지 않습니다: $user:${meta.skillName}`,
          },
        });
        return;
      }
      if (!isSingleFileSkill(meta.requesterId, meta.skillName)) {
        await ack({
          response_action: 'errors',
          errors: {
            [USER_SKILL_EDIT_BLOCK_ID]:
              '편집 도중 멀티 파일 스킬로 변경되었습니다. MANAGE_SKILL update 를 사용해주세요.',
          },
        });
        return;
      }

      // Step 5 — hash comparison.
      const currentHash = computeContentHash(detail.content);
      if (currentHash !== meta.contentHash) {
        this.logger.info('user_skill_edit submit: stale (hash mismatch)', {
          skillName: meta.skillName,
          expected: meta.contentHash,
          actual: currentHash,
        });
        await ack({
          response_action: 'errors',
          errors: {
            [USER_SKILL_EDIT_BLOCK_ID]: '편집 도중 다른 곳에서 수정되었습니다. 모달을 닫고 다시 열어주세요.',
          },
        });
        return;
      }

      // Step 6 — extract new body. No-op skip on identity.
      const newBody = extractNewBody(view);
      if (newBody === null) {
        await ack({
          response_action: 'errors',
          errors: { [USER_SKILL_EDIT_BLOCK_ID]: '본문 입력을 찾을 수 없습니다.' },
        });
        return;
      }
      if (newBody === detail.content) {
        this.logger.info('user_skill_edit submit: no-op (content unchanged)', {
          skillName: meta.skillName,
        });
        // Step 8 — ack clear so Slack closes the modal.
        await ack({ response_action: 'clear' });
        // Step 9 — best-effort confirmation.
        await postSkillEphemeral(this.ctx.slackApi, meta, '✅ 변경 없음 — 저장하지 않았습니다.', this.logger);
        return;
      }

      // Step 7 — store (verbatim).
      const result = updateUserSkill(meta.requesterId, meta.skillName, newBody);
      if (!result.ok) {
        await ack({
          response_action: 'errors',
          errors: { [USER_SKILL_EDIT_BLOCK_ID]: result.message },
        });
        return;
      }

      // Step 8 — close modal.
      await ack({ response_action: 'clear' });

      // Step 9 — post-ack ephemeral confirmation. Transport errors here are
      // logged but do not bubble — the save already succeeded and the modal
      // is gone, so we cannot re-open an inline error.
      await postSkillEphemeral(this.ctx.slackApi, meta, `✅ 스킬 저장됨: \`$user:${meta.skillName}\``, this.logger);
      this.logger.info('user_skill_edit submit: saved', {
        requesterId: meta.requesterId,
        skillName: meta.skillName,
        bytes: Buffer.byteLength(newBody, 'utf-8'),
      });
    } catch (error) {
      this.logger.error('Error processing user skill edit submission', error);
      // ack hasn't necessarily been called — try once with a generic error.
      try {
        await ack({
          response_action: 'errors',
          errors: {
            [USER_SKILL_EDIT_BLOCK_ID]: '예상치 못한 오류로 저장에 실패했습니다.',
          },
        });
      } catch (ackErr) {
        this.logger.warn('user_skill_edit submit: ack-after-error failed', {
          err: (ackErr as Error)?.message ?? String(ackErr),
        });
      }
    }
  }
}
