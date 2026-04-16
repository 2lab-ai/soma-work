/**
 * `/z bypass` Block Kit topic — Phase 2 (#507).
 *
 * Simple on/off toggle for the "permission bypass" flag.
 */

import { userSettingsStore } from '../../../user-settings-store';
import type { ApplyResult, RenderResult, ZTopicBinding } from '../../actions/z-settings-actions';
import { buildSettingCard } from '../ui-builder';

export async function renderBypassCard(args: { userId: string; issuedAt: number }): Promise<RenderResult> {
  const { userId, issuedAt } = args;
  const current = userSettingsStore.getUserBypassPermission(userId);
  const blocks = buildSettingCard({
    topic: 'bypass',
    icon: '🔐',
    title: 'Permission Bypass',
    currentLabel: current ? 'ON' : 'OFF',
    currentDescription: current
      ? '⚠️ Claude will execute tools without asking.'
      : '✅ Claude will ask before executing sensitive tools.',
    options: [
      {
        id: 'on',
        label: '🔓 Enable (ON)',
        description: '⚠️ 민감한 툴도 확인 없이 실행됩니다. 주의!',
      },
      { id: 'off', label: '🔒 Disable (OFF)' },
    ],
    additionalCommands: ['`/z bypass set on|off` — 직접 지정'],
    issuedAt,
  });
  return {
    text: `🔐 Bypass (current: ${current ? 'ON' : 'OFF'})`,
    blocks,
  };
}

export async function applyBypass(args: { userId: string; value: string }): Promise<ApplyResult> {
  const { userId, value } = args;
  const normalized = value.toLowerCase();
  if (normalized !== 'on' && normalized !== 'off') {
    return {
      ok: false,
      summary: `❌ Expected \`on\` or \`off\`, got \`${value}\``,
    };
  }
  const next = normalized === 'on';
  userSettingsStore.setUserBypassPermission(userId, next);
  return {
    ok: true,
    summary: next ? '🔓 Bypass → ON' : '🔒 Bypass → OFF',
    description: next
      ? '⚠️ 이후 Claude는 권한 요청 없이 툴을 실행합니다.'
      : '✅ 이후 Claude는 민감한 툴 실행 전 확인을 받습니다.',
  };
}

export function createBypassTopicBinding(): ZTopicBinding {
  return {
    topic: 'bypass',
    apply: (args) => applyBypass({ userId: args.userId, value: args.value }),
    renderCard: (args) => renderBypassCard({ userId: args.userId, issuedAt: args.issuedAt }),
  };
}
