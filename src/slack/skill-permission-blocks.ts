/**
 * Block Kit for the cross-user skill permission-request prompt.
 *
 * When A asks to use B's skill without a grant, B receives this message with
 * three buttons. Each button carries ONLY the `requestId`; the authoritative
 * request data is read back server-side from `skill-permission-request-store`
 * (codex review: never trust forgeable owner/requester/skill button fields).
 */

/** action_id prefix so the Bolt router (`/^skill_perm_/`) dispatches here. */
export const SKILL_PERM_ACTION_ID_PREFIX = 'skill_perm_';

/** [네] — allow this one request once (transient, single-use). */
export const VALUE_KIND_PERM_YES_ONCE = 'perm_yes_once';
/** [X스킬에 A유저를 허용 리스트에 추가] — persist a per-skill grant. */
export const VALUE_KIND_PERM_ALLOW_SKILL = 'perm_allow_skill';
/** [A유저에게 모든 스킬을 사용하도록 허용] — persist an all-skills grant. */
export const VALUE_KIND_PERM_ALLOW_ALL = 'perm_allow_all';

export interface PermissionRequestMessageInput {
  requestId: string;
  requesterId: string; // A
  ownerId: string; // B
  skillName: string;
}

export interface PermissionRequestMessage {
  text: string;
  blocks: any[];
}

function button(label: string, kind: string, requestId: string, style?: 'primary'): any {
  const el: any = {
    type: 'button',
    text: { type: 'plain_text', text: label, emoji: true },
    action_id: `${SKILL_PERM_ACTION_ID_PREFIX}${kind}`,
    value: JSON.stringify({ kind, requestId }),
  };
  if (style) el.style = style;
  return el;
}

/**
 * Build the owner-facing permission prompt. The owner (B) is mentioned so they
 * are notified; the requester (A) and skill name are shown for context.
 */
export function buildPermissionRequestMessage(input: PermissionRequestMessageInput): PermissionRequestMessage {
  const { requestId, requesterId, ownerId, skillName } = input;
  const text = `🔐 <@${ownerId}> — <@${requesterId}>님이 \`${skillName}\` 스킬을 사용하려 합니다. 허용하시겠습니까?`;
  return {
    text,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🔐 <@${ownerId}> 님께 권한 요청\n<@${requesterId}>님이 \`$user:${skillName}\` 스킬을 사용하려 합니다. 허용하시겠습니까?`,
        },
      },
      {
        type: 'actions',
        block_id: `skill_perm_${requestId}`,
        elements: [
          button('✅ 네 (1회 허용)', VALUE_KIND_PERM_YES_ONCE, requestId, 'primary'),
          button(`📋 \`${skillName}\` 항상 허용`.slice(0, 75), VALUE_KIND_PERM_ALLOW_SKILL, requestId),
          button('🌐 모든 스킬 허용', VALUE_KIND_PERM_ALLOW_ALL, requestId),
        ],
      },
    ],
  };
}
