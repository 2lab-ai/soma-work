import * as path from 'path';
import { type CronJobPatch, CronStorage, isRunAllowed } from 'somalib/cron/cron-storage';
import { isAdminUser } from '../../admin-utils';
import { getActiveCronScheduler } from '../../cron-scheduler';
import { DATA_DIR } from '../../env-paths';
import { Logger } from '../../logger';
import {
  buildCronCard,
  buildCronEditModal,
  CRON_MODEL_DEFAULT,
  CRON_MODEL_FAST,
  parseCronActionId,
} from '../cron-blocks';
import {
  type CronRunPermissionSlackApi,
  describeDelivery,
  requestCronRunPermission,
} from '../cron-run-permission-request';
import type { SlackApiHelper } from '../slack-api-helper';
import type { RespondFn } from './types';

interface CronActionContext {
  slackApi: SlackApiHelper;
  /** Test seam — defaults to DATA_DIR/cron-jobs.json (same file the scheduler reads). */
  storagePath?: string;
}

/**
 * Handles interactions on the cron management card (src/slack/cron-blocks.ts):
 *   - `cron_model::<owner>::<name>`  static_select → change model override
 *   - `cron_target::<owner>::<name>` static_select → change delivery target
 *   - `cron_delete::<owner>::<name>` button        → delete the job
 *
 * Authorization is job-owner-scoped: the clicker must be the job's owner or an
 * admin (ADMIN_USERS). Everyone else gets an ephemeral reject and the card
 * stays live. After a mutation the card re-renders in place with the clicker's
 * visibility (admin sees all users' jobs, owner sees their own).
 * Pattern: src/slack/actions/autoskill-action-handler.ts
 */
export class CronActionHandler {
  private logger = new Logger('CronActionHandler');

  constructor(private ctx: CronActionContext) {}

  private storage(): CronStorage {
    return new CronStorage(this.ctx.storagePath ?? path.join(DATA_DIR, 'cron-jobs.json'));
  }

  async handleAction(body: any, respond: RespondFn, client?: any): Promise<void> {
    try {
      const action = body?.actions?.[0];
      const actionId: string = action?.action_id ?? '';
      const parsed = parseCronActionId(actionId);
      if (!parsed) {
        this.logger.warn('cron action: malformed action_id', { actionId });
        return;
      }
      const { kind, owner, name } = parsed;

      const clickerId: string | undefined = body?.user?.id;
      if (!clickerId || (clickerId !== owner && !isAdminUser(clickerId))) {
        // ▶ run is the one action a non-owner may ask for: the card lives in a
        // channel, so anyone can click it. Allowlisted → fire as the owner;
        // otherwise ask the owner instead of refusing. Every other action
        // (mutations) stays owner/admin-only.
        if (clickerId && kind === 'run') {
          await this.handleNonOwnerRun(body, respond, { clickerId, owner, name });
          return;
        }
        await respond({
          response_type: 'ephemeral',
          replace_original: false,
          text: `⚠️ *${name}* 은 <@${owner}>님의 크론잡입니다 — 본인 또는 admin만 수정할 수 있습니다.`,
        });
        return;
      }

      if (kind === 'delete') {
        const removed = this.storage().removeJob(owner, name);
        if (!removed) {
          await this.notFound(respond, name);
          return;
        }
        this.logger.info('cron job deleted via card', { clickerId, owner, name });
        await this.rerenderCard(body, clickerId);
        return;
      }

      if (kind === 'run') {
        await this.fireJob(body, respond, { clickerId, owner, name });
        return;
      }

      if (kind === 'edit') {
        const triggerId: string | undefined = body?.trigger_id;
        if (!triggerId || !client) {
          await respond({
            response_type: 'ephemeral',
            replace_original: false,
            text: '⚠️ 편집 모달을 열 수 없습니다 (trigger_id/client 누락).',
          });
          return;
        }
        const job = this.storage()
          .getJobsByOwner(owner)
          .find((j) => j.name === name);
        if (!job) {
          await this.notFound(respond, name);
          return;
        }
        const modal = buildCronEditModal({
          job,
          metadata: {
            owner,
            name,
            cardChannelId: body?.channel?.id ?? '',
            cardMessageTs: body?.message?.ts ?? '',
            requesterId: clickerId,
          },
        });
        try {
          await client.views.open({ trigger_id: triggerId, view: modal });
        } catch (err) {
          this.logger.error('cron edit: views.open failed', { err: (err as Error)?.message ?? String(err) });
          await respond({
            response_type: 'ephemeral',
            replace_original: false,
            text: `⚠️ 편집 모달 열기 실패: ${(err as Error)?.message ?? String(err)}`,
          });
        }
        return;
      }

      const selected: string | undefined = action?.selected_option?.value;
      if (!selected) {
        this.logger.warn('cron action: missing selected_option', { actionId });
        return;
      }

      const patch =
        kind === 'model'
          ? buildModelPatch(selected)
          : kind === 'mode'
            ? buildModePatch(selected)
            : buildTargetPatch(selected, body);
      if (!patch) {
        await respond({
          response_type: 'ephemeral',
          replace_original: false,
          text: `⚠️ 잘못된 선택값입니다: \`${selected}\``,
        });
        return;
      }

      const updated = this.storage().updateJob(owner, name, patch);
      if (!updated) {
        await this.notFound(respond, name);
        return;
      }
      this.logger.info('cron job updated via card', { clickerId, owner, name, kind, selected });
      await this.rerenderCard(body, clickerId);
    } catch (error) {
      this.logger.error('Error processing cron action', error);
      try {
        await respond({
          response_type: 'ephemeral',
          replace_original: false,
          text: '⚠️ 크론잡 변경 중 오류가 발생했습니다.',
        });
      } catch {
        // best-effort
      }
    }
  }

