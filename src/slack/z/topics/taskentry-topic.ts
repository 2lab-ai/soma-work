/**
 * `/z taskentry` Block Kit topic — E2 ⑧ (.prd/18 D1).
 *
 * The per-user switch for the Slack entry: when it is on, a plain instruction
 * to the bot in a channel becomes a dashboard task — the thread gets the card
 * link, then only the result and the questions that need the user. Off by
 * default. The flag is read only when a new task would be made: an existing
 * Slack session, or a thread already linked to a task, keeps its path.
 *
 * Only an accepted user can turn it on: the store's setters create a missing
 * record as accepted, so a write for an unknown user would skip the new-user
 * approval the entry runs first.
 */

import { userSettingsStore } from '../../../user-settings-store';
import type { ApplyResult, RenderResult, ZTopicBinding } from '../../actions/z-settings-actions';
import { buildSettingCard } from '../ui-builder';

const ON_DESCRIPTION =
  '채널에서 봇에게 보낸 지시가 대시보드 작업이 됩니다. 스레드에는 카드 링크, 결과, 답이 필요한 질문만 남깁니다.';
const OFF_DESCRIPTION = '지시는 지금처럼 슬랙 스레드의 세션으로 진행합니다.';

/** `on|off` and the usual aliases → the flag; anything else → null. */
export function parseTaskEntryValue(value: string): boolean | null {
  const v = value.trim().toLowerCase();
  if (v === 'on' || v === 'true' || v === 'enable') return true;
  if (v === 'off' || v === 'false' || v === 'disable') return false;
  return null;
}

export async function renderTaskEntryCard(args: { userId: string; issuedAt: number }): Promise<RenderResult> {
  const on = userSettingsStore.getUserSlackTaskEntry(args.userId);
  const blocks = buildSettingCard({
    topic: 'taskentry',
    icon: '🗂️',
    title: 'Slack → 대시보드 작업',
    currentLabel: on ? 'ON' : 'OFF',
    currentDescription: on ? ON_DESCRIPTION : OFF_DESCRIPTION,
    options: [
      { id: 'on', label: '✅ ON', description: '채널 지시를 대시보드 작업으로' },
      { id: 'off', label: '❌ OFF', description: '슬랙 세션으로 (기본)' },
    ],
    additionalCommands: [
      '`/z taskentry on|off` — 켜기/끄기',
      '_이미 진행 중인 슬랙 세션과 작업에 연결된 스레드는 바꿔도 그대로입니다. DM·파일·명령은 작업이 되지 않습니다._',
    ],
    issuedAt: args.issuedAt,
  });
  return { text: `🗂️ Slack → 대시보드 작업 (${on ? 'ON' : 'OFF'})`, blocks };
}

export async function applyTaskEntry(args: { userId: string; value: string }): Promise<ApplyResult> {
  const enabled = parseTaskEntryValue(args.value);
  if (enabled === null) {
    return { ok: false, summary: `❌ \`on\` 또는 \`off\`만 받습니다: \`${args.value}\`` };
  }
  if (userSettingsStore.getUserSettings(args.userId)?.accepted !== true) {
    return { ok: false, summary: '🚫 관리자 승인을 받은 뒤에 바꿀 수 있습니다.' };
  }
  try {
    userSettingsStore.setUserSlackTaskEntry(args.userId, enabled);
  } catch (error) {
    return { ok: false, summary: '❌ 저장 실패', description: (error as Error).message };
  }
  return enabled
    ? { ok: true, summary: '🗂️ Slack → 대시보드 작업: ON', description: ON_DESCRIPTION }
    : { ok: true, summary: '💬 Slack → 대시보드 작업: OFF', description: OFF_DESCRIPTION };
}

export function createTaskEntryTopicBinding(): ZTopicBinding {
  return {
    topic: 'taskentry',
    apply: (args) => applyTaskEntry({ userId: args.userId, value: args.value }),
    renderCard: (args) => renderTaskEntryCard({ userId: args.userId, issuedAt: args.issuedAt }),
  };
}
