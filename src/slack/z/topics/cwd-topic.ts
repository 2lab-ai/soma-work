/**
 * `/z cwd` Block Kit topic — Phase 2 (#507).
 *
 * Read-only: working directories are fixed per user (`{BASE_DIRECTORY}/{userId}/`)
 * and cannot be changed via Slack. The card shows the current directory and
 * explains the policy; no set buttons are rendered. A single cancel button
 * lets the user dismiss.
 */

import type { ApplyResult, RenderResult, ZTopicBinding } from '../../actions/z-settings-actions';
import { buildSettingCard } from '../ui-builder';

function resolveUserCwd(userId: string): string | undefined {
  const base = process.env.BASE_DIRECTORY;
  if (!base || !userId) return undefined;
  return `${base.replace(/\/+$/, '')}/${userId}`;
}

export async function renderCwdCard(args: { userId: string; issuedAt: number }): Promise<RenderResult> {
  const { userId, issuedAt } = args;
  const cwd = resolveUserCwd(userId);
  const label = cwd ?? 'Not configured';
  const desc = cwd
    ? [
        '• 유저별 작업 디렉토리는 고정입니다: `{BASE_DIRECTORY}/{userId}/`',
        '• 보안 격리를 위해 사용자가 직접 변경할 수 없습니다.',
      ].join('\n')
    : '⚠️ `BASE_DIRECTORY` 환경변수가 설정되지 않았습니다. 관리자에게 문의하세요.';

  const blocks = buildSettingCard({
    topic: 'cwd',
    icon: '📁',
    title: 'Working Directory',
    currentLabel: `\`${label}\``,
    currentDescription: desc,
    options: [],
    additionalCommands: ['_유저별 cwd는 `BASE_DIRECTORY/{userId}/`로 고정되며 변경할 수 없습니다._'],
    issuedAt,
  });
  return { text: `📁 Working Directory: ${label}`, blocks };
}

export async function applyCwd(_args: { userId: string; value: string }): Promise<ApplyResult> {
  return {
    ok: false,
    summary: '🚫 cwd는 사용자가 변경할 수 없습니다.',
    description: '작업 디렉토리는 `BASE_DIRECTORY/{userId}/`로 자동 고정됩니다.',
  };
}

export function createCwdTopicBinding(): ZTopicBinding {
  return {
    topic: 'cwd',
    apply: (args) => applyCwd({ userId: args.userId, value: args.value }),
    renderCard: (args) => renderCwdCard({ userId: args.userId, issuedAt: args.issuedAt }),
  };
}
