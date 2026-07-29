/**
 * Block Kit for the `cron run` permission prompt sent to a job owner.
 *
 * When A asks to fire B's cron job, B gets this message (by DM, falling back
 * to the asking thread). Each button carries ONLY the `requestId`; the
 * authoritative request data is read back server-side from
 * `cron-run-request-store` — never trust forgeable owner/requester/job fields
 * on a button payload.
 */

/** action_id prefix so the Bolt router (`/^cron_run_perm_/`) dispatches here. */
export const CRON_RUN_PERM_ACTION_ID_PREFIX = 'cron_run_perm_';

/** [1회 실행] — fire once now, nothing persisted. */
export const VALUE_KIND_CRON_RUN_ONCE = 'cron_run_once';
/** [항상 허용] — persist the requester on the job's runAllowlist, then fire. */
export const VALUE_KIND_CRON_RUN_ALWAYS = 'cron_run_always';
/** [거부] — no grant, no fire; the requester is told. */
export const VALUE_KIND_CRON_RUN_DENY = 'cron_run_deny';

export interface CronRunPermissionMessageInput {
  requestId: string;
  requesterId: string; // A
  ownerId: string; // B
  jobName: string;
}

export interface CronRunPermissionMessage {
  text: string;
  blocks: any[];
}

function button(label: string, kind: string, requestId: string, style?: 'primary' | 'danger'): any {
  const el: any = {
    type: 'button',
    text: { type: 'plain_text', text: label, emoji: true },
    action_id: `${CRON_RUN_PERM_ACTION_ID_PREFIX}${kind}`,
    value: JSON.stringify({ kind, requestId }),
  };
  if (style) el.style = style;
  return el;
}

/**
 * Build the owner-facing prompt. The owner (B) is mentioned so a thread
 * fallback still notifies them; the requester (A) and job name give context.
 */
export function buildCronRunPermissionMessage(input: CronRunPermissionMessageInput): CronRunPermissionMessage {
  const { requestId, requesterId, ownerId, jobName } = input;
  const text = `⏱️ <@${ownerId}> — <@${requesterId}>님이 크론잡 \`${jobName}\` 을 지금 실행하려 합니다. 허용하시겠습니까?`;
  return {
    text,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            `⏱️ <@${ownerId}> 님께 크론 실행 권한 요청\n` +
            `<@${requesterId}>님이 \`${jobName}\` 을 지금 실행하려 합니다. ` +
            '허용하면 *오너 권한으로* 실제 크론 경로(대상/모드/모델 그대로)로 발동합니다.',
        },
      },
      {
        type: 'actions',
        block_id: `cron_run_perm_${requestId}`,
        elements: [
          button('▶ 1회 실행 허용', VALUE_KIND_CRON_RUN_ONCE, requestId, 'primary'),
          button(`✅ \`${jobName}\` 항상 허용`.slice(0, 75), VALUE_KIND_CRON_RUN_ALWAYS, requestId),
          button('❌ 거부', VALUE_KIND_CRON_RUN_DENY, requestId, 'danger'),
        ],
      },
    ],
  };
}
