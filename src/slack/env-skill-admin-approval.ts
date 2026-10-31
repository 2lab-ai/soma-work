/**
 * Environment-skill run requests as dashboard admin approvals (#620).
 *
 * Reads the existing request store (`skill-permission-request-store`) and
 * answers through the same synchronous decision the Slack buttons take
 * (`EnvSkillPermissionActionHandler.decide`), so a dashboard answer grants,
 * rewrites every admin's DM and re-sends the requester's turn exactly as a
 * click would, and a Slack click takes the card off the dashboard.
 */

import type { AdminApproval, AdminApprovalAdapter, AdminApprovalResolution } from '../admin-approvals';
import { Logger } from '../logger';
import { listPermissionRequests, type PermissionRequest } from '../skill-permission-request-store';
import { ENV_SKILL_GRANT_OWNER } from '../user-skill-grants-store';
import { type EnvSkillPermissionActionHandler, isEnvPermKind } from './actions/env-skill-permission-action-handler';
import {
  VALUE_KIND_ENV_SKILL_ALL,
  VALUE_KIND_ENV_SKILL_ALWAYS,
  VALUE_KIND_ENV_SKILL_DENY,
  VALUE_KIND_ENV_SKILL_ONCE,
} from './env-skill-permission-blocks';

const logger = new Logger('EnvSkillAdminApproval');

function isEnvSkillRequest(req: PermissionRequest): boolean {
  return req.ownerId === ENV_SKILL_GRANT_OWNER && req.operation === 'invoke';
}

/** One pending request as the approval card shows it — the same words and choices as the admins' DM. */
export function envSkillApproval(req: PermissionRequest): AdminApproval {
  return {
    id: `env_skill:${req.requestId}`,
    kind: 'env_skill',
    card: 'question',
    title: `환경 스킬 \`${req.skillName}\` 실행 요청`,
    description: '허용하면 요청한 턴을 다시 보내 이어서 실행합니다. 1회 허용은 요청한 스레드에서만 유효합니다.',
    choices: [
      { id: VALUE_KIND_ENV_SKILL_ONCE, label: '✅ 1회 허용 (이 스레드)' },
      { id: VALUE_KIND_ENV_SKILL_ALWAYS, label: `📋 \`${req.skillName}\` 항상 허용` },
      { id: VALUE_KIND_ENV_SKILL_ALL, label: '🌐 모든 환경 스킬 항상 허용' },
      { id: VALUE_KIND_ENV_SKILL_DENY, label: '❌ 거부' },
    ],
    // The narrowest grant, as the DM's primary button.
    recommendedId: VALUE_KIND_ENV_SKILL_ONCE,
    requesterId: req.requesterId,
    place: { channel: req.channel, ...(req.threadTs ? { threadTs: req.threadTs } : {}) },
    createdAt: req.createdAt,
  };
}

type Decider = Pick<EnvSkillPermissionActionHandler, 'decide'>;

export function envSkillAdminApprovalAdapter(handler: Decider): AdminApprovalAdapter {
  return {
    kind: 'env_skill',
    pending() {
      return listPermissionRequests()
        .filter((req) => isEnvSkillRequest(req) && !req.handled)
        .map(envSkillApproval);
    },
    resolved(since) {
      const out: AdminApprovalResolution[] = [];
      for (const req of listPermissionRequests()) {
        const r = req.resolution;
        if (!isEnvSkillRequest(req) || !req.handled || !r || r.at < since) continue;
        out.push({
          id: `env_skill:${req.requestId}`,
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
      if (!isEnvPermKind(choiceId)) return { ok: false, reason: 'invalid' };
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
      // The grant is already recorded; the DM rewrites and the re-sent turn run on.
      result.effects.catch((error: unknown) =>
        logger.warn('env-skill dashboard answer: follow-up failed', {
          requestId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return { ok: true, outcome: result.outcome };
    },
  };
}
