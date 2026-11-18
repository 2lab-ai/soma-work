/**
 * The admins' answers to a secret-use card (secret-access WU2, #1338, `.prd/33` §3.3):
 *   - ✅ 수락 (이 스레드)       → thread grant of each secret (12 h), then the requester's turn is sent again
 *   - ❌ 거부                   → no grant; the requester is told
 *   - 🔁 앞으로 계속 자동 수락   → "always" grant of each secret for the requester, then the turn is sent again
 *
 * Admin-bound: any admin (ADMIN_USERS) may answer, nobody else. The button carries only the `requestId`; names,
 * requester and thread are read from the admin request store, and `markAdminRequest` answers it exactly once in
 * the same synchronous span as the read — a second click, a second admin or the dashboard finds it answered.
 * Each answer is written to the secret audit ledger, one line per secret.
 */

import { type AdminRequest, getAdminRequest, markAdminRequest } from '../../admin-request-store';
import { isAdminUser } from '../../admin-utils';
import { Logger } from '../../logger';
import { appendSecretAudit, type SecretAuditAction } from '../../secrets/secret-audit';
import { addSecretThreadGrant, grantSecret } from '../../user-skill-grants-store';
import { describeRequestPlace } from '../env-skill-permission-blocks';
import {
  isSecretUseKind,
  type SecretUseKind,
  secretNamesText,
  VALUE_KIND_SECRET_ALWAYS,
  VALUE_KIND_SECRET_DENY,
} from '../secret-use-blocks';
import { secretUseView } from '../secret-use-request';
import type { SlackApiHelper } from '../slack-api-helper';
import type { MessageHandler, RespondFn, SayFn } from './types';

interface SecretUseContext {
  slackApi: Pick<SlackApiHelper, 'postMessage' | 'updateMessage'>;
  messageHandler: MessageHandler;
}

export type SecretUseDecisionResult =
  | { ok: true; outcome: 'approved' | 'denied'; effects: Promise<void> }
  | { ok: false; reason: 'not_found' | 'not_admin' | 'already_answered'; message: string };

const AUDIT_ACTION: Record<SecretUseKind, SecretAuditAction> = {
  secret_once: 'use.once',
  secret_deny: 'use.deny',
  secret_always: 'use.always',
};

export class SecretUseActionHandler {
  private logger = new Logger('SecretUseActionHandler');

  constructor(private ctx: SecretUseContext) {}

  async handleAction(body: any, respond: RespondFn): Promise<void> {
    try {
      const raw: unknown = body?.actions?.[0]?.value;
      let parsed: { kind?: unknown; requestId?: unknown } = {};
      try {
        parsed = typeof raw === 'string' ? JSON.parse(raw) : {};
      } catch {
        this.logger.warn('secret_use: malformed value JSON');
        return;
      }
      if (!isSecretUseKind(parsed.kind) || typeof parsed.requestId !== 'string' || !parsed.requestId) {
        this.logger.warn('secret_use: invalid kind/requestId');
        return;
      }
      const result = this.decide(parsed.requestId, parsed.kind, body?.user?.id, 'slack', respond);
      if (!result.ok) {
        await respond({ response_type: 'ephemeral', replace_original: false, text: result.message });
        return;
      }
      await result.effects;
    } catch (error) {
      this.logger.error('secret_use: unexpected error', error);
      await respond({
        response_type: 'ephemeral',
        replace_original: false,
        text: '⚠️ 비밀 사용 요청 처리 중 오류가 발생했습니다.',
      }).catch(() => undefined);
    }
  }

