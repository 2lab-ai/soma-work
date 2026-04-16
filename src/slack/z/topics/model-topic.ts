/**
 * `/z model` Block Kit topic — Phase 2 (#507).
 */

import { AVAILABLE_MODELS, MODEL_ALIASES, userSettingsStore } from '../../../user-settings-store';
import type { ApplyResult, RenderResult, ZTopicBinding } from '../../actions/z-settings-actions';
import { buildSettingCard } from '../ui-builder';

/** Short aliases featured as primary buttons (resolved to real model ids by the store). */
const FEATURED_ALIASES = ['sonnet', 'opus', 'haiku'] as const;

export async function renderModelCard(args: { userId: string; issuedAt: number }): Promise<RenderResult> {
  const { userId, issuedAt } = args;
  const current = userSettingsStore.getUserDefaultModel(userId);
  const currentDisplay = userSettingsStore.getModelDisplayName(current);

  // Featured aliases first (easy to hit), then each full model id as a power-user option.
  const options: Array<{ id: string; label: string; description?: string }> = [];
  for (const alias of FEATURED_ALIASES) {
    const resolved = MODEL_ALIASES[alias];
    if (!resolved) continue;
    options.push({
      id: alias,
      label: alias,
      description: userSettingsStore.getModelDisplayName(resolved),
    });
  }
  for (const id of AVAILABLE_MODELS) {
    options.push({
      id,
      label: userSettingsStore.getModelDisplayName(id),
      description: id,
    });
  }

  const blocks = buildSettingCard({
    topic: 'model',
    icon: '🤖',
    title: 'Model',
    currentLabel: `${currentDisplay} (\`${current}\`)`,
    options,
    additionalCommands: ['`/z model list` — 텍스트 목록', '`/z model set <name>` — 직접 지정'],
    issuedAt,
  });

  return {
    text: `🤖 Model (current: ${currentDisplay})`,
    blocks,
  };
}

export async function applyModel(args: { userId: string; value: string }): Promise<ApplyResult> {
  const { userId, value } = args;
  const resolved = userSettingsStore.resolveModelInput(value);
  if (!resolved) {
    const aliases = Object.keys(MODEL_ALIASES)
      .map((a) => `\`${a}\``)
      .join(', ');
    return {
      ok: false,
      summary: `❌ Unknown model: \`${value}\``,
      description: `Available aliases: ${aliases}`,
    };
  }
  userSettingsStore.setUserDefaultModel(userId, resolved);
  return {
    ok: true,
    summary: `🤖 Model → ${userSettingsStore.getModelDisplayName(resolved)}`,
    description: `\`${resolved}\` — _applied to future sessions._`,
  };
}

export function createModelTopicBinding(): ZTopicBinding {
  return {
    topic: 'model',
    apply: (args) => applyModel({ userId: args.userId, value: args.value }),
    renderCard: (args) => renderModelCard({ userId: args.userId, issuedAt: args.issuedAt }),
  };
}
