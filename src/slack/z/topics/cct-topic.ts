/**
 * `/z cct` Block Kit topic — Phase 2 (#507). Admin-only.
 *
 * Card shows the currently active CCT token + one button per available
 * token (`set_<name>`) plus a `next` rotation button. Non-admins receive an
 * empty "🚫 Admin only" card with just a cancel button.
 */

import { isAdminUser } from '../../../admin-utils';
import { getTokenManager, type TokenSummary } from '../../../token-manager';
import type { ApplyResult, RenderResult, ZTopicBinding } from '../../actions/z-settings-actions';
import { buildSettingCard } from '../ui-builder';

export async function renderCctCard(args: { userId: string; issuedAt: number }): Promise<RenderResult> {
  const { userId, issuedAt } = args;
  const admin = isAdminUser(userId);
  if (!admin) {
    const blocks = buildSettingCard({
      topic: 'cct',
      icon: '🔑',
      title: 'CCT Token',
      currentLabel: 'Admin only',
      currentDescription: '🚫 관리자만 CCT 토큰을 확인/변경할 수 있습니다.',
      options: [],
      issuedAt,
    });
    return { text: '🚫 CCT (admin only)', blocks };
  }

  const tm = getTokenManager();
  const tokens = tm.listTokens();
  const active = tokens.length > 0 ? tm.getActiveToken() : null;

  const lines = tokens.map((t: TokenSummary) => {
    const parts = [`\`${t.name}\` (${t.kind})`];
    if (active && t.slotId === active.slotId) parts.push('*(active)*');
    // TODO(Wave 4): render rateLimitedAt timestamp from SlotState
    if (t.status.includes('cooling')) {
      parts.push(`_(rate limited)_`);
    } else if (t.status.includes('revoked')) {
      parts.push(`_(revoked)_`);
    }
    return `• ${parts.join(' ')}`;
  });

  // NOTE: option.id is interpolated into `z_setting_cct_set_<id>`. Keep ids
  // free of `_set_` substring so the greedy parser in z-settings-actions.ts
  // splits topic=`cct` cleanly (regressed when ids were `set_<name>`).
  const options = tokens.map((t: TokenSummary) => ({
    id: t.name,
    label: `🔑 ${t.name}${active && t.slotId === active.slotId ? ' •' : ''}`,
    description: `활성 토큰을 ${t.name}으로 전환합니다.`,
  }));
  options.push({
    id: 'next',
    label: '🔄 Next (rotate)',
    description: '다음 사용 가능한 토큰으로 순환합니다.',
  });

  const blocks = buildSettingCard({
    topic: 'cct',
    icon: '🔑',
    title: 'CCT Token',
    currentLabel: active ? active.name : 'none',
    currentDescription:
      lines.length > 0 ? lines.join('\n') : 'No CCT tokens configured. Set `CLAUDE_CODE_OAUTH_TOKEN_LIST` env var.',
    options,
    additionalCommands: ['`/z cct set <name>` — 직접 지정', '`/z cct next` — 다음 토큰으로 순환'],
    issuedAt,
  });
  return { text: `🔑 CCT (active: ${active?.name ?? 'none'})`, blocks };
}

export async function applyCct(args: { userId: string; value: string }): Promise<ApplyResult> {
  const { userId, value } = args;
  if (!isAdminUser(userId)) {
    return { ok: false, summary: '🚫 Admin only: CCT는 관리자만 변경할 수 있습니다.' };
  }
  const tm = getTokenManager();
  const tokens = tm.listTokens();
  if (tokens.length === 0) {
    return { ok: false, summary: '⚠️ No CCT tokens configured.' };
  }

  if (value === 'next') {
    const rotated = await tm.rotateToNext();
    if (!rotated) {
      return { ok: false, summary: '⚠️ 하나의 토큰만 있어 rotate할 수 없습니다.' };
    }
    const active = tm.getActiveToken();
    return {
      ok: true,
      summary: `🔄 Rotated → *${active?.name ?? rotated.name}*`,
      description: `kind: \`${active?.kind ?? 'setup_token'}\``,
    };
  }
  // Support both the new bare-name form (`value = t.name`) emitted by Block
  // Kit buttons and the legacy `set_<name>` form used by `/z cct set <name>`
  // text invocations, so the same handler serves both paths.
  const setMatch = value.match(/^set_(.+)$/);
  const target = setMatch ? setMatch[1] : value;
  const match = tokens.find((t: TokenSummary) => t.name === target);
  if (!match) {
    const available = tokens.map((t: TokenSummary) => `\`${t.name}\``).join(', ');
    return {
      ok: false,
      summary: `❌ Unknown token: \`${target}\``,
      description: `Available: ${available}`,
    };
  }
  await tm.applyToken(match.slotId);
  const active = tm.getActiveToken();
  return {
    ok: true,
    summary: `🔑 Active → *${active?.name ?? match.name}*`,
    description: `kind: \`${active?.kind ?? match.kind}\``,
  };
}

export function createCctTopicBinding(): ZTopicBinding {
  return {
    topic: 'cct',
    apply: (args) => applyCct({ userId: args.userId, value: args.value }),
    renderCard: (args) => renderCctCard({ userId: args.userId, issuedAt: args.issuedAt }),
  };
}