  /** One decision — the Slack buttons and the dashboard both come here. */
  decide(
    requestId: string,
    kind: SecretUseKind,
    actorId: string | undefined,
    via: 'slack' | 'dashboard',
    respond?: RespondFn,
  ): SecretUseDecisionResult {
    const req = getAdminRequest('secret_use', requestId);
    if (!req)
      return { ok: false, reason: 'not_found', message: '⚠️ 만료되었거나 더 이상 유효하지 않은 비밀 사용 요청입니다.' };
    if (!actorId || !isAdminUser(actorId)) {
      return { ok: false, reason: 'not_admin', message: '⚠️ 비밀 사용 요청은 어드민만 처리할 수 있습니다.' };
    }
    const outcome = kind === VALUE_KIND_SECRET_DENY ? 'denied' : 'approved';
    // The read above and this mark stay in one synchronous span: no await between them.
    const marked = markAdminRequest('secret_use', requestId, {
      by: actorId,
      choiceId: kind,
      outcome,
      via,
      at: Date.now(),
    });
    if (!marked) return { ok: false, reason: 'already_answered', message: '⚠️ 이미 처리된 비밀 사용 요청입니다.' };

    const view = secretUseView(req);
    const scope = { channel: view.channel, ...(view.threadTs ? { threadTs: view.threadTs } : {}) };
    for (const name of view.names) {
      if (kind === VALUE_KIND_SECRET_ALWAYS) grantSecret(name, view.requesterId);
      else if (kind !== VALUE_KIND_SECRET_DENY) addSecretThreadGrant(name, view.requesterId, scope);
      try {
        appendSecretAudit({
          actor: actorId,
          action: AUDIT_ACTION[kind],
          name,
          userId: view.requesterId,
          tool: view.tool,
          server: view.server,
        });
      } catch (error) {
        this.logger.error('secret_use: audit ledger write failed', { code: (error as NodeJS.ErrnoException)?.code });
      }
    }
    this.logger.info('secret_use: answered', { requestId, kind, admin: actorId, requester: view.requesterId, via });

    const where = via === 'dashboard' ? ' (대시보드에서 응답)' : '';
    const names = secretNamesText(view.names);
    const label =
      kind === VALUE_KIND_SECRET_DENY
        ? `🚫 <@${actorId}>님이 <@${view.requesterId}>님의 비밀 ${names} 사용 요청을 거부했습니다.${where}`
        : kind === VALUE_KIND_SECRET_ALWAYS
          ? `✅ <@${actorId}>님이 <@${view.requesterId}>님에게 비밀 ${names}을(를) 앞으로 계속 자동 수락했습니다.${where}`
          : `✅ <@${actorId}>님이 <@${view.requesterId}>님에게 비밀 ${names}을(를) ${describeRequestPlace(view.channel, view.threadTs)}에서 수락했습니다.${where}`;
    return {
      ok: true,
      outcome,
      effects: (async () => {
        await this.closePrompts(req, label, respond);
        if (outcome === 'denied') {
          await this.notify(
            view.channel,
            view.threadTs,
            `🚫 <@${view.requesterId}> — 비밀 ${names} 사용 요청이 거부되었습니다.`,
          );
          return;
        }
        const noticeTs = await this.notify(
          view.channel,
          view.threadTs,
          `✅ <@${view.requesterId}> — 어드민 <@${actorId}>님이 비밀 ${names} 사용을 허락했습니다. 이어서 진행합니다.`,
        );
        await this.fulfill(req, view.channel, view.threadTs, noticeTs);
      })(),
    };
  }

  /** Send the requester's run again as them, riding on the notice (as the environment-skill answer does). */
  private async fulfill(req: AdminRequest, channel: string, threadTs: string | undefined, noticeTs?: string) {
    const text = req.data.originalText;
    if (!text || !channel) return;
    await this.ctx.messageHandler(
      { user: req.requesterId, channel, thread_ts: threadTs, ts: noticeTs ?? '', text },
      this.sayIn(channel),
    );
  }

  private async closePrompts(req: AdminRequest, text: string, respond?: RespondFn): Promise<void> {
    const blocks = [{ type: 'section', text: { type: 'mrkdwn', text } }];
    if (respond) {
      await respond({ response_type: 'in_channel', replace_original: true, text, blocks }).catch((err: unknown) =>
        this.logger.warn('secret_use: clicked prompt replace failed', { err: (err as Error)?.message ?? String(err) }),
      );
    }
    for (const prompt of req.prompts ?? []) {
      await this.ctx.slackApi
        .updateMessage(prompt.channel, prompt.ts, text, blocks, [])
        .catch((err: unknown) =>
          this.logger.warn('secret_use: prompt close failed', { err: (err as Error)?.message ?? String(err) }),
        );
    }
  }

  private async notify(channel: string, threadTs: string | undefined, text: string): Promise<string | undefined> {
    if (!channel) return undefined;
    const posted = await this.ctx.slackApi.postMessage(channel, text, { threadTs }).catch((err: unknown) => {
      this.logger.warn('secret_use: requester notice failed', { err: (err as Error)?.message ?? String(err) });
      return undefined;
    });
    return posted?.ts || undefined;
  }

  private sayIn(channel: string): SayFn {
    return async (args: any) => {
      const msg = typeof args === 'string' ? { text: args } : args;
      return this.ctx.slackApi.postMessage(channel, msg.text, { threadTs: msg.thread_ts, blocks: msg.blocks });
    };
  }
}
