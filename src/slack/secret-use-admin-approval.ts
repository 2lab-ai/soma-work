/**
 * Secret-use requests as dashboard admin approvals (secret-access WU2, #1338): the same card as the admins' DM —
 * 수락 (이 스레드) · 거부 · 앞으로 계속 자동 수락 — answered through the same decision the Slack buttons take
 * (`SecretUseActionHandler.decide`), so either surface grants once, rewrites every DM and re-sends the turn.
 */

import type { AdminApproval, AdminApprovalAdapter, AdminApprovalResolution } from '../admin-approvals';
import { listAdminRequests } from '../admin-request-store';
import { Logger } from '../logger';
import type { SecretUseActionHandler } from './actions/secret-use-action-handler';
import {
  isSecretUseKind,
  secretNamesText,
  secretUseChoices,
  VALUE_KIND_SECRET_DENY,
  VALUE_KIND_SECRET_ONCE,
} from './secret-use-blocks';
import { secretUseView } from './secret-use-request';

const logger = new Logger('SecretUseAdminApproval');

export function secretUseAdminApprovalAdapter(handler: Pick<SecretUseActionHandler, 'decide'>): AdminApprovalAdapter {
  return {
    kind: 'secret_use',
    pending(now) {
      return listAdminRequests('secret_use', now)
        .filter((req) => !req.handled)
        .map((req): AdminApproval => {
          const view = secretUseView(req);
          return {
            id: `secret_use:${req.requestId}`,
            kind: 'secret_use',
            card: 'question',
            title: `비밀 ${secretNamesText(view.names)} 사용 요청`,
            summary: `비밀 ${secretNamesText(view.names)} 사용을 이 스레드에서 수락 — ${view.tool} · ${view.server}`,
            description:
              '모델은 값을 보지 않습니다 — 봇의 도구가 대신 씁니다. 허락하면 요청한 턴을 다시 보내 이어서 진행합니다.' +
              (view.adminOnlyTool ? ' ⚠️ 원래 어드민 전용 도구입니다.' : ''),
            choices: secretUseChoices().map((c) => ({ id: c.kind, label: c.label })),
            recommendedId: VALUE_KIND_SECRET_ONCE,
            risk: view.adminOnlyTool ? 'high' : 'medium',
            batch: { approve: VALUE_KIND_SECRET_ONCE, deny: VALUE_KIND_SECRET_DENY },
            requesterId: req.requesterId,
            place: { channel: view.channel, ...(view.threadTs ? { threadTs: view.threadTs } : {}) },
            createdAt: req.createdAt,
            expiresAt: req.expiresAt,
          };
        });
    },
    resolved(since) {
      const out: AdminApprovalResolution[] = [];
      for (const req of listAdminRequests('secret_use')) {
        const r = req.resolution;
        if (!req.handled || !r || r.at < since || r.by === 'system') continue;
        out.push({
          id: `secret_use:${req.requestId}`,
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
      if (!isSecretUseKind(choiceId)) return { ok: false, reason: 'invalid' };
      const result = handler.decide(requestId, choiceId, actor, 'dashboard');
      if (!result.ok) {
        return {
          ok: false,
          reason:
            result.reason === 'already_answered'
              ? 'already_answered'
              : result.reason === 'not_admin'
                ? 'forbidden'
                : 'not_found',
        };
      }
      result.effects.catch((error: unknown) =>
        logger.warn('secret use dashboard answer: follow-up failed', {
          requestId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return { ok: true, outcome: result.outcome };
    },
  };
}
