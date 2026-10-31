/**
 * A non-admin's request to delete a bot message (#623) as ONE decision with
 * two surfaces — the admins' DM 승인 / 거절 buttons and the dashboard's admin
 * approvals.
 *
 * The request is keyed by the target message (`<channel>/<ts>`), so a prompt
 * sent before this store existed maps to the same request. {@link
 * decideBotDelete} marks it answered synchronously before any side effect: of
 * two answers exactly one acts; the other reads "already answered". Every
 * admin's DM copy is rewritten with the outcome.
 */

import type { AdminApproval, AdminApprovalAdapter, AdminApprovalResolution } from '../admin-approvals';
import { notifyAdminApprovalsChanged } from '../admin-approvals';
import {
  type AdminRequest,
  type AdminRequestPrompt,
  adoptOrphanedClaim,
  getAdminRequest,
  isClaimLive,
  listAdminRequests,
  listOrphanedClaims,
  markAdminRequest,
  openAdminRequest,
  releaseLiveClaim,
  reopenAdminRequest,
  setAdminRequestPrompts,
  settleAdminRequest,
} from '../admin-request-store';
import { getAdminUsers, isAdminUser } from '../admin-utils';
import { Logger } from '../logger';

const logger = new Logger('BotDeleteDecision');

const BOT_DELETE_REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type BotDeleteDecision = 'approve' | 'reject';

export interface BotDeleteSlackApi {
  openDmChannel(userId: string): Promise<string>;
  postMessage(
    channel: string,
    text: string,
    options?: { blocks?: any[]; threadTs?: string },
  ): Promise<{ ts?: string; channel?: string }>;
  updateMessage(channel: string, ts: string, text: string, blocks?: any[]): Promise<unknown>;
  deleteMessage(channel: string, ts: string): Promise<unknown>;
}

export interface BotDeleteTarget {
  requesterId: string;
  targetChannel: string;
  targetTs: string;
}

export type BotDeleteAnswer =
  | { ok: true; outcome: 'approved' | 'denied'; text: string; effects: Promise<void> }
  | { ok: false; reason: 'not_found' | 'not_admin' | 'already_answered' | 'busy' | 'failed'; message: string };

export function botDeleteRequestId(targetChannel: string, targetTs: string): string {
  return `${targetChannel}/${targetTs}`;
}

function permalinkOf(targetChannel: string, targetTs: string): string {
  return `https://slack.com/archives/${targetChannel}/p${targetTs.replace('.', '')}`;
}

function outcomeText(r: { outcome: 'approved' | 'denied'; by: string; via: 'slack' | 'dashboard' }): string {
  const where = r.via === 'dashboard' ? ' (대시보드에서 응답)' : '';
  return r.outcome === 'approved'
    ? `✅ <@${r.by}>님이 삭제를 승인했습니다. 메시지가 삭제되었습니다.${where}`
    : `❌ <@${r.by}>님이 삭제 요청을 거절했습니다.${where}`;
}

async function rewritePrompts(slackApi: BotDeleteSlackApi | undefined, prompts: AdminRequestPrompt[], text: string) {
  if (!slackApi) return;
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text } }];
  for (const p of prompts) {
    try {
      await slackApi.updateMessage(p.channel, p.ts, text, blocks);
    } catch (error) {
      logger.warn('bot delete: admin prompt rewrite failed', { error: (error as Error)?.message ?? String(error) });
    }
  }
}

export function botDeletePromptBlocks(target: BotDeleteTarget, requestId: string): any[] {
  const value = JSON.stringify({ ...target, requestId });
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `<@${target.requesterId}>님이 봇 메시지 삭제를 요청했습니다.\n<${permalinkOf(target.targetChannel, target.targetTs)}|메시지 보기>`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: 'dm_delete_reject',
          text: { type: 'plain_text', text: '거절', emoji: true },
          value,
        },
        {
          type: 'button',
          action_id: 'dm_delete_approve',
          text: { type: 'plain_text', text: '승인', emoji: true },
          style: 'danger',
          value,
        },
      ],
    },
  ];
}

/**
 * Ask every admin, by DM, to approve deleting a bot message; record the
 * request and where each prompt landed. Returns how many admins were reached,
 * or `alreadyApproved` when a delete of this message was already approved
 * (done or in flight) — nobody is asked again.
 */
