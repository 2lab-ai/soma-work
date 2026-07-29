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
import { createCronRunRequest } from '../cron-run-request-store';
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
  jobName: string;
  /** Channel the requester asked from — the run result is reported back there. */
  channel: string;
  threadTs?: string;
  /** In-thread fallback used when the DM cannot be delivered. */
  postFallback?: (msg: { text: string; blocks: any[] }) => Promise<unknown>;
}

export type CronRunPermissionDelivery = 'dm' | 'fallback' | 'none';

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
    jobName: input.jobName,
    channel: input.channel,
    threadTs: input.threadTs,
  });
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
    await input.postFallback({ text: msg.text, blocks: msg.blocks });
    return { requestId: req.requestId, delivered: 'fallback' };
  }

  logger.error('cron run permission prompt undeliverable', {
    ownerId: input.ownerId,
    jobName: input.jobName,
  });
  return { requestId: req.requestId, delivered: 'none' };
}
