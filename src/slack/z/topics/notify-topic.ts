/**
 * `/z notify` Block Kit topic — Phase 2 (#507).
 *
 * - Slack DM on/off toggle: two simple `set_dm_on` / `set_dm_off` buttons.
 * - Telegram: `set_tg_clear` and an `open_modal` extra action that pushes a
 *   `views.open` with a `plain_text_input` for a numeric chat id. Modal
 *   submission ( `z_setting_notify_modal_submit` ) saves the chat id.
 */

import type { WebClient } from '@slack/web-api';
import { Logger } from '../../../logger';
import { userSettingsStore } from '../../../user-settings-store';
import type { ApplyResult, RenderResult, ZTopicBinding } from '../../actions/z-settings-actions';
import { buildSettingCard } from '../ui-builder';

const logger = new Logger('NotifyTopic');

export async function renderNotifyCard(args: { userId: string; issuedAt: number }): Promise<RenderResult> {
  const { userId, issuedAt } = args;
  const settings = userSettingsStore.getUserSettings(userId);
  const notif = settings?.notification;
  const slackOn = notif?.slackDm === true;
  const telegramId = notif?.telegramChatId;

  const lines = [
    `• Slack DM: ${slackOn ? '✅ ON' : '❌ OFF'}`,
    `• Telegram: ${telegramId ? `✅ \`${telegramId}\`` : '❌ 미등록'}`,
    `• Webhook: ${notif?.webhookUrl ? `✅ \`${notif.webhookUrl}\`` : '❌ 미등록'}`,
  ];

  const blocks = buildSettingCard({
    topic: 'notify',
    icon: '🔔',
    title: 'Notifications',
    currentLabel: slackOn ? 'DM ON' : 'DM OFF',
    currentDescription: lines.join('\n'),
    options: [
      { id: 'dm_on', label: '✅ Slack DM ON', description: '턴 종료 시 DM 알림' },
      { id: 'dm_off', label: '❌ Slack DM OFF', style: 'danger' },
      { id: 'tg_clear', label: '🧹 텔레그램 해제', style: 'danger' },
    ],
    extraActions: [
      {
        actionId: 'z_setting_notify_open_modal',
        label: '✈️ 텔레그램 Chat ID 등록',
        style: 'primary',
      },
    ],
    additionalCommands: [
      '`/z notify on|off` — Slack DM 토글',
      '`/z notify telegram <chat_id>` — 직접 등록',
      '`/z notify telegram off` — 해제',
    ],
    issuedAt,
  });
  return { text: `🔔 Notifications (${slackOn ? 'DM ON' : 'DM OFF'})`, blocks };
}

export async function applyNotify(args: { userId: string; value: string }): Promise<ApplyResult> {
  const { userId, value } = args;
  const v = value.toLowerCase();
  try {
    if (v === 'dm_on') {
      userSettingsStore.patchNotification(userId, { slackDm: true });
      return { ok: true, summary: '🔔 Slack DM → ON', description: 'AI 턴 종료 시 DM 알림을 받습니다.' };
    }
    if (v === 'dm_off') {
      userSettingsStore.patchNotification(userId, { slackDm: false });
      return { ok: true, summary: '🔕 Slack DM → OFF' };
    }
    if (v === 'tg_clear') {
      userSettingsStore.patchNotification(userId, { telegramChatId: undefined });
      return { ok: true, summary: '🧹 텔레그램 해제 완료' };
    }
    return { ok: false, summary: `❌ Unknown notify value: \`${value}\`` };
  } catch (err) {
    return { ok: false, summary: '❌ 저장 실패', description: (err as Error).message };
  }
}

/** Build a `views.open` payload for the telegram-chat-id input modal. */
export function buildNotifyTelegramModal(): Record<string, any> {
  return {
    type: 'modal',
    callback_id: 'z_setting_notify_modal_submit',
    title: { type: 'plain_text', text: 'Telegram Chat ID' },
    submit: { type: 'plain_text', text: '저장' },
    close: { type: 'plain_text', text: '취소' },
    blocks: [
      {
        type: 'input',
        block_id: 'notify_tg_chat',
        label: { type: 'plain_text', text: '텔레그램 Chat ID (숫자)' },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          placeholder: { type: 'plain_text', text: '예: 123456789 또는 -100... (그룹)' },
          max_length: 32,
        },
      },
    ],
  };
}

export async function openNotifyModal(args: { client: WebClient; triggerId: string }): Promise<void> {
  const { client, triggerId } = args;
  if (!triggerId) {
    logger.warn('openNotifyModal: missing trigger_id');
    return;
  }
  await client.views.open({
    trigger_id: triggerId,
    view: buildNotifyTelegramModal() as any,
  });
}

export async function submitNotifyModal(args: {
  client: WebClient;
  userId: string;
  values: Record<string, Record<string, any>>;
}): Promise<ApplyResult> {
  const { client, userId, values } = args;
  const raw = (values?.notify_tg_chat?.value?.value as string | undefined)?.trim() ?? '';
  if (!raw) {
    return { ok: false, summary: '❌ Chat ID가 비어있습니다.' };
  }
  if (!/^-?\d{1,20}$/.test(raw)) {
    return { ok: false, summary: `❌ 올바른 Chat ID가 아닙니다 (숫자만 허용): \`${raw}\`` };
  }
  try {
    userSettingsStore.patchNotification(userId, { telegramChatId: raw });
  } catch (err) {
    return { ok: false, summary: '❌ 저장 실패', description: (err as Error).message };
  }
  // Best-effort DM ack (no response_url available from view_submission).
  try {
    await client.chat.postMessage({
      channel: userId,
      text: `✈️ 텔레그램 Chat ID 등록 완료: \`${raw}\``,
    });
  } catch (err) {
    logger.warn('notify modal ack DM failed', { err: (err as Error).message });
  }
  return { ok: true, summary: `✈️ Telegram → \`${raw}\`` };
}

export function createNotifyTopicBinding(): ZTopicBinding {
  return {
    topic: 'notify',
    apply: (args) => applyNotify({ userId: args.userId, value: args.value }),
    renderCard: (args) => renderNotifyCard({ userId: args.userId, issuedAt: args.issuedAt }),
    openModal: (args) => openNotifyModal({ client: args.client, triggerId: args.triggerId }),
    submitModal: async (args) => {
      await submitNotifyModal({ client: args.client, userId: args.userId, values: args.values });
    },
  };
}
