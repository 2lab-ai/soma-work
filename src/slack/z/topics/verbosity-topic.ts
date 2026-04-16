/**
 * `/z verbosity` Block Kit topic — Phase 2 (#507).
 */

import { userSettingsStore } from '../../../user-settings-store';
import type { ApplyResult, RenderResult, ZTopicBinding } from '../../actions/z-settings-actions';
import { type LogVerbosity, VERBOSITY_NAMES } from '../../output-flags';
import { buildSettingCard } from '../ui-builder';

const VERBOSITY_DESCRIPTIONS: Record<LogVerbosity, string> = {
  minimal: '핵심만 — 최소 로그',
  compact: '요약된 활동 로그',
  detail: '자세한 tool/step 로그',
  verbose: '전체 raw 데이터 포함',
};

export async function renderVerbosityCard(args: { userId: string; issuedAt: number }): Promise<RenderResult> {
  const { userId, issuedAt } = args;
  const current = userSettingsStore.getUserDefaultLogVerbosity(userId);
  const blocks = buildSettingCard({
    topic: 'verbosity',
    icon: '📊',
    title: 'Log Verbosity',
    currentLabel: current,
    currentDescription: VERBOSITY_DESCRIPTIONS[current],
    options: VERBOSITY_NAMES.map((name) => ({
      id: name,
      label: name,
      description: VERBOSITY_DESCRIPTIONS[name],
    })),
    additionalCommands: ['`/z verbosity set <level>` — 직접 지정'],
    issuedAt,
  });
  return {
    text: `📊 Verbosity (current: ${current})`,
    blocks,
  };
}

export async function applyVerbosity(args: { userId: string; value: string }): Promise<ApplyResult> {
  const { userId, value } = args;
  const resolved = userSettingsStore.resolveVerbosityInput(value);
  if (!resolved) {
    return {
      ok: false,
      summary: `❌ Unknown verbosity: \`${value}\``,
      description: `Available: ${VERBOSITY_NAMES.map((n) => `\`${n}\``).join(', ')}`,
    };
  }
  userSettingsStore.setUserDefaultLogVerbosity(userId, resolved);
  return {
    ok: true,
    summary: `📊 Verbosity → \`${resolved}\``,
    description: VERBOSITY_DESCRIPTIONS[resolved],
  };
}

export function createVerbosityTopicBinding(): ZTopicBinding {
  return {
    topic: 'verbosity',
    apply: (args) => applyVerbosity({ userId: args.userId, value: args.value }),
    renderCard: (args) => renderVerbosityCard({ userId: args.userId, issuedAt: args.issuedAt }),
  };
}
