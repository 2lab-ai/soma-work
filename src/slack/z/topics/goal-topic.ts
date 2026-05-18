/**
 * `/z goal` Block Kit topic.
 *
 * Read-only help card. Goal mutations route through the text command family
 * (`goal <objective>`, `goal done`, etc.) so they stay thread/session-scoped.
 */

import type { ApplyResult, RenderResult, ZTopicBinding } from '../../actions/z-settings-actions';
import { buildSettingCard } from '../ui-builder';

export async function renderGoalCard(args: { issuedAt: number }): Promise<RenderResult> {
  const blocks = buildSettingCard({
    topic: 'goal',
    icon: '🎯',
    title: 'Session Goal',
    currentLabel: '`goal` · `goal set <objective>` · `goal pause|resume|done|clear`',
    currentDescription: [
      '• `goal` — 현재 세션 목표 조회',
      '• `goal set <objective>` 또는 `goal <objective>` — 활성 목표 설정/교체',
      '• `goal pause` / `goal resume` — 프롬프트 주입 일시정지/재개',
      '• `goal done` — 목표 완료 표시',
      '• `goal clear` — 목표 제거',
    ].join('\n'),
    options: [],
    additionalCommands: [
      '_목표는 Slack 스레드의 현재 세션에 저장되고, active 상태에서만 시스템 프롬프트에 주입됩니다._',
    ],
    issuedAt: args.issuedAt,
  });

  return {
    text: '🎯 *Goal* — `goal set <objective>`, `goal`, `goal pause|resume|done|clear`',
    blocks,
  };
}

export async function applyGoal(_args: { userId: string; value: string }): Promise<ApplyResult> {
  return {
    ok: false,
    summary: '🚫 `goal`은 카드에서 직접 변경하지 않습니다.',
    description: '스레드에서 `goal <objective>` 또는 `goal done`을 직접 실행해 주세요.',
  };
}

export function createGoalTopicBinding(): ZTopicBinding {
  return {
    topic: 'goal',
    apply: (args) => applyGoal({ userId: args.userId, value: args.value }),
    renderCard: (args) => renderGoalCard({ issuedAt: args.issuedAt }),
  };
}
