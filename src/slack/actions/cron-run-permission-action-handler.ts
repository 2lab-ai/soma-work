import * as path from 'path';
import { CronStorage } from 'somalib/cron/cron-storage';
import { type CronRunRequest, getCronRunRequest, markCronRunRequestHandled } from '../../cron-run-request-store';
import { getActiveCronScheduler } from '../../cron-scheduler';
import { DATA_DIR } from '../../env-paths';
import { Logger } from '../../logger';
import {
  VALUE_KIND_CRON_RUN_ALWAYS,
  VALUE_KIND_CRON_RUN_DENY,
  VALUE_KIND_CRON_RUN_ONCE,
} from '../cron-run-permission-blocks';
import type { SlackApiHelper } from '../slack-api-helper';
import type { RespondFn } from './types';

interface CronRunPermissionContext {
  slackApi: SlackApiHelper;
  /** Test seam — defaults to DATA_DIR/cron-jobs.json (same file the scheduler reads). */
  storagePath?: string;
}

type RunPermKind =
  | typeof VALUE_KIND_CRON_RUN_ONCE
  | typeof VALUE_KIND_CRON_RUN_ALWAYS
  | typeof VALUE_KIND_CRON_RUN_DENY;

const KNOWN_KINDS: ReadonlySet<string> = new Set([
  VALUE_KIND_CRON_RUN_ONCE,
  VALUE_KIND_CRON_RUN_ALWAYS,
  VALUE_KIND_CRON_RUN_DENY,
]);

/**
 * Handles the 3 buttons of the `cron run` permission prompt:
 *   - ▶ 1회 실행 허용  → fire once, nothing persisted
 *   - ✅ 항상 허용      → persist the requester on the job's runAllowlist, then fire
 *   - ❌ 거부           → no grant, no fire
 *
 * Owner-bound: only the job owner may grant. The button carries only a
 * `requestId`; the authoritative request is read server-side, so a forged or
 * replayed payload cannot fabricate a grant. Firing goes through the real
 * scheduler path with the OWNER's identity (`runJobNow(ownerId, jobName)`) —
 * target/mode/model/history behave exactly like a scheduled fire.
 */
export class CronRunPermissionActionHandler {
  private logger = new Logger('CronRunPermissionActionHandler');

  constructor(private ctx: CronRunPermissionContext) {}

  private storage(): CronStorage {
    return new CronStorage(this.ctx.storagePath ?? path.join(DATA_DIR, 'cron-jobs.json'));
  }

