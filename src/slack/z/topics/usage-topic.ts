/**
 * `/z usage` Block Kit topic.
 *
 * Read-only help card that documents the `usage` command family:
 *   - `usage`            — today's token usage + rankings (text)
 *   - `usage week`       — 7-day rollup (text)
 *   - `usage month`      — 30-day rollup (text)
 *   - `usage @user`      — another user's usage (text)
 *   - `usage card`       — personal 30-day usage card as PNG (Block Kit image)
 *
 * Same pattern as `cwd-topic`: no settable state, just a documentation card.
 */

import type { ApplyResult, RenderResult, ZTopicBinding } from '../../actions/z-settings-actions';
import { buildSettingCard } from '../ui-builder';

export async function renderUsageCard(args: { issuedAt: number }): Promise<RenderResult> {
  const { issuedAt } = args;

  const blocks = buildSettingCard({
    topic: 'usage',
    icon: '📊',
    title: 'Token Usage',
    currentLabel: '`usage` · `usage week` · `usage month` · `usage @user` · `usage card`',
    currentDescription: [
      '• `usage` — 오늘의 토큰 사용량과 랭킹',
      '• `usage week` — 최근 7일 사용량',
      '• `usage month` — 최근 30일 사용량',
      '• `usage @user` — 다른 사용자의 사용량',
      '• `usage card` — 최근 30일 *개인 통계 카드* PNG를 채널에 공개 포스트',
    ].join('\n'),
    options: [],
    additionalCommands: [
      '_카드 이미지는 1600×2200 PNG으로 렌더링됩니다. 활동 데이터가 없으면 텍스트 폴백이 자동 표시됩니다._',
    ],
    issuedAt,
  });

  return {
    text:
      '📊 *Token Usage*\n' + '`usage` (오늘) · `usage week` · `usage month` · `usage @user` · `usage card` (30일 PNG)',
    blocks,
  };
}

export async function applyUsage(_args: { userId: string; value: string }): Promise<ApplyResult> {
  // Read-only: no "set" action. Any click is a no-op with an explanatory message.
  return {
    ok: false,
    summary: '🚫 `usage`는 설정 항목이 없습니다.',
    description: '조회 전용 명령입니다. `usage` 또는 `usage card`를 직접 실행해 주세요.',
  };
}

export function createUsageTopicBinding(): ZTopicBinding {
  return {
    topic: 'usage',
    apply: (args) => applyUsage({ userId: args.userId, value: args.value }),
    renderCard: (args) => renderUsageCard({ issuedAt: args.issuedAt }),
  };
}