export async function requestBotDelete(
  slackApi: BotDeleteSlackApi,
  target: BotDeleteTarget & { preview?: string },
  admins: Iterable<string> = getAdminUsers(),
): Promise<number | 'alreadyApproved'> {
  const list = [...admins];
  if (list.length === 0) return 0;
  const requestId = botDeleteRequestId(target.targetChannel, target.targetTs);
  const round = openAdminRequest({
    kind: 'bot_delete',
    requestId,
    requesterId: target.requesterId,
    data: {
      targetChannel: target.targetChannel,
      targetTs: target.targetTs,
      ...(target.preview ? { preview: target.preview.slice(0, 300) } : {}),
    },
    ttlMs: BOT_DELETE_REQUEST_TTL_MS,
    // An approved delete (done, or still in flight) is not asked again: a second answer could contradict it.
    keepAnswered: (r) => r.resolution?.outcome === 'approved',
  });
  if (round.handled) return 'alreadyApproved';
  notifyAdminApprovalsChanged();
  const blocks = botDeletePromptBlocks(target, requestId);
  const prompts: AdminRequestPrompt[] = [];
  for (const adminId of list) {
    try {
      const dm = await slackApi.openDmChannel(adminId);
      const posted = await slackApi.postMessage(dm, '봇 메시지 삭제 요청', { blocks });
      if (posted?.ts) prompts.push({ channel: posted.channel ?? dm, ts: posted.ts });
    } catch (error) {
      logger.warn('Failed to send delete approval request to admin', { adminId, error });
    }
  }
  const req = setAdminRequestPrompts('bot_delete', requestId, prompts);
  // Decided while the DMs were going out: these copies were not reachable then. (A delete still in
  // flight is not a decision yet — its answer rewrites every recorded copy once it settles.)
  if (req?.handled && req.resolution && req.resolution.settled !== false) {
    await rewritePrompts(slackApi, prompts, outcomeText(req.resolution));
  }
  return prompts.length;
}

/** Slack answered, but only "try later": it says nothing about whether the delete happened. */
const TRANSIENT_SLACK_ERRORS = new Set([
  'ratelimited',
  'internal_error',
  'fatal_error',
  'service_unavailable',
  'request_timeout',
  'timeout',
]);

/**
 * What a failed `chat.delete` proves about the message: `gone` (already
 * deleted — counts as done), `stillThere` (Slack refused it with a definite
 * error — the delete did not happen), or `unknown` (a transport failure or a
 * transient error — it may have happened).
 */
function deleteFailure(error: unknown): 'gone' | 'stillThere' | 'unknown' {
  const code = (error as { data?: { error?: unknown } })?.data?.error;
  if (typeof code !== 'string') {
    const message = (error as Error)?.message;
    return typeof message === 'string' && message.includes('message_not_found') ? 'gone' : 'unknown';
  }
  if (code === 'message_not_found') return 'gone';
  return TRANSIENT_SLACK_ERRORS.has(code) ? 'unknown' : 'stillThere';
}

/** Slack located the message and refused to delete it: positive evidence that it still exists. */
const MESSAGE_EXISTS_REFUSALS = new Set(['cant_delete_message', 'compliance_exports_prevent_deletion']);

/**
 * What a failed REDO of an earlier approval proves. The earlier attempt may
 * have deleted the message; a refusal of this retry (no auth, no access, no
 * channel) says nothing about that. Only Slack finding the message and
 * refusing it proves it is still there.
 */
function redoFailure(error: unknown): 'gone' | 'stillThere' | 'unknown' {
  const proved = deleteFailure(error);
  if (proved !== 'stillThere') return proved;
  const code = (error as { data?: { error?: unknown } })?.data?.error;
  return typeof code === 'string' && MESSAGE_EXISTS_REFUSALS.has(code) ? 'stillThere' : 'unknown';
}

/**
 * The answer. Marked before the delete runs, so a second answer is refused at
 * once; a delete that fails (other than "already gone") reopens the request.
 */