  async handleAction(body: any, respond: RespondFn): Promise<void> {
    try {
      const rawValue: unknown = body?.actions?.[0]?.value;
      if (typeof rawValue !== 'string') {
        this.logger.warn('cron_run_perm: missing action value');
        return;
      }

      let parsed: { kind?: unknown; requestId?: unknown };
      try {
        parsed = JSON.parse(rawValue);
      } catch {
        this.logger.warn('cron_run_perm: malformed value JSON');
        return;
      }
      const kind =
        typeof parsed.kind === 'string' && KNOWN_KINDS.has(parsed.kind) ? (parsed.kind as RunPermKind) : null;
      const requestId = typeof parsed.requestId === 'string' ? parsed.requestId : '';
      if (!kind || !requestId) {
        this.logger.warn('cron_run_perm: invalid kind/requestId', { kind, requestId });
        return;
      }

      const req = getCronRunRequest(requestId);
      if (!req) {
        await respond({
          response_type: 'ephemeral',
          replace_original: false,
          text: '⚠️ 만료되었거나 더 이상 유효하지 않은 실행 권한 요청입니다.',
        });
        return;
      }

      // Owner-bound: only the job owner may grant.
      const clickerId: string | undefined = body?.user?.id;
      if (!clickerId || clickerId !== req.ownerId) {
        await respond({
          response_type: 'ephemeral',
          replace_original: false,
          text: `⚠️ 이 요청은 크론잡 오너 <@${req.ownerId}>님만 처리할 수 있습니다.`,
        });
        return;
      }

      if (req.handled) {
        await respond({
          response_type: 'ephemeral',
          replace_original: false,
          text: '⚠️ 이미 처리된 실행 권한 요청입니다.',
        });
        return;
      }

      // The job must still exist — it may have been deleted/renamed since the ask.
      const job = this.storage()
        .getJobsByOwner(req.ownerId)
        .find((j) => j.name === req.jobName);
      if (!job) {
        markCronRunRequestHandled(requestId);
        await respond({
          response_type: 'ephemeral',
          replace_original: false,
          text: `❌ 크론잡 \`${req.jobName}\` 이 더 이상 존재하지 않습니다.`,
        });
        return;
      }

      if (kind === VALUE_KIND_CRON_RUN_DENY) {
        markCronRunRequestHandled(requestId);
        await this.replacePrompt(respond, `🚫 <@${req.requesterId}>님의 \`${req.jobName}\` 실행 요청을 거부했습니다.`);
        await this.notifyRequester(req, `🚫 <@${req.requesterId}> — \`${req.jobName}\` 실행 요청이 거부되었습니다.`);
        this.logger.info('cron_run_perm: denied', {
          ownerId: req.ownerId,
          requesterId: req.requesterId,
          jobName: req.jobName,
        });
        return;
      }

      let grantLabel: string;
      if (kind === VALUE_KIND_CRON_RUN_ALWAYS) {
        this.storage().allowRun(req.ownerId, req.jobName, req.requesterId);
        grantLabel = `<@${req.requesterId}>님을 \`${req.jobName}\` 실행 허용 리스트에 추가하고 지금 실행합니다.`;
      } else {
        grantLabel = `<@${req.requesterId}>님의 \`${req.jobName}\` 1회 실행을 허용했습니다.`;
      }
      markCronRunRequestHandled(requestId);
      await this.replacePrompt(respond, `✅ ${grantLabel}`);

      const scheduler = getActiveCronScheduler();
      if (!scheduler) {
        await this.notifyRequester(
          req,
          `⚠️ \`${req.jobName}\` — 크론 스케줄러가 아직 기동되지 않아 실행하지 못했습니다.`,
        );
        return;
      }
      // Owner identity: the fire is indistinguishable from the owner running it.
      const result = await scheduler.runJobNow(req.ownerId, req.jobName);
      await this.notifyRequester(
        req,
        result.ok
          ? `▶ <@${req.requesterId}> — <@${req.ownerId}>님의 허가로 \`${req.jobName}\` 을 오너 권한으로 실행했습니다.`
          : `⚠️ \`${req.jobName}\` 실행 실패: ${result.message}`,
      );
      this.logger.info('cron_run_perm: granted + fired', {
        kind,
        ownerId: req.ownerId,
        requesterId: req.requesterId,
        jobName: req.jobName,
        ok: result.ok,
      });
    } catch (error) {
      this.logger.error('cron_run_perm: unexpected error', error);
      try {
        await respond({
          response_type: 'ephemeral',
          replace_original: false,
          text: '⚠️ 실행 권한 처리 중 오류가 발생했습니다.',
        });
      } catch {
        /* best effort */
      }
    }
  }

  /** Replace the prompt with a confirmation so the buttons cannot be clicked twice. */
  private async replacePrompt(respond: RespondFn, text: string): Promise<void> {
    await respond({
      response_type: 'in_channel',
      replace_original: true,
      text,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
    });
  }

  /** Report the outcome where the requester asked from. */
  private async notifyRequester(req: CronRunRequest, text: string): Promise<void> {
    if (!req.channel) return;
    await this.ctx.slackApi.postMessage(req.channel, text, { threadTs: req.threadTs }).catch((err: unknown) =>
      this.logger.warn('cron_run_perm: requester notify failed', {
        err: (err as Error)?.message ?? String(err),
      }),
    );
  }
}
