/**
 * `/z model` Block Kit topic — Phase 2 (#507).
 */

import { modelCatalog } from '../../../model-catalog';
import {
  AVAILABLE_MODELS,
  isCatalogIdSelectable,
  MODEL_ALIASES,
  userSettingsStore,
} from '../../../user-settings-store';
import type { ApplyResult, RenderResult, ZTopicBinding } from '../../actions/z-settings-actions';
import { buildSettingCard } from '../ui-builder';

/**
 * Short aliases featured as primary buttons (resolved to real model ids by the store).
 *
 * Order matters: this is the exact visual order in the Slack `/z model` card.
 * `fable` leads as the flagship (native 1M, no suffix); `opus[1m]` sits between
 * `opus` and `haiku` so users can jump to the opus 1M variant without scrolling
 * through the full allow-list.
 */
export const FEATURED_ALIASES = ['fable', 'sonnet', 'opus', 'opus[1m]', 'haiku', 'grok'] as const;

export async function renderModelCard(args: { userId: string; issuedAt: number }): Promise<RenderResult> {
  const { userId, issuedAt } = args;
  // Opportunistic catalog revalidation (fire-and-forget, ≥10min TTL) — the
  // card renders immediately from the current overlay either way.
  modelCatalog.maybeRefreshInBackground();
  const current = userSettingsStore.getUserDefaultModel(userId);
  const currentDisplay = userSettingsStore.getModelDisplayName(current);

  // Featured aliases first (easy to hit), then each full model id as a
  // power-user option. Aliases resolve through the store (static aliases +
  // llmux catalog aliases like `grok`); unresolvable ones are skipped so a
  // catalog-less boot never renders a dead button.
  const options: Array<{ id: string; label: string; description?: string }> = [];
  for (const alias of FEATURED_ALIASES) {
    const resolved = userSettingsStore.resolveModelInput(alias);
    if (!resolved) continue;
    options.push({
      id: alias,
      label: alias,
      description: userSettingsStore.getModelDisplayName(resolved),
    });
  }
  const seen = new Set<string>(AVAILABLE_MODELS);
  for (const id of AVAILABLE_MODELS) {
    options.push({
      id,
      label: userSettingsStore.getModelDisplayName(id),
      description: id,
    });
  }
  // llmux model-catalog overlay — catalog models not already in the static
  // allow-list (e.g. grok-4.5), deduped by id. Non-selectable catalog ids
  // (native-1M `[1m]` variants, e.g. `claude-fable-5[1m]`) are skipped — see
  // isCatalogIdSelectable.
  for (const model of modelCatalog.getModels()) {
    if (seen.has(model.id)) continue;
    if (!isCatalogIdSelectable(model.id)) continue;
    seen.add(model.id);
    options.push({
      id: model.id,
      label: userSettingsStore.getModelDisplayName(model.id),
      description: model.id,
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
