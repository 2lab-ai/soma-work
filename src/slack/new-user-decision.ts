/**
 * A new user's access request (#622) as ONE decision with two surfaces — the
 * admins' DM Accept / Deny buttons and the dashboard's admin approvals.
 *
 * The user's settings are the truth: a request is pending while the user's
 * record says `accepted: false`. {@link decideNewUser} is synchronous from the
 * check to the store write, so of two answers (two admins, Slack and the
 * dashboard) exactly one takes effect; the other reads "already answered".
 * Where each admin's DM landed and who answered are kept in the admin request
 * store, so every copy is rewritten with the outcome.
 */

import type { AdminApproval, AdminApprovalAdapter, AdminApprovalResolution } from '../admin-approvals';
import { notifyAdminApprovalsChanged } from '../admin-approvals';
import {
  type AdminRequest,
  type AdminRequestPrompt,
  getAdminRequest,
  listAdminRequests,
  markAdminRequest,
  openAdminRequest,
  setAdminRequestPrompts,
} from '../admin-request-store';
import { getAdminUsers, isAdminUser } from '../admin-utils';
import { Logger } from '../logger';
import { userSettingsStore } from '../user-settings-store';

const logger = new Logger('NewUserDecision');

/** A pending user can wait a long time; the round's record lives as long. */
const NEW_USER_REQUEST_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type NewUserDecision = 'accept' | 'deny';

export interface NewUserSlackApi {
  postMessage(
    channel: string,
    text: string,
    options?: { blocks?: any[]; threadTs?: string },
  ): Promise<{ ts?: string; channel?: string }>;
  updateMessage(channel: string, ts: string, text: string, blocks?: any[]): Promise<unknown>;
}

export type NewUserAnswer =
  | { ok: true; outcome: 'approved' | 'denied'; text: string; effects: Promise<void> }
  | { ok: false; reason: 'not_found' | 'not_admin' | 'already_answered' | 'failed'; message: string };

export function newUserPromptBlocks(userId: string, userName: string, round: number): any[] {
  // The button names its round: a button from an earlier round cannot decide a later one.
  const value = JSON.stringify({ userId, round });
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `🆕 *New User Request*\n<@${userId}>${userName ? ` (${userName})` : ''} wants to use the bot`,
      },
    },
    {
      type: 'actions',
      block_id: 'user_acceptance',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Accept' },
          action_id: 'accept_user',
          value,
          style: 'primary',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Deny' },
          action_id: 'deny_user',
          value,
          style: 'danger',
        },
      ],
    },
  ];
}

function outcomeText(
  userId: string,
  r: { outcome: 'approved' | 'denied'; by: string; via: 'slack' | 'dashboard' },
): string {
  const where = r.via === 'dashboard' ? ' (대시보드에서 응답)' : '';
  return r.outcome === 'approved'
    ? `✅ <@${userId}> accepted by <@${r.by}>${where}`
    : `❌ <@${userId}> denied by <@${r.by}>${where}`;
}

async function rewritePrompts(
  slackApi: Pick<NewUserSlackApi, 'updateMessage'> | undefined,
  prompts: AdminRequestPrompt[],
  text: string,
): Promise<void> {
  if (!slackApi) return;
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text } }];
  for (const p of prompts) {
    try {
      await slackApi.updateMessage(p.channel, p.ts, text, blocks);
    } catch (error) {
      logger.warn('new user: admin prompt rewrite failed', { error: (error as Error)?.message ?? String(error) });
    }
  }
}

/**
 * A new user asks: create the pending record and open its round in one
 * synchronous step, before anything awaits — so from the moment the user is
 * pending, only this round's buttons and card can decide them.
 */
export function createPendingUserRequest(userId: string, userName: string): void {
  // The round first: if it cannot be written, no pending user exists (the next message asks again),
  // so a pending user is never exposed under an earlier round.
  openAdminRequest({
    kind: 'new_user',
    requestId: userId,
    requesterId: userId,
    data: { userName },
    ttlMs: NEW_USER_REQUEST_TTL_MS,
    fresh: true,
  });
  userSettingsStore.createPendingUser(userId, userName);
  notifyAdminApprovalsChanged();
}

/**
 * Ask every admin, by DM, to accept a new user, and record where each prompt
 * landed (on the round {@link createPendingUserRequest} opened; one is opened
 * here if none is). Returns how many admins were reached.
 */
