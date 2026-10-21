/**
 * Boot step for the llmux model-catalog overlay — gated on the RUNTIME auth
 * mode, not the static `config.auth.mode`.
 *
 * Why the runtime gate matters: hosts without an `AUTH_MODE=llmux` env
 * (e.g. work-m64 dev) boot with static mode `ccp`, and `initAuthRuntimeDefault`
 * only flips the LIVE mode to llmux after its reachability probe. The
 * catalog fetch originally lived inside the static `config.auth.mode ===
 * 'llmux'` block in index.ts, so those hosts never fetched the catalog:
 * no `grok-4.5` in the model list and no snapshot file, even though their
 * local llmux served `/llmux/models` correctly. Call this AFTER
 * `initAuthRuntimeDefault` with the resolved runtime mode instead.
 *
 * The fetcher is wired unconditionally (it resolves the baseUrl from the
 * live auth-runtime settings on every call), so a later runtime switch to
 * llmux lets TTL background refreshes (`maybeRefreshInBackground`) populate
 * the catalog without a restart. The boot-time fetch itself only runs when
 * the runtime mode is already llmux. Fail-soft: errors never block boot.
 */

import { fetchLlmuxModels } from './auth/llmux-client';
import { Logger } from './logger';
import { type CatalogFetcher, modelCatalog } from './model-catalog';

const logger = new Logger('ModelCatalogBoot');

export interface BootModelCatalogResult {
  /** True when a boot-time fetch was attempted (runtime mode was llmux). */
  attempted: boolean;
  ok?: boolean;
  /** Entry count after the step (current entries on failure/skip). */
  count?: number;
  error?: string;
}

/**
 * Wire the llmux catalog fetcher and, when the resolved RUNTIME auth mode is
 * llmux, fetch the catalog once so catalog models (grok-4.5 et al) are
 * selectable from the first turn. Never throws.
 */
export async function bootModelCatalog(
  runtimeAuthMode: string,
  fetchImpl?: CatalogFetcher,
): Promise<BootModelCatalogResult> {
  // No explicit baseUrl: fetchLlmuxModels resolves the live runtime llmux
  // settings per call, so `auth` runtime switches are honored automatically.
  modelCatalog.setFetcher(fetchImpl ?? (() => fetchLlmuxModels()));

  if (runtimeAuthMode !== 'llmux') {
    logger.info(`model catalog boot fetch skipped (runtime auth mode: ${runtimeAuthMode})`);
    return { attempted: false, count: modelCatalog.getModels().length };
  }

  const result = await modelCatalog.refresh();
  if (result.ok) {
    logger.info(`llmux model catalog: ${result.count} models`);
  } else {
    const fetchedAt = modelCatalog.getFetchedAt();
    const snapshotAge = fetchedAt ? `snapshot age ${Math.round((Date.now() - fetchedAt) / 60_000)}min` : 'no snapshot';
    logger.warn(
      `llmux model catalog fetch failed — using static allow-list (+${result.count} snapshot models, ${snapshotAge}): ${result.error}`,
    );
  }
  return { attempted: true, ok: result.ok, count: result.count, error: result.error };
}
