import { userMention } from './user-mention';
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
/** [거절] — no grant; the requester is told. Shown on an environment user's card. */
export const VALUE_KIND_PERM_DENY = 'perm_deny';

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
  const text = `🔐 ${userMention(ownerId)} — <@${requesterId}>님이 \`${skillName}\` 스킬을 사용하려 합니다. 허용하시겠습니까?`;
  return {
    text,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🔐 ${userMention(ownerId)} 님께 권한 요청\n<@${requesterId}>님이 \`$user:${skillName}\` 스킬을 사용하려 합니다. 허용하시겠습니까?`,
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

export interface EnvironmentPermissionRequestMessageInput {
  requestId: string;
  requesterId: string;
  /** The environment user that owns the skill (`env:acme-dev2`). */
  ownerId: string;
  skillName: string;
  /** What the requester sent — it is what the environment user runs once approved. */
  originalText: string;
}

/**
 * The admin-facing prompt for an environment user's skill. An environment user is an admin that runs without a
 * sandbox, so an admin decides: accept once, deny, this skill always, or every skill of the environment always
 * (the all-skills grant of that owner). The requester's text is shown because it is what will run.
 */
export function buildEnvironmentPermissionRequestMessage(
  input: EnvironmentPermissionRequestMessageInput,
): PermissionRequestMessage {
  const { requestId, requesterId, ownerId, skillName } = input;
  const label = ownerId.startsWith('env:') ? ownerId.slice(4) : ownerId;
  // Callers refuse longer requests (ENVIRONMENT_REQUEST_MAX_CHARS); the cut here only guards Slack's block limit.
  const shown =
    input.originalText.length > 2400
      ? `${input.originalText.slice(0, 2400)}\n[⚠️ 전체 ${input.originalText.length}자 중 앞부분만 표시]`
      : input.originalText;
  const text = `🔐 어드민 승인 요청 — <@${requesterId}>님이 환경 \`${label}\`의 \`${skillName}\` 실행을 요청했습니다.`;
  return {
    text,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            `${text}\n승인하면 환경 유저 \`${ownerId}\` 권한(어드민 · 샌드박스 없음)으로 새 스레드에서 실행됩니다.\n` +
            `'항상'을 누르면 이 사람의 다음 요청도 묻지 않고 같은 권한으로 실행됩니다.\n` +
            `실행할 메시지:\n\`\`\`${shown.replace(/```/g, "'''")}\`\`\``,
        },
      },
      {
        type: 'actions',
        block_id: `skill_perm_${requestId}`,
        elements: [
          button('✅ 수락 (1회)', VALUE_KIND_PERM_YES_ONCE, requestId, 'primary'),
          button('❌ 거절', VALUE_KIND_PERM_DENY, requestId),
          button(`📋 이 스킬 항상 — ${skillName}`.slice(0, 75), VALUE_KIND_PERM_ALLOW_SKILL, requestId),
          button(`🌐 ${label} 전체 항상`.slice(0, 75), VALUE_KIND_PERM_ALLOW_ALL, requestId),
        ],
      },
    ],
  };
}