export async function notifyAdminsNewUser(
  slackApi: NewUserSlackApi,
  userId: string,
  userName: string,
  admins: Iterable<string> = getAdminUsers(),
): Promise<number> {
  const list = [...admins];
  if (list.length === 0) {
    logger.warn('No admin users configured, cannot notify about new user', { userId });
    return 0;
  }
  const round = openAdminRequest({
    kind: 'new_user',
    requestId: userId,
    requesterId: userId,
    data: { userName },
    ttlMs: NEW_USER_REQUEST_TTL_MS,
  });
  notifyAdminApprovalsChanged();
  const blocks = newUserPromptBlocks(userId, userName, round.createdAt);
  const prompts: AdminRequestPrompt[] = [];
  for (const adminId of list) {
    try {
      const posted = await slackApi.postMessage(adminId, `New user access request from <@${userId}>`, { blocks });
      if (posted?.ts) prompts.push({ channel: posted.channel ?? adminId, ts: posted.ts });
    } catch (error) {
      logger.error('Failed to send admin notification', { adminId, userId, error });
    }
  }
  const req = setAdminRequestPrompts('new_user', userId, prompts);
  // Answered on the dashboard while the DMs were going out: these copies were not reachable then.
  if (req?.handled && req.resolution) await rewritePrompts(slackApi, prompts, outcomeText(userId, req.resolution));
  return prompts.length;
}

/** The answer — synchronous from the check to the write; the DM rewrites and the user's notice follow in `effects`. */
export function decideNewUser(args: {
  userId: string;
  /**
   * The round the answering button / card was shown for (its `createdAt`).
   * `undefined` = a button from before rounds were recorded: it may answer
   * only a user with no open recorded round.
   */
  round?: number;
  decision: NewUserDecision;
  actor: string | undefined;
  via: 'slack' | 'dashboard';
  slackApi?: NewUserSlackApi;
  now?: number;
}): NewUserAnswer {
  const { userId, decision, actor, via, slackApi } = args;
  if (!actor || !isAdminUser(actor)) {
    return { ok: false, reason: 'not_admin', message: '⛔ Admin only action' };
  }
  const now = args.now ?? Date.now();
  const settings = userSettingsStore.getUserSettings(userId);
  const open = getAdminRequest('new_user', userId, now);
  if (!settings || settings.accepted) {
    const r = open?.resolution;
    if (r)
      return {
        ok: false,
        reason: 'already_answered',
        message: `⚠️ ${outcomeText(userId, r)} — 이미 처리된 요청입니다.`,
      };
    if (settings?.accepted) {
      return { ok: false, reason: 'already_answered', message: `⚠️ <@${userId}> 님은 이미 승인된 사용자입니다.` };
    }
    return { ok: false, reason: 'not_found', message: '⚠️ 더 이상 대기 중인 사용자 요청이 아닙니다.' };
  }
  // Only the round on display may be decided: an earlier round's button (or card) is stale.
  const staleRound =
    args.round !== undefined ? !open || open.createdAt !== args.round || open.handled : !!open && !open.handled;
  if (staleRound) {
    return {
      ok: false,
      reason: 'already_answered',
      message: '⚠️ 지난 요청의 버튼입니다 — 이 사용자의 최신 요청(새 DM 또는 대시보드)에서 답하세요.',
    };
  }
  const resolution = {
    by: actor,
    choiceId: decision,
    outcome: decision === 'accept' ? ('approved' as const) : ('denied' as const),
    via,
    at: now,
  };
  // The user's record is the decision: written (or refused) first. Nothing in between awaits, so of
  // two answers only the first finds the user pending.
  try {
    userSettingsStore.settlePendingUser(userId, actor, decision === 'accept');
  } catch (error) {
    logger.error('New user decision could not be saved', { userId, error });
    return { ok: false, reason: 'failed', message: '⚠️ 결정을 저장하지 못했습니다. 다시 시도해 주세요.' };
  }
  let marked: AdminRequest | null = null;
  try {
    marked = markAdminRequest('new_user', userId, resolution, {
      requesterId: userId,
      // A user pending from before rounds were recorded: its card carries no round.
      data: { userName: settings.slackName ?? '', legacy: '1' },
    });
  } catch (error) {
    // The decision stands (the user record is the truth); only who-answered bookkeeping is lost.
    logger.error('New user decision: could not record the answer', { userId, error });
  }
  const text = outcomeText(userId, resolution);
  logger.info('New user request answered', { userId, outcome: resolution.outcome, by: actor, via });
  notifyAdminApprovalsChanged();

  const effects = (async () => {
    // Every copy on record now — including any recorded while this ran.
    let prompts = marked?.prompts ?? [];
    try {
      prompts = getAdminRequest('new_user', userId)?.prompts ?? prompts;
    } catch {
      /* keep the copies read at the decision */
    }
    await rewritePrompts(slackApi, prompts, text);
    try {
      await slackApi?.postMessage(
        userId,
        decision === 'accept'
          ? '✅ 사용이 승인되었습니다! 메시지를 보내서 시작하세요.'
          : '❌ 사용 요청이 거부되었습니다. 관리자에게 문의하세요.',
        {},
      );
    } catch (error) {
      logger.error('Failed to notify the user of the decision', { userId, error });
    }
  })();
  return { ok: true, outcome: resolution.outcome, text, effects };
}