export async function decideBotDelete(args: {
  requestId?: string;
  /** A button from before the request store (no requestId): its payload names the target. */
  legacy?: BotDeleteTarget;
  decision: BotDeleteDecision;
  actor: string | undefined;
  via: 'slack' | 'dashboard';
  slackApi: BotDeleteSlackApi;
  now?: number;
  /** Internal: the orphaned approval on this request was just reopened (retry once). */
  afterOrphan?: boolean;
}): Promise<BotDeleteAnswer> {
  const { decision, actor, via, slackApi } = args;
  if (!actor || !isAdminUser(actor)) {
    return { ok: false, reason: 'not_admin', message: '⚠️ 어드민만 이 버튼을 사용할 수 있습니다.' };
  }
  const now = args.now ?? Date.now();
  const requestId =
    args.requestId ?? (args.legacy ? botDeleteRequestId(args.legacy.targetChannel, args.legacy.targetTs) : '');
  const existing = requestId ? getAdminRequest('bot_delete', requestId, now) : null;
  if (!existing && !args.legacy) {
    return { ok: false, reason: 'not_found', message: '⚠️ 만료되었거나 더 이상 없는 삭제 요청입니다.' };
  }
  const target: BotDeleteTarget = existing
    ? {
        requesterId: existing.requesterId,
        targetChannel: existing.data.targetChannel,
        targetTs: existing.data.targetTs,
      }
    : (args.legacy as BotDeleteTarget);
  // An approval is a claim until the delete succeeds; a rejection is the decision at once.
  const resolution = {
    by: actor,
    choiceId: decision,
    outcome: decision === 'approve' ? ('approved' as const) : ('denied' as const),
    via,
    at: now,
    ...(decision === 'approve' ? { settled: false } : {}),
  };
  const marked = markAdminRequest(
    'bot_delete',
    requestId,
    resolution,
    existing
      ? undefined
      : { requesterId: target.requesterId, data: { targetChannel: target.targetChannel, targetTs: target.targetTs } },
  );
  if (!marked) {
    const held = getAdminRequest('bot_delete', requestId, now);
    const r = held?.resolution;
    if (held && r?.settled === false && !isClaimLive('bot_delete', requestId)) {
      // An approval a process that died was carrying out: its delete may or may not have happened.
      // Finish it first (redo the delete) — only if that fails is the request open to this answer.
      const finished = await finishOrphanedDelete(slackApi, held);
      if (finished === 'reopened' && !args.afterOrphan) return decideBotDelete({ ...args, afterOrphan: true });
      const settled = getAdminRequest('bot_delete', requestId)?.resolution;
      return {
        ok: false,
        reason: finished === 'busy' ? 'busy' : 'already_answered',
        message: settled ? `⚠️ 이미 처리된 요청입니다 — ${outcomeText(settled)}` : '⚠️ 이미 처리된 요청입니다.',
      };
    }
    if (r?.settled === false) {
      // Another admin's approval is still deleting: not a decision yet — answer again shortly.
      return {
        ok: false,
        reason: 'busy',
        message: '⏳ 다른 어드민의 삭제 승인을 처리하는 중입니다. 잠시 후 다시 시도하세요.',
      };
    }
    return {
      ok: false,
      reason: 'already_answered',
      message: r ? `⚠️ 이미 처리된 요청입니다 — ${outcomeText(r)}` : '⚠️ 이미 처리된 요청입니다.',
    };
  }
  if (decision === 'approve') {
    try {
      await slackApi.deleteMessage(target.targetChannel, target.targetTs);
    } catch (error) {
      const proved = deleteFailure(error);
      if (proved === 'stillThere') {
        reopenAdminRequest('bot_delete', requestId, resolution);
        logger.warn('Failed to delete message after admin approval', { requestId, error });
        return { ok: false, reason: 'failed', message: '⚠️ 메시지 삭제에 실패했습니다. 다시 시도할 수 있습니다.' };
      }
      if (proved === 'unknown') {
        // It may have been deleted: the approval stays claimed (no contradicting answer is admitted);
        // the next answer, or the next start, redoes the delete to find out.
        releaseLiveClaim('bot_delete', requestId);
        logger.warn('Bot message delete outcome unknown — kept claimed for a redo', { requestId, error });
        return {
          ok: false,
          reason: 'failed',
          message: '⚠️ 삭제 결과를 확인하지 못했습니다. 다시 누르면 삭제를 다시 시도합니다.',
        };
      }
    }
    if (!settleAdminRequest('bot_delete', requestId, resolution)) {
      // Not our answer on record any more (cannot happen while this process holds the claim; only a
      // restart in between). Another decision stands: this one neither settles nor rewrites anything.
      logger.error('Bot message delete finished but another answer is on record — leaving it', {
        requestId,
        by: actor,
      });
      return { ok: true, outcome: 'approved', text: outcomeText(resolution), effects: Promise.resolve() };
    }
  }
  const text = outcomeText(resolution);
  logger.info('Bot message delete request answered', { requestId, outcome: resolution.outcome, by: actor, via });
  notifyAdminApprovalsChanged();
  const effects = (async () => {
    // Every copy on record now — including any recorded while the delete was running.
    await rewritePrompts(slackApi, getAdminRequest('bot_delete', requestId)?.prompts ?? marked.prompts, text);
    try {
      const dm = await slackApi.openDmChannel(target.requesterId);
      await slackApi.postMessage(
        dm,
        decision === 'approve'
          ? '✅ 어드민이 삭제 요청을 승인했습니다. 메시지가 삭제되었습니다.'
          : '❌ 어드민이 삭제 요청을 거절했습니다.',
      );
    } catch {
      // Best-effort notification only.
    }
  })();
  return { ok: true, outcome: resolution.outcome, text, effects };
}

/**
 * Carry out an approval a process that died left unsettled: redo the delete
 * (a message already gone counts as deleted). Done → the original approval
 * becomes the decision and every DM copy says so; failed → the request is open
 * again. `busy` if this process is already carrying it out.
 */
