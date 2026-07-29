/**
 * Ask a cron job's owner for permission to fire it on demand.
 *
 * Shared by both trigger surfaces — the `cron run <name>` command and the ▶
 * button on the cron card — so they behave identically: record the request,
 * DM the owner the 3-button prompt, and fall back to posting the prompt in the
 * asking thread when the DM cannot be delivered (owner has DMs closed, bot not
 * in a DM with them, Slack error). Never swallow the failure silently: an
 * undelivered prompt would leave the requester waiting forever.
 */
import { createCronRunRequest, markCronRunRequestHandled } from '../cron-run-request-store';
import { Logger } from '../logger';
import { buildCronRunPermissionMessage } from './cron-run-permission-blocks';

const logger = new Logger('CronRunPermissionRequest');

/** The slice of SlackApiHelper this module needs (keeps tests light). */
export interface CronRunPermissionSlackApi {
  openDmChannel(userId: string): Promise<string>;
  postMessage(
    channel: string,
    text: string,
    options?: { threadTs?: string; blocks?: any[] },
  ): Promise<{ ts?: string; channel?: string }>;
}

export interface RequestCronRunPermissionInput {
  slackApi?: CronRunPermissionSlackApi;
  requesterId: string;
  ownerId: string;
  /** Immutable job id — what the consent is actually bound to. */
  jobId: string;
  jobName: string;
  /** Channel the requester asked from — the run result is reported back there. */
  channel: string;
  threadTs?: string;
  /** In-thread fallback used when the DM cannot be delivered. */
  postFallback?: (msg: { text: string; blocks: any[] }) => Promise<unknown>;
}

/**
 * How the owner prompt reached the owner:
 *   dm       — DM delivered
 *   fallback — DM failed, prompt posted in the asking thread
 *   none     — could not be delivered at all (tell the requester the truth)
 *   pending  — an identical unanswered ask already exists; nothing re-sent
 */
export type CronRunPermissionDelivery = 'dm' | 'fallback' | 'none' | 'pending';

/**
 * Record the request and deliver the owner prompt. Returns how it was
 * delivered so the caller can tell the requester the truth.
 */
export async function requestCronRunPermission(
  input: RequestCronRunPermissionInput,
): Promise<{ requestId: string; delivered: CronRunPermissionDelivery }> {
  const req = createCronRunRequest({
    requesterId: input.requesterId,
    ownerId: input.ownerId,
    jobId: input.jobId,
    jobName: input.jobName,
    channel: input.channel,
    threadTs: input.threadTs,
  });
  // An unanswered ask is already sitting in the owner's DMs. Re-sending on
  // every retry turns `cron run` into a DM-bombing tool — say nothing more.
  if (req.reused) {
    return { requestId: req.requestId, delivered: 'pending' };
  }
  const msg = buildCronRunPermissionMessage({
    requestId: req.requestId,
    requesterId: input.requesterId,
    ownerId: input.ownerId,
    jobName: input.jobName,
  });

  if (input.slackApi) {
    try {
      const dmChannel = await input.slackApi.openDmChannel(input.ownerId);
      await input.slackApi.postMessage(dmChannel, msg.text, { blocks: msg.blocks });
      return { requestId: req.requestId, delivered: 'dm' };
    } catch (error) {
      logger.warn('cron run permission DM failed — falling back to thread', {
        ownerId: input.ownerId,
        jobName: input.jobName,
        error: (error as Error)?.message ?? String(error),
      });
    }
  }

  if (input.postFallback) {
    try {
      await input.postFallback({ text: msg.text, blocks: msg.blocks });
      return { requestId: req.requestId, delivered: 'fallback' };
    } catch (error) {
      logger.warn('cron run permission thread fallback failed', {
        ownerId: input.ownerId,
        jobName: input.jobName,
        error: (error as Error)?.message ?? String(error),
      });
    }
  }

  // Nothing reached the owner. Retiring the request matters: a live unhandled
  // request would make every retry dedupe into "already pending" and sit there
  // until the 24h TTL — a prompt nobody ever saw, blocking every later ask.
  markCronRunRequestHandled(req.requestId);
  logger.error('cron run permission prompt undeliverable', {
    ownerId: input.ownerId,
    jobName: input.jobName,
  });
  return { requestId: req.requestId, delivered: 'none' };
}

/** One phrasing of the permission-request outcome, shared by both surfaces. */
export function describeDelivery(delivered: CronRunPermissionDelivery, ownerId: string, jobName: string): string {
  switch (delivered) {
    case 'none':
      return `⚠️ <@${ownerId}>님께 \`${jobName}\` 실행 권한 요청을 전달하지 못했습니다. 오너에게 직접 문의하세요.`;
    case 'pending':
      return `⏳ \`${jobName}\` 실행 권한 요청이 이미 <@${ownerId}>님께 대기 중입니다. 승인되면 실행됩니다.`;
    case 'dm':
      return `🔐 <@${ownerId}>님께 \`${jobName}\` 실행 권한을 요청했습니다 (DM 발송). 승인되면 오너 권한으로 실행됩니다.`;
    default:
      return `🔐 <@${ownerId}>님께 \`${jobName}\` 실행 권한을 요청했습니다. 승인되면 오너 권한으로 실행됩니다.`;
  }
}
