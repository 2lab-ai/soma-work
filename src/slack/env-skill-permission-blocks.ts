/**
 * Block Kit for the environment-skill permission prompt sent to the admins.
 *
 * When a non-admin's turn reaches an environment skill (a skill of a deploy-time environment
 * plugin) they hold no grant for, every admin gets this prompt by DM. Each button carries ONLY
 * the `requestId`; the authoritative request is read back server-side from
 * `skill-permission-request-store`, so a forged or replayed payload cannot fabricate a grant.
 */

/** action_id prefix so the Bolt router (`/^env_skill_perm_/`) dispatches here. */
export const ENV_SKILL_PERM_ACTION_ID_PREFIX = 'env_skill_perm_';

/** [1회 허용] — this requester, this skill, the asking thread only, until the grant expires. */
export const VALUE_KIND_ENV_SKILL_ONCE = 'env_skill_once';
/** [항상 허용] — persist: the requester may run this environment skill anywhere. */
export const VALUE_KIND_ENV_SKILL_ALWAYS = 'env_skill_always';
/** [모든 환경 스킬 항상 허용] — persist: the requester may run every environment skill. */
export const VALUE_KIND_ENV_SKILL_ALL = 'env_skill_all';
/** [거부] — no grant; the requester is told. */
export const VALUE_KIND_ENV_SKILL_DENY = 'env_skill_deny';

export interface EnvSkillPermissionMessageInput {
  requestId: string;
  requesterId: string;
  /** `plugin:skill` */
  skillKey: string;
  /** Where the requester asked — shown so the admin knows which run is waiting. */
  channel: string;
  threadTs?: string;
}

export interface EnvSkillPermissionMessage {
  text: string;
  blocks: any[];
}

function button(label: string, kind: string, requestId: string, style?: 'primary' | 'danger'): any {
  const el: any = {
    type: 'button',
    text: { type: 'plain_text', text: label.slice(0, 75), emoji: true },
    action_id: `${ENV_SKILL_PERM_ACTION_ID_PREFIX}${kind}`,
    value: JSON.stringify({ kind, requestId }),
  };
  if (style) el.style = style;
  return el;
}

/** `<#C…>` plus the thread timestamp, when there is one. */
export function describeRequestPlace(channel: string, threadTs?: string): string {
  return threadTs ? `<#${channel}> 스레드 \`${threadTs}\`` : `<#${channel}>`;
}

/** Build the admin-facing prompt. */
export function buildEnvSkillPermissionMessage(input: EnvSkillPermissionMessageInput): EnvSkillPermissionMessage {
  const { requestId, requesterId, skillKey, channel, threadTs } = input;
  const text = `🔐 환경 스킬 권한 요청 — <@${requesterId}>님이 \`${skillKey}\` 을 실행하려 합니다.`;
  return {
    text,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            `🔐 *환경 스킬 권한 요청* (어드민 승인 필요)\n` +
            `<@${requesterId}>님이 환경 스킬 \`${skillKey}\` 을 실행하려 합니다.\n` +
            `요청 위치: ${describeRequestPlace(channel, threadTs)}\n` +
            '허용하면 요청한 턴을 다시 보내 이어서 실행합니다. *1회 허용*은 그 스레드에서만 유효합니다.',
        },
      },
      {
        type: 'actions',
        block_id: `env_skill_perm_${requestId}`,
        elements: [
          button('✅ 1회 허용 (이 스레드)', VALUE_KIND_ENV_SKILL_ONCE, requestId, 'primary'),
          button(`📋 \`${skillKey}\` 항상 허용`, VALUE_KIND_ENV_SKILL_ALWAYS, requestId),
          button('🌐 모든 환경 스킬 항상 허용', VALUE_KIND_ENV_SKILL_ALL, requestId),
          button('❌ 거부', VALUE_KIND_ENV_SKILL_DENY, requestId, 'danger'),
        ],
      },
    ],
  };
}
