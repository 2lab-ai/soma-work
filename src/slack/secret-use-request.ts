/**
 * Ask the admins whether a requester's tools may use secrets (secret-access WU2, #1338, `.prd/33` §3.3).
 *
 * The policy hook denied a non-admin's server-tools call that uses secrets the requester holds no grant for
 * (`onSecretUseDenied`). This records the request in the admin request store (kind `secret_use`), DMs every admin
 * the 3-answer card, and tells the requester in their thread — once: the model may call the same tool several
 * times, and one unanswered card per (requester, secrets, thread) is enough.
 *
 * When no DM can be delivered the card goes to the asking thread with the admins mentioned; when even that fails
 * or no admin is configured, the request is closed so a retry asks again instead of waiting on a card nobody saw.
 * Names only: no value is ever read here.
 */

import { createHash } from 'node:crypto';
import {
  type AdminRequest,
  type AdminRequestPrompt,
  markAdminRequest,
  openAdminRequest,
  setAdminRequestPrompts,
} from '../admin-request-store';
import { getAdminUsers } from '../admin-utils';
import { Logger } from '../logger';
import { buildSecretUseMessage, SECRET_NAMES_TEXT_MAX, type SecretUseView, secretNamesText } from './secret-use-blocks';

const logger = new Logger('SecretUseRequest');

/** How long an unanswered card stays answerable — as long as an environment-skill request. */
export const SECRET_USE_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

export interface SecretUseSlackApi {
  openDmChannel(userId: string): Promise<string>;
  postMessage(
    channel: string,
    text: string,
    options?: { threadTs?: string; blocks?: any[] },
  ): Promise<{ ts?: string; channel?: string }>;
  updateMessage(channel: string, ts: string, text: string, blocks?: any[]): Promise<unknown>;
}

export interface RequestSecretUseInput {
  slackApi: SecretUseSlackApi;
  requesterId: string;
  names: readonly string[];
  tool: string;
  server: string;
  channel: string;
  threadTs?: string;
  adminOnlyTool: boolean;
  /** Sent again as the requester once an admin allows it, to continue the run. */
  originalText: string;
}

export type SecretUseDelivery = 'dm' | 'fallback' | 'none' | 'pending';

/**
 * Rounds whose card is going out right now. Prompts are recorded only once Slack answers, so a second denial in that
 * window (the model's parallel tool calls) would otherwise send a second card: it is claimed here, synchronously,
 * before the first await.
 */
const delivering = new Set<string>();

/** One request per (requester, secret set, thread): the same ask in the same thread is the same card. */
export function secretUseRequestId(requesterId: string, names: readonly string[], channel: string, threadTs?: string) {
  const key = [requesterId, [...names].sort().join(','), channel, threadTs ?? ''].join('\u0000');
  return createHash('sha256').update(key).digest('hex').slice(0, 24);
}

/** The view a card is drawn from — the request's own record, never a button payload. */
export function secretUseView(req: AdminRequest): SecretUseView {
  return {
    requestId: req.requestId,
    round: String(req.createdAt),
    requesterId: req.requesterId,
    names: (req.data.names ?? '').split(',').filter(Boolean),
    tool: req.data.tool ?? '',
    server: req.data.server ?? '',
    channel: req.data.channel ?? '',
    ...(req.data.threadTs ? { threadTs: req.data.threadTs } : {}),
    adminOnlyTool: req.data.adminOnlyTool === '1',
  };
}

function describeDelivery(delivered: SecretUseDelivery, names: readonly string[]): string {
  const what = `비밀 ${secretNamesText(names, SECRET_NAMES_TEXT_MAX)}`;
  switch (delivered) {
    case 'none':
      return `⚠️ ${what} 사용은 어드민 승인이 필요하지만 요청을 전달하지 못했습니다(어드민 미설정 또는 Slack 오류). 어드민에게 직접 문의하세요.`;
    case 'fallback':
      return `🔑 ${what} 사용은 어드민 승인이 필요합니다. 이 스레드에 승인 요청을 올렸습니다. 승인되면 이어서 진행합니다.`;
    default:
      return `🔑 ${what} 사용은 어드민 승인이 필요합니다. 어드민에게 DM으로 요청을 보냈습니다. 승인되면 이 스레드에서 이어서 진행합니다.`;
  }
}

