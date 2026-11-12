/**
 * Block Kit for the environment-skill permission prompt sent to the admins.
 *
 * When a non-admin's turn reaches an environment skill (a skill of a deploy-time environment
 * plugin) they hold no grant for, every admin gets this prompt by DM. Each button carries ONLY
 * the `requestId`; the authoritative request is read back server-side from
 * `skill-permission-request-store`, so a forged or replayed payload cannot fabricate a grant.
 *
 * The answers (env-access WU4, #1212), in this order: accept (this thread), reject, this skill
 * always, and — when the skill belongs to an environment (`env-users.ts`) — that whole environment
 * always. The same list feeds the dashboard card (`envSkillChoices`).
 */
import { type Environment, environmentLabel } from '../env-users';

/** action_id prefix so the Bolt router (`/^env_skill_perm_/`) dispatches here. */
export const ENV_SKILL_PERM_ACTION_ID_PREFIX = 'env_skill_perm_';

/** [수락] — this requester, this skill, the asking thread only, until the grant expires. */
export const VALUE_KIND_ENV_SKILL_ONCE = 'env_skill_once';
/** [이 스킬 항상] — persist: the requester may run this environment skill anywhere. */
export const VALUE_KIND_ENV_SKILL_ALWAYS = 'env_skill_always';
/**
 * [이 환경 전체 항상] — persist: the requester may run every skill and every server-tools tool of the
 * environment the skill belongs to (env-access WU4).
 */
export const VALUE_KIND_ENV_SKILL_ENV = 'env_skill_env';
/**
 * [모든 환경 스킬 항상 허용] — persist: every environment skill. No longer offered (WU4 scopes the wide answer
 * to one environment); still honored for a prompt sent before.
 */
export const VALUE_KIND_ENV_SKILL_ALL = 'env_skill_all';
/** [거절] — no grant; the requester is told. */
export const VALUE_KIND_ENV_SKILL_DENY = 'env_skill_deny';

export interface EnvSkillPermissionMessageInput {
  requestId: string;
  requesterId: string;
  /** `plugin:skill` */
  skillKey: string;
  /** Where the requester asked — shown so the admin knows which run is waiting. */
  channel: string;
  threadTs?: string;
  /** The environment the skill belongs to, when one does: offers the fourth answer. */
  environment?: Pick<Environment, 'id' | 'skills'> | null;
}

export interface EnvSkillPermissionMessage {
  text: string;
  blocks: any[];
}

export interface EnvSkillChoice {
  kind: string;
  label: string;
  style?: 'primary' | 'danger';
}

/** The admin's answers, in order — the Slack prompt and the dashboard card show the same ones. */
export function envSkillChoices(skillKey: string, environment?: Pick<Environment, 'id'> | null): EnvSkillChoice[] {
  return [
    { kind: VALUE_KIND_ENV_SKILL_ONCE, label: '✅ 수락 (이 스레드)', style: 'primary' },
    { kind: VALUE_KIND_ENV_SKILL_DENY, label: '❌ 거절', style: 'danger' },
    { kind: VALUE_KIND_ENV_SKILL_ALWAYS, label: `📋 이 스킬 항상 — \`${skillKey}\`` },
    ...(environment
      ? [{ kind: VALUE_KIND_ENV_SKILL_ENV, label: `🌐 \`${environmentLabel(environment.id)}\` 전체 항상` }]
      : []),
  ];
}

function button(choice: EnvSkillChoice, requestId: string): any {
  const el: any = {
    type: 'button',
    text: { type: 'plain_text', text: choice.label.slice(0, 75), emoji: true },
    action_id: `${ENV_SKILL_PERM_ACTION_ID_PREFIX}${choice.kind}`,
    value: JSON.stringify({ kind: choice.kind, requestId }),
  };
  if (choice.style) el.style = choice.style;
  return el;
}

/** `<#C…>` plus the thread timestamp, when there is one. */
export function describeRequestPlace(channel: string, threadTs?: string): string {
  return threadTs ? `<#${channel}> 스레드 \`${threadTs}\`` : `<#${channel}>`;
}

/** Build the admin-facing prompt. */
export function buildEnvSkillPermissionMessage(input: EnvSkillPermissionMessageInput): EnvSkillPermissionMessage {
  const { requestId, requesterId, skillKey, channel, threadTs, environment } = input;
  const text = `🔐 환경 스킬 권한 요청 — <@${requesterId}>님이 \`${skillKey}\` 을 실행하려 합니다.`;
  const where = environment
    ? `환경 \`${environmentLabel(environment.id)}\`의 스킬입니다 (이 환경의 스킬: ${environment.skills
        .map((s) => `\`${s}\``)
        .join(', ')}). *전체 항상*은 이 환경의 모든 스킬과 서버 도구를 엽니다.\n`
    : '';
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
            where +
            `요청 위치: ${describeRequestPlace(channel, threadTs)}\n` +
            '허용하면 요청한 턴을 다시 보내 이어서 실행합니다. *수락*은 그 스레드에서만 유효합니다.',
        },
      },
      {
        type: 'actions',
        block_id: `env_skill_perm_${requestId}`,
        elements: envSkillChoices(skillKey, environment).map((choice) => button(choice, requestId)),
      },
    ],
  };
}
