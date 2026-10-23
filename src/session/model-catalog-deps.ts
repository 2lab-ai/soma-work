/**
 * Production wiring of `ModelCatalogDeps` (SSOT 2026-10-22 T4): the model
 * allow-list / aliases, the context window and the auto-compact threshold a
 * model compacts at for an owner (no session override).
 */
import { resolveContextWindow } from '../metrics/model-registry';
import { userSettingsStore } from '../user-settings-store';
import { resolveEffectiveAutoCompact } from './autocompact-policy';
import type { ModelCatalogDeps } from './model-switch';

export function productionModelCatalogDeps(): ModelCatalogDeps {
  return {
    resolveModel: (input) => userSettingsStore.resolveModelInput(input),
    contextWindow: (model) => resolveContextWindow(model),
    autoCompactFor: (model, ownerId) =>
      resolveEffectiveAutoCompact({ model, autoCompactTokens: undefined }, ownerId ?? '', userSettingsStore).tokens,
    displayName: (model) => userSettingsStore.getModelDisplayName(model),
  };
}
