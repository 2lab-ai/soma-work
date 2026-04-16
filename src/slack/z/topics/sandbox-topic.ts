/**
 * `/z sandbox` Block Kit topic — Phase 2 (#507).
 *
 * Sandbox on/off plus network allowlist toggle.
 * - Sandbox on/off is admin-only; enforcement lives in `applySandbox`.
 * - Network allowlist is user-wide (any user may toggle).
 */

import { isAdminUser } from '../../../admin-utils';
import { DEV_DOMAIN_ALLOWLIST } from '../../../sandbox/dev-domain-allowlist';
import { userSettingsStore } from '../../../user-settings-store';
import type { ApplyResult, RenderResult, ZTopicBinding } from '../../actions/z-settings-actions';
import { buildSettingCard } from '../ui-builder';

export async function renderSandboxCard(args: { userId: string; issuedAt: number }): Promise<RenderResult> {
  const { userId, issuedAt } = args;
  const sandboxDisabled = userSettingsStore.getUserSandboxDisabled(userId);
  const networkDisabled = userSettingsStore.getUserNetworkDisabled(userId);
  const admin = isAdminUser(userId);

  const currentLabel = sandboxDisabled ? 'OFF' : 'ON';

  const sandboxLine = sandboxDisabled
    ? '• Sandbox: `OFF` — bash runs without isolation'
    : '• Sandbox: `ON` — bash runs in an isolated environment';

  let networkLine: string;
  if (networkDisabled) {
    networkLine = sandboxDisabled
      ? '• Network allowlist: `OFF` _(stored; inactive while sandbox is OFF)_'
      : '• Network allowlist: `OFF` — outbound traffic is not restricted to the dev allowlist';
  } else {
    networkLine = sandboxDisabled
      ? '• Network allowlist: `ON` _(stored; inactive while sandbox is OFF)_'
      : `• Network allowlist: \`ON\` — outbound restricted to ${DEV_DOMAIN_ALLOWLIST.length} preset dev domains`;
  }

  const currentDescription = [sandboxLine, networkLine].join('\n');

  const options: Array<{ id: string; label: string; description?: string; style?: 'danger' | 'primary' }> = [];
  if (admin) {
    options.push({
      id: 'on',
      label: '🛡️ Sandbox ON',
      description: '샌드박스 격리 활성화 (기본)',
    });
    options.push({
      id: 'off',
      label: '⚠️ Sandbox OFF',
      description: '⚠️ 샌드박스 격리 해제 (admin only)',
      style: 'danger',
    });
  }
  // Network allowlist toggles are user-wide.
  options.push({
    id: 'network_on',
    label: '🌐 Network allowlist ON',
    description: '아웃바운드 접근을 dev allowlist로 제한',
  });
  options.push({
    id: 'network_off',
    label: '🌐 Network allowlist OFF',
    description: '아웃바운드 제한 해제',
    style: 'danger',
  });

  const blocks = buildSettingCard({
    topic: 'sandbox',
    icon: '🛡️',
    title: 'Sandbox',
    currentLabel,
    currentDescription,
    options,
    additionalCommands: [
      '`/z sandbox set on|off` — 샌드박스 토글 (admin)',
      '`/z sandbox network set on|off` — 네트워크 allowlist 토글',
    ],
    issuedAt,
  });
  return {
    text: `🛡️ *Sandbox Status* (current: ${currentLabel})\n\n${sandboxLine}\n${networkLine}`,
    blocks,
  };
}

export async function applySandbox(args: { userId: string; value: string }): Promise<ApplyResult> {
  const { userId, value } = args;
  const normalized = value.toLowerCase();

  if (normalized === 'on' || normalized === 'off') {
    if (!isAdminUser(userId)) {
      return {
        ok: false,
        summary: '🚫 Admin only: sandbox on/off는 관리자만 변경 가능합니다.',
      };
    }
    const disable = normalized === 'off';
    userSettingsStore.setUserSandboxDisabled(userId, disable);
    return {
      ok: true,
      summary: disable ? '⚠️ Sandbox → OFF' : '🛡️ Sandbox → ON',
      description: disable
        ? 'Bash 명령이 샌드박스 격리 없이 실행됩니다 (다음 메시지부터).'
        : 'Bash 명령이 샌드박스에서 실행됩니다 (다음 메시지부터).',
    };
  }

  if (normalized === 'network_on' || normalized === 'network_off') {
    const disable = normalized === 'network_off';
    userSettingsStore.setUserNetworkDisabled(userId, disable);
    return {
      ok: true,
      summary: disable ? '🌐 Network allowlist → OFF' : '🌐 Network allowlist → ON',
      description: disable
        ? '아웃바운드 네트워크 제한이 해제되었습니다.'
        : '아웃바운드 네트워크가 dev allowlist로 제한됩니다.',
    };
  }

  return {
    ok: false,
    summary: `❌ Unknown sandbox value: \`${value}\``,
    description: '허용 값: `on`, `off`, `network_on`, `network_off`',
  };
}

export function createSandboxTopicBinding(): ZTopicBinding {
  return {
    topic: 'sandbox',
    apply: (args) => applySandbox({ userId: args.userId, value: args.value }),
    renderCard: (args) => renderSandboxCard({ userId: args.userId, issuedAt: args.issuedAt }),
  };
}
