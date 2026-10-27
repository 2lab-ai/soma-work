/**
 * `/z bypass` Block Kit topic — permission-mode selector (#auto-permission-mode).
 *
 * Historically an on/off "bypass" toggle. Now a tri-state permission-mode
 * selector. Only two modes are user-selectable:
 *   • `auto`   (default) — a safety classifier judges dangerous operations and
 *     auto-approves the safe ones, asking the human only when unsure.
 *   • `bypass` (unsafe, admin only) — everything runs with no prompt. Hidden
 *     from non-admins and rejected by `applyBypass` for them.
 * The third mode, `legacy` (ask-for-every-tool), is intentionally NOT offered as
 * a button — it is reachable only via `/z bypass set legacy` for escape-hatch
 * parity with the old "ask before every tool" behaviour.
 *
 * The topic id stays `bypass` so existing `/z bypass` commands and the
 * `z_setting_bypass_*` action ids keep working. Legacy values `on`/`off` are
 * accepted and mapped to `bypass`/`auto`.
 */

import { isAdminUser } from '../../../admin-utils';
import {
  isPermissionMode,
  type PermissionMode,
  selectablePermissionModesFor,
} from '../../../agent-runtime/policy/permission-mode';
import { userSettingsStore } from '../../../user-settings-store';
import type { ApplyResult, RenderResult, ZTopicBinding } from '../../actions/z-settings-actions';
import { buildSettingCard } from '../ui-builder';

function modeLabel(mode: PermissionMode): string {
  switch (mode) {
    case 'auto':
      return 'AUTO';
    case 'bypass':
      return 'BYPASS (unsafe)';
    case 'legacy':
      return 'LEGACY';
  }
}

function modeDescription(mode: PermissionMode): string {
  switch (mode) {
    case 'auto':
      return '🤖 안전 분류기가 위험한 작업만 판단해 자동 승인/질문합니다 (기본).';
    case 'bypass':
      return '⚠️ 모든 툴을 확인 없이 실행합니다 (위험한 명령 포함).';
    case 'legacy':
      return '🙋 모든 툴 실행 전에 수락/거절을 직접 물어봅니다 (구버전).';
  }
}

export async function renderBypassCard(args: { userId: string; issuedAt: number }): Promise<RenderResult> {
  const { userId, issuedAt } = args;
  const current = userSettingsStore.getUserPermissionMode(userId);
  const admin = isAdminUser(userId);

  const options: Array<{ id: string; label: string; description: string; style?: 'danger' }> = [
    {
      id: 'auto',
      label: '🤖 Auto (default)',
      description: '안전 분류기가 위험 작업만 판단 — 안전하면 자동 승인, 애매하면 질문',
    },
  ];
  if (admin) {
    options.push({
      id: 'bypass',
      label: '🔓 Bypass (unsafe, admin only)',
      description: '⚠️ 위험한 명령까지 확인 없이 실행. 주의!',
      style: 'danger',
    });
  }

  const blocks = buildSettingCard({
    topic: 'bypass',
    icon: '🔐',
    title: 'Permission Mode',
    currentLabel: modeLabel(current),
    currentDescription: modeDescription(current),
    options,
    additionalCommands: admin
      ? ['버튼으로 `Auto`/`Bypass` 선택, 또는 텍스트 `bypass off`(=Auto) / `bypass on`(=Bypass)']
      : ['Bypass는 관리자만 쓸 수 있습니다. 텍스트 `bypass off`(=Auto)'],
    issuedAt,
  });
  return {
    text: `🔐 Permission Mode (current: ${modeLabel(current)})`,
    blocks,
  };
}

/**
 * Normalise a raw apply value into a mode. Accepts the new mode names plus the
 * legacy `on`/`off` aliases (`on → bypass`, `off → auto`). Returns null for
 * anything else.
 */
export function normalizePermissionModeValue(value: string): PermissionMode | null {
  const v = value.trim().toLowerCase();
  if (v === 'on') return 'bypass';
  if (v === 'off') return 'auto';
  if (isPermissionMode(v)) return v;
  return null;
}

export async function applyBypass(args: { userId: string; value: string }): Promise<ApplyResult> {
  const { userId, value } = args;
  const mode = normalizePermissionModeValue(value);
  if (!mode) {
    return {
      ok: false,
      summary: `❌ Expected \`auto\` or \`bypass\`, got \`${value}\``,
    };
  }
  if (mode === 'bypass' && !isAdminUser(userId)) {
    return { ok: false, summary: '❌ Bypass는 관리자만 켤 수 있습니다. 지금 모드는 Auto입니다.' };
  }
  // `legacy` is reachable only via the explicit `set legacy` escape hatch, never
  // a button — but if a user types it we honour it.
  if (mode !== 'legacy' && !selectablePermissionModesFor(true).includes(mode)) {
    return { ok: false, summary: `❌ Unsupported mode: \`${value}\`` };
  }
  userSettingsStore.setUserPermissionMode(userId, mode);
  return {
    ok: true,
    summary: `${mode === 'bypass' ? '🔓' : mode === 'auto' ? '🤖' : '🙋'} Permission mode → ${modeLabel(mode)}`,
    description: modeDescription(mode),
  };
}

export function createBypassTopicBinding(): ZTopicBinding {
  return {
    topic: 'bypass',
    apply: (args) => applyBypass({ userId: args.userId, value: args.value }),
    renderCard: (args) => renderBypassCard({ userId: args.userId, issuedAt: args.issuedAt }),
  };
}
