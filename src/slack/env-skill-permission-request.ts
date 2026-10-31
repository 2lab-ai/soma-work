/**
 * Ask the admins for permission to run an environment skill.
 *
 * Shared by both entry points — a typed `$plugin:skill` (`SkillForceHandler`) and the model's
 * `Skill` tool call that step 6b of `evaluateToolPolicy` denied (the PreToolUse hook) — so they
 * behave identically: record the request, DM every admin the prompt, and tell the requester in the
 * asking thread what happened. The cron-run ask (`cron-run-permission-request.ts`) is the pattern;
 * the difference is that any admin, not one owner, decides.
 *
 * When no DM can be delivered the prompt goes to the asking thread instead, with the admins
 * mentioned; when even that fails, or no admin is configured, the request is retired so a retry
 * asks again rather than waiting on a prompt nobody saw.
 */
import { getAdminUsers } from '../admin-utils';
import { Logger } from '../logger';
import {
  createPermissionRequest,
  markRequestHandled,
  type PermissionRequest,
  type PromptRef,
  setRequestPrompts,
} from '../skill-permission-request-store';
import { ENV_SKILL_GRANT_OWNER } from '../user-skill-grants-store';
import { buildEnvSkillPermissionMessage } from './env-skill-permission-blocks';

const logger = new Logger('EnvSkillPermissionRequest');

/** The slice of SlackApiHelper this module needs (keeps tests light). */
export interface EnvSkillPermissionSlackApi {
  openDmChannel(userId: string): Promise<string>;
  postMessage(
    channel: string,
    text: string,
    options?: { threadTs?: string; blocks?: any[] },
  ): Promise<{ ts?: string; channel?: string }>;
  /** Rewrite a prompt that went out after its request was already answered (#620). */
  updateMessage?(channel: string, ts: string, text: string, blocks?: any[]): Promise<unknown>;
}

export interface RequestEnvSkillPermissionInput {
  slackApi: EnvSkillPermissionSlackApi;
  requesterId: string;
  /** `plugin:skill` */
  skillKey: string;
  channel: string;
  threadTs?: string;
  /** Sent again as the requester once an admin allows it, to fulfil the ask. */
  originalText: string;
  /** Test seam — defaults to ADMIN_USERS. */
  admins?: readonly string[];
  /**
   * Post the "already pending" notice when an identical ask is unanswered (default true). The
   * model-side hook passes false: a run may hit the same skill several times, and one notice is enough.
   */
  notifyWhenPending?: boolean;
}

/**
 * How the prompt reached the admins:
 *   dm       — DM delivered to at least one admin
 *   fallback — every DM failed; prompt posted in the asking thread
 *   none     — could not be delivered (or no admin is configured)
 *   pending  — an identical unanswered ask already exists for this thread; nothing re-sent
 */
export type EnvSkillPermissionDelivery = 'dm' | 'fallback' | 'none' | 'pending';

/** One phrasing of the outcome, posted to the requester's thread. */
export function describeEnvSkillDelivery(delivered: EnvSkillPermissionDelivery, skillKey: string): string {
  switch (delivered) {
    case 'pending':
      return `⏳ 환경 스킬 \`${skillKey}\` 권한 요청이 이미 어드민에게 대기 중입니다. 승인되면 이 스레드에서 이어서 실행합니다.`;
    case 'none':
      return `⚠️ 환경 스킬 \`${skillKey}\` 은 어드민 승인이 필요하지만 요청을 전달하지 못했습니다(어드민 미설정 또는 Slack 오류). 어드민에게 직접 문의하세요.`;
    case 'fallback':
      return `🔐 환경 스킬 \`${skillKey}\` 은 어드민 승인이 필요합니다. 이 스레드에 승인 요청을 올렸습니다. 승인되면 이어서 실행합니다.`;
    default:
      return `🔐 환경 스킬 \`${skillKey}\` 은 어드민 승인이 필요합니다. 어드민에게 DM으로 승인 요청을 보냈습니다. 승인되면 이 스레드에서 이어서 실행합니다.`;
  }
}

/**
 * Record the request, deliver the admin prompt, and post the outcome to the requester's thread.
 * Never throws: a failure here must not break the turn that hit the gate.
 */
