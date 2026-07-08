import * as path from 'path';
import { type CronJobPatch, CronStorage, isValidCronExpression, isValidCronName } from 'somalib/cron/cron-storage';
import { isAdminUser } from '../../admin-utils';
import { DATA_DIR } from '../../env-paths';
import { Logger } from '../../logger';
import {
  buildCronCard,
  CRON_EDIT_CHANNEL_BLOCK,
  CRON_EDIT_EXPR_BLOCK,
  CRON_EDIT_INPUT_ACTION,
  CRON_EDIT_NAME_BLOCK,
  CRON_EDIT_PROMPT_BLOCK,
  parseCronEditModalMetadata,
} from '../cron-blocks';
import type { SlackApiHelper } from '../slack-api-helper';
import type { ViewAck } from './autoskill-add-view-submission-handler';

interface CronEditSubmitContext {
  slackApi: SlackApiHelper;
  /** Test seam — defaults to DATA_DIR/cron-jobs.json. */
  storagePath?: string;
}

/**
 * View-submission handler for the cron edit modal
 * (`CRON_EDIT_MODAL_CALLBACK_ID`): name / schedule / channel / prompt.
 * Validates inline (response_action: errors), applies via
 * CronStorage.updateJob (rename guarded against duplicates), then re-renders
 * the source card with the submitter's visibility scope.
 * Pattern: src/slack/actions/autoskill-add-view-submission-handler.ts
 */
export class CronEditViewSubmissionHandler {
  private logger = new Logger('CronEditViewSubmissionHandler');

  constructor(private ctx: CronEditSubmitContext) {}

  private storage(): CronStorage {
    return new CronStorage(this.ctx.storagePath ?? path.join(DATA_DIR, 'cron-jobs.json'));
  }

  async handleSubmit(ack: ViewAck, body: any): Promise<void> {
    try {
      const view = body?.view;
      const meta = parseCronEditModalMetadata(view?.private_metadata);
      if (!meta) {
        await ack({
          response_action: 'errors',
          errors: { [CRON_EDIT_NAME_BLOCK]: '메타데이터가 손상되었습니다. 카드에서 다시 열어주세요.' },
        });
        return;
      }

      const submitterId: string | undefined = body?.user?.id;
      if (!submitterId || submitterId !== meta.requesterId) {
        await ack({
          response_action: 'errors',
          errors: { [CRON_EDIT_NAME_BLOCK]: '모달을 연 본인만 제출할 수 있습니다.' },
        });
        return;
      }
      // Defense in depth: the opener was already authorized at button time,
      // but re-check here in case an admin flag was revoked mid-flight.
      if (submitterId !== meta.owner && !isAdminUser(submitterId)) {
        await ack({
          response_action: 'errors',
          errors: { [CRON_EDIT_NAME_BLOCK]: '본인 또는 admin만 이 잡을 수정할 수 있습니다.' },
        });
        return;
      }

      const values = view?.state?.values ?? {};
      const name: string = values[CRON_EDIT_NAME_BLOCK]?.[CRON_EDIT_INPUT_ACTION]?.value?.trim() ?? '';
      const expression: string = values[CRON_EDIT_EXPR_BLOCK]?.[CRON_EDIT_INPUT_ACTION]?.value?.trim() ?? '';
      const channelInput = values[CRON_EDIT_CHANNEL_BLOCK]?.[CRON_EDIT_INPUT_ACTION];
      // conversations_select submits selected_conversation; keep the
      // channels_select key as a fallback for any in-flight old modals.
      const channel: string = channelInput?.selected_conversation ?? channelInput?.selected_channel ?? '';
      const prompt: string = values[CRON_EDIT_PROMPT_BLOCK]?.[CRON_EDIT_INPUT_ACTION]?.value ?? '';

      const errors: Record<string, string> = {};
      if (!isValidCronName(name)) {
        errors[CRON_EDIT_NAME_BLOCK] = '영문/숫자/하이픈/언더스코어 1-64자만 가능합니다.';
      }
      if (!isValidCronExpression(expression)) {
        errors[CRON_EDIT_EXPR_BLOCK] = '5-field cron 형식이 아닙니다 (예: 0 9 * * 1-5).';
      }
      if (!channel) {
        errors[CRON_EDIT_CHANNEL_BLOCK] = '채널을 선택하세요.';
      }
      // Modal surface caps at Slack's 3000-char plain_text_input limit; the
      // 4000-char storage cap is reachable only via the text command / MCP.
      if (!prompt || prompt.length > 3000) {
        errors[CRON_EDIT_PROMPT_BLOCK] = '프롬프트는 1-3000자여야 합니다 (더 길게는 cron prompt 명령).';
      }
      if (Object.keys(errors).length > 0) {
        await ack({ response_action: 'errors', errors });
        return;
      }

      const patch: CronJobPatch = { name, expression, channel, prompt };
      // Data-loss guard: prompts longer than the 3000-char Slack input cap are
      // shown truncated in the modal. If the submitted value is exactly that
      // truncated prefix, the user didn't edit it — preserve the full stored
      // prompt instead of silently cutting it to 3000.
      const current = this.storage()
        .getJobsByOwner(meta.owner)
        .find((j) => j.name === meta.name);
      if (current && current.prompt.length > 3000 && prompt === current.prompt.substring(0, 3000)) {
        delete patch.prompt;
      }
      // Channel reassignment invalidates a thread anchor from the OLD channel:
      // the scheduler posts threadReplier(job.channel, job.threadTs), so a
      // stale pair would reply into a nonexistent thread. Fall back to channel
      // delivery; the user re-picks a thread from the card if wanted.
      if (current && channel !== current.channel && (current.target === 'thread' || current.threadTs)) {
        patch.target = null;
        patch.threadTs = null;
      }
      let updated;
      try {
        updated = this.storage().updateJob(meta.owner, meta.name, patch);
      } catch (error: any) {
        if (error?.message?.startsWith('DUPLICATE_NAME')) {
          await ack({
            response_action: 'errors',
            errors: { [CRON_EDIT_NAME_BLOCK]: `이미 같은 이름의 잡이 있습니다: ${name}` },
          });
          return;
        }
        throw error;
      }
      if (!updated) {
        await ack({
          response_action: 'errors',
          errors: { [CRON_EDIT_NAME_BLOCK]: '잡을 찾을 수 없습니다 (삭제되었을 수 있음).' },
        });
        return;
      }

      await ack({ response_action: 'clear' });
      this.logger.info('cron job edited via modal', { submitterId, owner: meta.owner, from: meta.name, to: name });

      // Re-render the source card with the submitter's visibility.
      if (meta.cardChannelId && meta.cardMessageTs) {
        const admin = isAdminUser(submitterId);
        const storage = this.storage();
        const jobs = admin ? storage.getAll() : storage.getJobsByOwner(submitterId);
        const card = buildCronCard({ jobs, isAdmin: admin });
        await this.ctx.slackApi
          .updateMessage(meta.cardChannelId, meta.cardMessageTs, card.text, card.blocks, [])
          .catch((err: unknown) =>
            this.logger.warn('cron edit: card rerender failed', {
              err: (err as Error)?.message ?? String(err),
            }),
          );
      }
    } catch (error) {
      this.logger.error('Error processing cron edit submit', error);
      try {
        await ack({
          response_action: 'errors',
          errors: { [CRON_EDIT_NAME_BLOCK]: '저장 중 오류가 발생했습니다. 다시 시도해주세요.' },
        });
      } catch {
        // ack may already be consumed — best effort
      }
    }
  }
}
