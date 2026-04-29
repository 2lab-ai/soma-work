/**
 * `/z email` Block Kit topic — Phase 2 (#507).
 *
 * - Card shows current email + a "변경" button that opens a modal.
 * - Modal is a single plain_text_input; submit validates RFC-ish email
 *   format and persists via `userSettingsStore.setUserEmail()`.
 */

import type { WebClient } from '@slack/web-api';
import { Logger } from '../../../logger';
import { userSettingsStore } from '../../../user-settings-store';
import type { ApplyResult, RenderResult, ZTopicBinding } from '../../actions/z-settings-actions';
import { buildSettingCard } from '../ui-builder';

const logger = new Logger('EmailTopic');
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function renderEmailCard(args: { userId: string; issuedAt: number }): Promise<RenderResult> {
  const { userId, issuedAt } = args;
  const current = userSettingsStore.getUserEmail(userId);

  const blocks = buildSettingCard({
    topic: 'email',
    icon: '📧',
    title: 'Email',
    currentLabel: current ?? '_(not set)_',
    currentDescription: current
      ? 'Co-Authored-By 커밋 메시지 등에 이 이메일이 사용됩니다.'
      : '⚠️ 이메일이 설정되지 않았습니다. 아래 버튼으로 등록해주세요.',
    options: current
      ? [
          {
            id: 'clear',
            label: '🧹 이메일 삭제',
            description: '저장된 이메일을 제거합니다.',
            style: 'danger',
          },
        ]
      : [],
    extraActions: [
      {
        actionId: 'z_setting_email_open_modal',
        label: current ? '✏️ 변경' : '➕ 등록',
        style: 'primary',
      },
    ],
    additionalCommands: ['`/z email set <you@company.com>` — 직접 지정'],
    issuedAt,
  });
  return {
    text: current
      ? `📧 *Email*: \`${current}\``
      : `📧 *Email*: 설정되지 않음\n\n\`set email <your-email>\` 명령으로 이메일을 설정해주세요.`,
    blocks,
  };
}

export async function applyEmail(args: { userId: string; value: string }): Promise<ApplyResult> {
  const { userId, value } = args;
  if (value === 'clear') {
    userSettingsStore.setUserEmail(userId, '');
    return { ok: true, summary: '🧹 이메일 삭제 완료' };
  }
  // `/z email set <email>` routes here via topic binding "apply".
  const email = value.trim();
  if (!EMAIL_REGEX.test(email)) {
    return {
      ok: false,
      summary: `❌ 잘못된 이메일 형식: \`${email}\``,
      description: '올바른 형식: `you@company.com`',
    };
  }
  userSettingsStore.setUserEmail(userId, email);
  return {
    ok: true,
    summary: `📧 Email → \`${email}\``,
    description: 'Co-Authored-By 등에 이 이메일이 사용됩니다.',
  };
}

/** Build the email-change modal payload. */
export function buildEmailModal(current: string | undefined): Record<string, any> {
  const input: Record<string, any> = {
    type: 'plain_text_input',
    action_id: 'value',
    placeholder: { type: 'plain_text', text: '예: you@company.com' },
    max_length: 254,
  };
  if (current) input.initial_value = current;
  return {
    type: 'modal',
    callback_id: 'z_setting_email_modal_submit',
    title: { type: 'plain_text', text: 'Email' },
    submit: { type: 'plain_text', text: '저장' },
    close: { type: 'plain_text', text: '취소' },
    blocks: [
      {
        type: 'input',
        block_id: 'email_value',
        label: { type: 'plain_text', text: '이메일 주소' },
        element: input,
      },
    ],
  };
}

async function openEmailModal(args: { client: WebClient; triggerId: string; userId: string }): Promise<void> {
  const { client, triggerId, userId } = args;
  if (!triggerId) {
    logger.warn('openEmailModal: missing trigger_id');
    return;
  }
  const current = userSettingsStore.getUserEmail(userId);
  await client.views.open({
    trigger_id: triggerId,
    view: buildEmailModal(current) as any,
  });
}

export async function submitEmailModal(args: {
  client: WebClient;
  userId: string;
  values: Record<string, Record<string, any>>;
}): Promise<ApplyResult> {
  const { client, userId, values } = args;
  const email = (values?.email_value?.value?.value as string | undefined)?.trim() ?? '';
  const r = await applyEmail({ userId, value: email });
  try {
    await client.chat.postMessage({
      channel: userId,
      text: r.ok ? `✅ ${r.summary}` : `❌ ${r.summary}\n${r.description ?? ''}`,
    });
  } catch (err) {
    logger.warn('email modal ack DM failed', { err: (err as Error).message });
  }
  return r;
}

export function createEmailTopicBinding(): ZTopicBinding {
  return {
    topic: 'email',
    apply: (args) => applyEmail({ userId: args.userId, value: args.value }),
    renderCard: (args) => renderEmailCard({ userId: args.userId, issuedAt: args.issuedAt }),
    openModal: (args) => openEmailModal({ client: args.client, triggerId: args.triggerId, userId: args.userId }),
    submitModal: async (args) => {
      await submitEmailModal({ client: args.client, userId: args.userId, values: args.values });
    },
  };
}