/**
 * The `admin accept|deny @user` command changed the user directly: end the
 * open round too, so the DM buttons and the dashboard card do not stay live.
 */
export async function closeNewUserRequest(
  userId: string,
  decision: NewUserDecision,
  actor: string,
  slackApi?: Pick<NewUserSlackApi, 'updateMessage'>,
): Promise<void> {
  const round = getAdminRequest('new_user', userId);
  if (!round || round.handled) return;
  const resolution = {
    by: actor,
    choiceId: decision,
    outcome: decision === 'accept' ? ('approved' as const) : ('denied' as const),
    via: 'slack' as const,
    at: Date.now(),
  };
  const marked = markAdminRequest('new_user', userId, resolution);
  if (!marked) return;
  notifyAdminApprovalsChanged();
  await rewritePrompts(slackApi, marked.prompts, outcomeText(userId, resolution));
}

/** One pending user as the approval card shows it — the DM's words and Accept / Deny. */
/** The dashboard id of a user's request: with its round when one is recorded. */
export function newUserApprovalId(userId: string, round: number | undefined): string {
  return round === undefined ? `new_user:${userId}` : `new_user:${userId}~${round}`;
}

export function newUserApproval(userId: string, userName: string, createdAt: number, round?: number): AdminApproval {
  return {
    id: newUserApprovalId(userId, round),
    kind: 'new_user',
    card: 'permission',
    title: '새 사용자 접근 요청',
    description: `${userName || userId} 님이 봇 사용을 요청했습니다. 승인하면 바로 사용할 수 있고, 거부하면 요청이 지워집니다.`,
    tool: 'new_user',
    rows: { 사용자: userId, ...(userName ? { 이름: userName } : {}) },
    risk: 'low',
    requesterId: userId,
    createdAt,
  };
}

function roundCreatedAt(round: AdminRequest | null, lastUpdated: string | undefined): number {
  if (round) return round.createdAt;
  const t = lastUpdated ? Date.parse(lastUpdated) : Number.NaN;
  return Number.isFinite(t) ? t : 0;
}

export function newUserAdminApprovalAdapter(slackApi: NewUserSlackApi): AdminApprovalAdapter {
  return {
    kind: 'new_user',
    pending(now) {
      return userSettingsStore
        .getAllUsers()
        .filter((u) => u.accepted === false)
        .map((u) => {
          const round = getAdminRequest('new_user', u.userId, now);
          const open = round && !round.handled ? round : null;
          return newUserApproval(
            u.userId,
            u.slackName ?? round?.data.userName ?? '',
            roundCreatedAt(round, u.lastUpdated),
            open?.createdAt,
          );
        });
    },
    resolved(since) {
      const out: AdminApprovalResolution[] = [];
      for (const req of listAdminRequests('new_user')) {
        const r = req.resolution;
        if (!req.handled || !r || r.at < since) continue;
        out.push({
          id: newUserApprovalId(req.requestId, req.data.legacy ? undefined : req.createdAt),
          outcome: r.outcome,
          choiceId: r.choiceId,
          by: r.by,
          via: r.via,
          at: r.at,
        });
      }
      return out;
    },
    async answer(requestId, choiceId, actor) {
      const decision = choiceId === 'approve' ? 'accept' : choiceId === 'deny' ? 'deny' : null;
      if (!decision) return { ok: false, reason: 'invalid' };
      const sep = requestId.lastIndexOf('~');
      const userId = sep > 0 ? requestId.slice(0, sep) : requestId;
      const round = sep > 0 ? Number(requestId.slice(sep + 1)) : undefined;
      if (round !== undefined && !Number.isFinite(round)) return { ok: false, reason: 'not_found' };
      const result = decideNewUser({ userId, round, decision, actor, via: 'dashboard', slackApi });
      if (!result.ok) {
        if (result.reason === 'failed') throw new Error(result.message);
        return { ok: false, reason: result.reason === 'not_admin' ? 'forbidden' : result.reason };
      }
      result.effects.catch((error: unknown) => logger.warn('new user dashboard answer: follow-up failed', error));
      return { ok: true, outcome: result.outcome };
    },
  };
}