export async function finishOrphanedDelete(
  slackApi: BotDeleteSlackApi,
  req: AdminRequest,
): Promise<'settled' | 'reopened' | 'busy' | 'superseded'> {
  const original = req.resolution;
  if (!original || original.settled !== false) return 'settled';
  if (!adoptOrphanedClaim('bot_delete', req.requestId)) return 'busy';
  const { targetChannel, targetTs } = req.data;
  try {
    await slackApi.deleteMessage(targetChannel, targetTs);
  } catch (error) {
    const proved = redoFailure(error);
    if (proved === 'stillThere') {
      reopenAdminRequest('bot_delete', req.requestId, original);
      logger.warn('Orphaned bot-message delete was refused — the message is there; the request is open again', {
        requestId: req.requestId,
        error,
      });
      notifyAdminApprovalsChanged();
      return 'reopened';
    }
    if (proved === 'unknown') {
      // Slack unreachable proves nothing: the approval stays claimed until a redo gets an answer.
      releaseLiveClaim('bot_delete', req.requestId);
      logger.warn('Orphaned bot-message delete outcome still unknown — kept claimed', {
        requestId: req.requestId,
        error,
      });
      return 'busy';
    }
  }
  const settled = settleAdminRequest('bot_delete', req.requestId, original);
  if (!settled) {
    // Another answer is on record by now: it stands. Nothing is rewritten and nobody is told.
    logger.warn('Orphaned bot-message delete finished but another answer is on record — leaving it', {
      requestId: req.requestId,
    });
    notifyAdminApprovalsChanged();
    return 'superseded';
  }
  logger.info('Orphaned bot-message delete finished', { requestId: req.requestId, by: original.by });
  notifyAdminApprovalsChanged();
  const text = outcomeText(original);
  await rewritePrompts(slackApi, settled.prompts, text);
  try {
    const dm = await slackApi.openDmChannel(req.requesterId);
    await slackApi.postMessage(dm, '✅ 어드민이 삭제 요청을 승인했습니다. 메시지가 삭제되었습니다.');
  } catch {
    // Best-effort notification only.
  }
  return 'settled';
}

/** At startup: finish every approval a process that died left unsettled. */
export async function reconcileBotDeletes(slackApi: BotDeleteSlackApi): Promise<number> {
  let finished = 0;
  for (const req of listOrphanedClaims('bot_delete')) {
    try {
      if ((await finishOrphanedDelete(slackApi, req)) === 'settled') finished++;
    } catch (error) {
      logger.warn('Reconciling an orphaned bot-message delete failed', { requestId: req.requestId, error });
    }
  }
  return finished;
}

export function botDeleteApproval(
  requestId: string,
  req: { requesterId: string; data: Record<string, string>; createdAt: number },
): AdminApproval {
  const { targetChannel, targetTs, preview } = req.data;
  return {
    id: `bot_delete:${requestId}`,
    kind: 'bot_delete',
    card: 'permission',
    title: '봇 메시지 삭제 요청',
    description: `승인하면 이 봇 메시지를 지웁니다. ${permalinkOf(targetChannel, targetTs)}`,
    tool: 'delete_message',
    rows: {
      요청자: req.requesterId,
      채널: targetChannel,
      메시지: targetTs,
      ...(preview ? { 미리보기: preview } : {}),
    },
    risk: 'medium',
    requesterId: req.requesterId,
    place: { channel: targetChannel },
    createdAt: req.createdAt,
  };
}

export function botDeleteAdminApprovalAdapter(slackApi: BotDeleteSlackApi): AdminApprovalAdapter {
  return {
    kind: 'bot_delete',
    pending(now) {
      return listAdminRequests('bot_delete', now)
        .filter((r) => !r.handled)
        .map((r) => botDeleteApproval(r.requestId, r));
    },
    resolved(since) {
      const out: AdminApprovalResolution[] = [];
      for (const req of listAdminRequests('bot_delete')) {
        const r = req.resolution;
        if (!req.handled || !r || r.settled === false || r.at < since) continue;
        out.push({
          id: `bot_delete:${req.requestId}`,
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
      const decision = choiceId === 'approve' ? 'approve' : choiceId === 'deny' ? 'reject' : null;
      if (!decision) return { ok: false, reason: 'invalid' };
      const result = await decideBotDelete({ requestId, decision, actor, via: 'dashboard', slackApi });
      if (!result.ok) {
        if (result.reason === 'failed') throw new Error(result.message);
        return { ok: false, reason: result.reason === 'not_admin' ? 'forbidden' : result.reason };
      }
      result.effects.catch((error: unknown) => logger.warn('bot delete dashboard answer: follow-up failed', error));
      return { ok: true, outcome: result.outcome };
    },
  };
}