export async function requestEnvSkillPermission(
  input: RequestEnvSkillPermissionInput,
): Promise<{ requestId: string; delivered: EnvSkillPermissionDelivery }> {
  const { slackApi, requesterId, skillKey, channel, threadTs } = input;
  const req = createPermissionRequest({
    operation: 'invoke',
    requesterId,
    ownerId: ENV_SKILL_GRANT_OWNER,
    skillName: skillKey,
    channel,
    threadTs,
    originalText: input.originalText,
  });

  let delivered: EnvSkillPermissionDelivery;
  if (req.reused) {
    // An unanswered ask already sits in the admins' DMs. Re-sending on every retry
    // (the model may call the skill several times in one turn) would spam them.
    delivered = 'pending';
  } else {
    delivered = await deliver(input, req.requestId);
  }

  if (delivered !== 'pending' || input.notifyWhenPending !== false) {
    await slackApi
      .postMessage(channel, describeEnvSkillDelivery(delivered, skillKey), { threadTs })
      .catch((err: unknown) =>
        logger.warn('env-skill permission: requester notice failed', { err: (err as Error)?.message ?? String(err) }),
      );
  }
  logger.info('env-skill permission requested', { requestId: req.requestId, requesterId, skillKey, delivered });
  return { requestId: req.requestId, delivered };
}

/**
 * The prompts went out while an admin answered on the dashboard (the request
 * was listed there before its DMs landed): the answer could not reach them, so
 * they are rewritten here instead of keeping live buttons.
 */
async function closeIfAlreadyAnswered(
  slackApi: EnvSkillPermissionSlackApi,
  req: PermissionRequest | null,
  prompts: PromptRef[],
): Promise<void> {
  if (!req?.handled || !slackApi.updateMessage) return;
  const r = req.resolution;
  const text = r
    ? `${r.outcome === 'approved' ? '✅' : '🚫'} <@${r.by}>님이 ${r.via === 'dashboard' ? '대시보드' : 'Slack'}에서 이 환경 스킬 요청을 이미 ${r.outcome === 'approved' ? '허용' : '거부'}했습니다.`
    : '⚠️ 이미 처리된 환경 스킬 권한 요청입니다.';
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text } }];
  for (const p of prompts) {
    await slackApi
      .updateMessage(p.channel, p.ts, text, blocks)
      .catch((err: unknown) =>
        logger.warn('env-skill permission: late prompt close failed', { err: (err as Error)?.message ?? String(err) }),
      );
  }
}

async function deliver(input: RequestEnvSkillPermissionInput, requestId: string): Promise<EnvSkillPermissionDelivery> {
  const { slackApi, requesterId, skillKey, channel, threadTs } = input;
  const admins = [...(input.admins ?? getAdminUsers())];
  if (admins.length === 0) {
    markRequestHandled(requestId);
    logger.error('env-skill permission: no admin configured (ADMIN_USERS)', { skillKey });
    return 'none';
  }
  const msg = buildEnvSkillPermissionMessage({ requestId, requesterId, skillKey, channel, threadTs });

  const prompts: PromptRef[] = [];
  for (const admin of admins) {
    try {
      const dm = await slackApi.openDmChannel(admin);
      const posted = await slackApi.postMessage(dm, msg.text, { blocks: msg.blocks });
      if (posted.ts) prompts.push({ channel: posted.channel ?? dm, ts: posted.ts });
    } catch (error) {
      logger.warn('env-skill permission DM failed', {
        admin,
        skillKey,
        error: (error as Error)?.message ?? String(error),
      });
    }
  }
  if (prompts.length > 0) {
    await closeIfAlreadyAnswered(slackApi, setRequestPrompts(requestId, prompts), prompts);
    return 'dm';
  }

  try {
    const mentions = admins.map((a) => `<@${a}>`).join(' ');
    const posted = await slackApi.postMessage(channel, `${mentions} ${msg.text}`, { threadTs, blocks: msg.blocks });
    if (posted.ts) {
      const ref = [{ channel: posted.channel ?? channel, ts: posted.ts }];
      await closeIfAlreadyAnswered(slackApi, setRequestPrompts(requestId, ref), ref);
    }
    return 'fallback';
  } catch (error) {
    logger.warn('env-skill permission thread fallback failed', {
      skillKey,
      error: (error as Error)?.message ?? String(error),
    });
  }
  // Nothing reached an admin: retire the request so a retry asks again.
  markRequestHandled(requestId);
  return 'none';
}