  /**
   * Fire a job through the real cron path — identical to a scheduled fire
   * (target/mode/model/history/lastRun), NOT a model-side simulation. Always
   * runs with the job OWNER's identity, whoever pressed the button.
   */
  private async fireJob(
    body: any,
    respond: RespondFn,
    args: { clickerId: string; owner: string; name: string },
  ): Promise<void> {
    const { clickerId, owner, name } = args;
    const scheduler = getActiveCronScheduler();
    if (!scheduler) {
      await respond({
        response_type: 'ephemeral',
        replace_original: false,
        text: '⚠️ 크론 스케줄러가 아직 기동되지 않았습니다.',
      });
      return;
    }
    const result = await scheduler.runJobNow(owner, name, { triggeredBy: clickerId });
    await respond({
      response_type: 'ephemeral',
      replace_original: false,
      text: result.ok
        ? `▶ *${name}* 실행 트리거됨 — 실제 크론 경로(대상/모드/모델 그대로)로 발동했습니다.${clickerId !== owner ? ` (오너 <@${owner}> 권한)` : ''}`
        : `⚠️ *${name}* 실행 실패: ${result.message}`,
    });
    if (result.ok) await this.rerenderCard(body, clickerId); // last-run 갱신 반영
  }

  /**
   * ▶ pressed by someone who is neither owner nor admin. Allowlisted users
   * fire the job as the owner; everyone else triggers a permission request DM
   * to the owner (same flow as the `cron run` command).
   */
  private async handleNonOwnerRun(
    body: any,
    respond: RespondFn,
    args: { clickerId: string; owner: string; name: string },
  ): Promise<void> {
    const { clickerId, owner, name } = args;
    const job = this.storage()
      .getJobsByOwner(owner)
      .find((j) => j.name === name);
    if (!job) {
      await this.notFound(respond, name);
      return;
    }

    if (isRunAllowed(job, clickerId)) {
      await this.fireJob(body, respond, args);
      return;
    }

    const channel: string = body?.channel?.id ?? '';
    const threadTs: string | undefined = body?.message?.thread_ts;
    const slackApi = this.ctx.slackApi as unknown as CronRunPermissionSlackApi;
    const { delivered } = await requestCronRunPermission({
      slackApi,
      requesterId: clickerId,
      ownerId: owner,
      jobName: name,
      channel,
      threadTs,
      postFallback: channel
        ? (msg) => slackApi.postMessage(channel, msg.text, { threadTs, blocks: msg.blocks })
        : undefined,
    });
    await respond({
      response_type: 'ephemeral',
      replace_original: false,
      text: describeDelivery(delivered, owner, name),
    });
    this.logger.info('cron run permission requested via card', { clickerId, owner, name, delivered });
  }

  private async notFound(respond: RespondFn, name: string): Promise<void> {
    await respond({
      response_type: 'ephemeral',
      replace_original: false,
      text: `⚠️ 크론잡 \`${name}\` 을 찾을 수 없습니다 (이미 삭제되었을 수 있음). \`cron\` 으로 새로고침하세요.`,
    });
  }

  /** Re-render the card in place with the clicker's visibility scope. */
  private async rerenderCard(body: any, clickerId: string): Promise<void> {
    const channelId: string | undefined = body?.channel?.id;
    const messageTs: string | undefined = body?.message?.ts;
    if (!channelId || !messageTs) return;
    const admin = isAdminUser(clickerId);
    const storage = this.storage();
    const jobs = admin ? storage.getAll() : storage.getJobsByOwner(clickerId);
    const card = buildCronCard({ jobs, isAdmin: admin });
    await this.ctx.slackApi.updateMessage(channelId, messageTs, card.text, card.blocks, []).catch((err: unknown) =>
      this.logger.warn('cron rerender: updateMessage failed', {
        err: (err as Error)?.message ?? String(err),
      }),
    );
  }
}

/** Map a mode select value to a CronJobPatch ('default' clears the override). */
function buildModePatch(selected: string): CronJobPatch | null {
  if (selected === 'default') return { mode: null };
  if (selected === 'fastlane') return { mode: 'fastlane' };
  return null;
}

/** Map a model select value to a CronJobPatch. */
function buildModelPatch(selected: string): CronJobPatch | null {
  if (selected === CRON_MODEL_DEFAULT) return { modelConfig: null };
  if (selected === CRON_MODEL_FAST) return { modelConfig: { type: 'fast' } };
  if (selected.startsWith('custom:')) {
    const model = selected.slice('custom:'.length);
    if (!model) return null;
    return { modelConfig: { type: 'custom', model } };
  }
  return null;
}

/**
 * Map a target select value to a CronJobPatch. `thread` anchors to the thread
 * the card lives in (message.thread_ts, falling back to the card ts itself)
 * AND repoints the job's channel to the card's channel — the scheduler posts
 * thread replies as `threadReplier(job.channel, job.threadTs)` (cron-scheduler
 * executeJob), so a threadTs from another channel would otherwise reply into a
 * nonexistent thread of the old channel.
 */
function buildTargetPatch(selected: string, body: any): CronJobPatch | null {
  if (selected === 'channel') return { target: null, threadTs: null };
  if (selected === 'dm') return { target: 'dm', threadTs: null };
  if (selected === 'thread') {
    const ts: string | undefined = body?.message?.thread_ts ?? body?.message?.ts;
    const channelId: string | undefined = body?.channel?.id;
    if (!ts || !channelId) return null;
    return { target: 'thread', threadTs: ts, channel: channelId };
  }
  return null;
}