/** Record, deliver, tell the requester. Never throws: a failure here must not break the turn that hit the gate. */
export async function requestSecretUse(
  input: RequestSecretUseInput,
): Promise<{ requestId: string; delivered: SecretUseDelivery }> {
  const requestId = secretUseRequestId(input.requesterId, input.names, input.channel, input.threadTs);
  let claimed = '';
  try {
    const req = openAdminRequest({
      kind: 'secret_use',
      requestId,
      requesterId: input.requesterId,
      ttlMs: SECRET_USE_REQUEST_TTL_MS,
      data: {
        names: [...input.names].sort().join(','),
        tool: input.tool,
        server: input.server,
        channel: input.channel,
        ...(input.threadTs ? { threadTs: input.threadTs } : {}),
        adminOnlyTool: input.adminOnlyTool ? '1' : '0',
        originalText: input.originalText,
      },
    });
    // An unanswered card is already in the admins' DMs: re-sending on every retry would spam them.
    if (req.prompts.length > 0) return { requestId, delivered: 'pending' };
    const round = `${requestId}@${req.createdAt}`;
    if (delivering.has(round)) return { requestId, delivered: 'pending' };
    delivering.add(round);
    claimed = round;
    const delivered = await deliver(input, req);
    await input.slackApi
      .postMessage(input.channel, describeDelivery(delivered, input.names), { threadTs: input.threadTs })
      .catch((err: unknown) =>
        logger.warn('secret use: requester notice failed', { err: (err as Error)?.message ?? String(err) }),
      );
    logger.info('secret use requested', { requestId, requester: input.requesterId, names: input.names, delivered });
    return { requestId, delivered };
  } catch (error) {
    logger.error('secret use request failed', { requestId, error: (error as Error)?.message ?? String(error) });
    return { requestId, delivered: 'none' };
  } finally {
    if (claimed) delivering.delete(claimed);
  }
}

async function deliver(input: RequestSecretUseInput, req: AdminRequest): Promise<SecretUseDelivery> {
  const admins = [...getAdminUsers()];
  const msg = buildSecretUseMessage(secretUseView(req));
  const close = () =>
    markAdminRequest('secret_use', req.requestId, {
      by: 'system',
      choiceId: 'undelivered',
      outcome: 'denied',
      via: 'slack',
      at: Date.now(),
    });
  if (admins.length === 0) {
    close();
    logger.error('secret use: no admin configured (ADMIN_USERS)');
    return 'none';
  }
  const prompts: AdminRequestPrompt[] = [];
  for (const admin of admins) {
    try {
      const dm = await input.slackApi.openDmChannel(admin);
      const posted = await input.slackApi.postMessage(dm, msg.text, { blocks: msg.blocks });
      if (posted.ts) prompts.push({ channel: posted.channel ?? dm, ts: posted.ts });
    } catch (error) {
      logger.warn('secret use DM failed', { admin, error: (error as Error)?.message ?? String(error) });
    }
  }
  if (prompts.length > 0) {
    await closeIfAnswered(input.slackApi, setAdminRequestPrompts('secret_use', req.requestId, prompts), prompts);
    return 'dm';
  }
  try {
    const mentions = admins.map((a) => `<@${a}>`).join(' ');
    const posted = await input.slackApi.postMessage(input.channel, `${mentions} ${msg.text}`, {
      threadTs: input.threadTs,
      blocks: msg.blocks,
    });
    if (posted.ts) {
      const ref = [{ channel: posted.channel ?? input.channel, ts: posted.ts }];
      await closeIfAnswered(input.slackApi, setAdminRequestPrompts('secret_use', req.requestId, ref), ref);
      return 'fallback';
    }
  } catch (error) {
    logger.warn('secret use thread fallback failed', { error: (error as Error)?.message ?? String(error) });
  }
  close();
  return 'none';
}

/** The card went out while an admin answered on the dashboard: rewrite these copies instead of leaving buttons. */
async function closeIfAnswered(
  slackApi: SecretUseSlackApi,
  req: AdminRequest | null,
  prompts: AdminRequestPrompt[],
): Promise<void> {
  if (!req?.handled || !req.resolution) return;
  const r = req.resolution;
  const text = `${r.outcome === 'approved' ? '✅' : '🚫'} <@${r.by}>님이 이 비밀 사용 요청을 이미 ${r.outcome === 'approved' ? '허락' : '거부'}했습니다.`;
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text } }];
  for (const p of prompts) {
    await slackApi
      .updateMessage(p.channel, p.ts, text, blocks)
      .catch((err: unknown) =>
        logger.warn('secret use: late prompt close failed', { err: (err as Error)?.message ?? String(err) }),
      );
  }
}
