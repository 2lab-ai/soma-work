/**
 * `/z session theme` Block Kit topic — Phase 2 (#507).
 *
 * Rendered for the `theme` subcommand (default=show) and reused when the
 * user clicks the Theme button in the help card.
 */

import { type SessionTheme, THEME_NAMES, userSettingsStore } from '../../../user-settings-store';
import type { ApplyResult, RenderResult, ZTopicBinding } from '../../actions/z-settings-actions';
import { buildSettingCard } from '../ui-builder';

const THEME_DESCRIPTIONS: Record<SessionTheme, string> = {
  default: 'Full Rich Card UI',
  compact: '간결한 컴팩트 카드',
  minimal: '텍스트 최소 UI',
};

/**
 * The thread header uses this theme only when the user's thread card is "서버 슬랙 테마" (.prd/21 §5): by default it
 * follows their dashboard task card, so say where the header is set.
 */
function threadHeaderNote(userId: string): string {
  const mode = userSettingsStore.getUserDashboardLayout(userId).thread?.mode ?? 'follow';
  return mode === 'theme'
    ? ''
    : '\n스레드 헤더는 대시보드 설정 › 대시보드 화면 › 스레드 카드를 따릅니다. 이 테마를 헤더에도 쓰려면 거기서 "서버 슬랙 테마"를 고르세요.';
}

export async function renderThemeCard(args: { userId: string; issuedAt: number }): Promise<RenderResult> {
  const { userId, issuedAt } = args;
  const current = userSettingsStore.getUserSessionTheme(userId);
  const options = (Object.keys(THEME_NAMES) as SessionTheme[]).map((id) => ({
    id,
    label: `${id} · ${THEME_NAMES[id]}`,
    description: THEME_DESCRIPTIONS[id],
  }));
  // Add a reset button as an extra option.
  options.push({
    id: 'reset' as any,
    label: '🔄 기본값으로 초기화',
    description: '기본 Rich Card UI로 복원',
  });

  const blocks = buildSettingCard({
    topic: 'theme',
    icon: '🎨',
    title: 'Session Theme',
    currentLabel: `${current} (${THEME_NAMES[current]})`,
    currentDescription: THEME_DESCRIPTIONS[current],
    options,
    additionalCommands: ['`/z session theme set <name>` — 직접 지정'],
    issuedAt,
  });
  return {
    text: `🎨 Theme (current: ${current})`,
    blocks,
  };
}

export async function applyTheme(args: { userId: string; value: string }): Promise<ApplyResult> {
  const { userId, value } = args;
  const resolved = userSettingsStore.resolveThemeInput(value);
  if (resolved === null) {
    const valid = Object.entries(THEME_NAMES)
      .map(([k, v]) => `\`${k}\` (${v})`)
      .join(', ');
    return {
      ok: false,
      summary: `❌ Unknown theme: \`${value}\``,
      description: `Available: ${valid}, \`reset\``,
    };
  }
  if (resolved === 'reset') {
    userSettingsStore.setUserSessionTheme(userId, undefined);
    return {
      ok: true,
      summary: '🔄 Theme → 기본값 (Default Rich Card)',
    };
  }
  userSettingsStore.setUserSessionTheme(userId, resolved);
  return {
    ok: true,
    summary: `🎨 Theme → ${THEME_NAMES[resolved]}`,
    description: THEME_DESCRIPTIONS[resolved] + threadHeaderNote(userId),
  };
}

export function createThemeTopicBinding(): ZTopicBinding {
  return {
    topic: 'theme',
    apply: (args) => applyTheme({ userId: args.userId, value: args.value }),
    renderCard: (args) => renderThemeCard({ userId: args.userId, issuedAt: args.issuedAt }),
  };
}
