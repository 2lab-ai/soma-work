/**
 * `/z epictasks` Block Kit topic — E4 ④a-2 (.prd/19 D12).
 *
 * The per-user switch for making epic tasks: when it is on, the dashboard's
 * new-task API accepts `kind: 'epic'` from this user (an epic plans the work
 * and, from E4 ④b, runs child tasks). Off by default — the same pattern as
 * the Slack entry's `taskentry` (E2 ⑧).
 *
 * Only an accepted user can turn it on: the store's setters create a missing
 * record as accepted, so a write for an unknown user would skip the new-user
 * approval.
 */

import { userSettingsStore } from '../../../user-settings-store';
import type { ApplyResult, RenderResult, ZTopicBinding } from '../../actions/z-settings-actions';
import { buildSettingCard } from '../ui-builder';
import { parseTaskEntryValue } from './taskentry-topic';

const ON_DESCRIPTION = '대시보드에서 에픽 작업을 만들 수 있습니다. 에픽은 계획을 세우고 하위 작업을 맡깁니다.';
const OFF_DESCRIPTION = '대시보드 작업은 지금처럼 하나씩 만듭니다.';

export async function renderEpicTasksCard(args: { userId: string; issuedAt: number }): Promise<RenderResult> {
  const on = userSettingsStore.getUserEpicTasks(args.userId);
  const blocks = buildSettingCard({
    topic: 'epictasks',
    icon: '🧭',
    title: '에픽 작업 (실험)',
    currentLabel: on ? 'ON' : 'OFF',
    currentDescription: on ? ON_DESCRIPTION : OFF_DESCRIPTION,
    options: [
      { id: 'on', label: '✅ ON', description: '에픽 작업 만들기 허용' },
      { id: 'off', label: '❌ OFF', description: '일반 작업만 (기본)' },
    ],
    additionalCommands: [
      '`/z epictasks on|off` — 켜기/끄기',
      '_이미 만든 에픽은 꺼도 그대로입니다. 끄면 새 에픽만 만들지 못합니다._',
    ],
    issuedAt: args.issuedAt,
  });
  return { text: `🧭 에픽 작업 (${on ? 'ON' : 'OFF'})`, blocks };
}

export async function applyEpicTasks(args: { userId: string; value: string }): Promise<ApplyResult> {
  const enabled = parseTaskEntryValue(args.value);
  if (enabled === null) {
    return { ok: false, summary: `❌ \`on\` 또는 \`off\`만 받습니다: \`${args.value}\`` };
  }
  if (userSettingsStore.getUserSettings(args.userId)?.accepted !== true) {
    return { ok: false, summary: '🚫 관리자 승인을 받은 뒤에 바꿀 수 있습니다.' };
  }
  try {
    userSettingsStore.setUserEpicTasks(args.userId, enabled);
  } catch (error) {
    return { ok: false, summary: '❌ 저장 실패', description: (error as Error).message };
  }
  return enabled
    ? { ok: true, summary: '🧭 에픽 작업: ON', description: ON_DESCRIPTION }
    : { ok: true, summary: '🧭 에픽 작업: OFF', description: OFF_DESCRIPTION };
}

export function createEpicTasksTopicBinding(): ZTopicBinding {
  return {
    topic: 'epictasks',
    apply: (args) => applyEpicTasks({ userId: args.userId, value: args.value }),
    renderCard: (args) => renderEpicTasksCard({ userId: args.userId, issuedAt: args.issuedAt }),
  };
}
