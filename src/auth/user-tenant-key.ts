/**
 * The llmux credential a model call made on behalf of a Slack user carries.
 *
 * In llmux auth mode every SDK call made for a user — their turns AND the side
 * calls around them (workflow classification, goal eval, the guardian, titles,
 * summaries, memory edits) — authenticates with that user's own issued key, so
 * llmux meters it under their tenant instead of the shared key (`local`).
 *
 * `null` means the shared key (legacy tenant), unchanged: no user, a non-llmux
 * auth mode, or issuance unavailable (`ensureTenantKey` never throws).
 */

import { userSettingsStore } from '../user-settings-store';
import { ensureTenantKey, type TenantKeyLease } from './llmux-tenant-keys';

/**
 * Naming/contact hints for a user's llmux client key, so the key is legible in
 * llmux's own admin surfaces. Both fields are optional — an unknown user still
 * gets a key (named by Slack id alone).
 */
function tenantKeyProfile(userId: string): { name?: string; email?: string } {
  const settings = userSettingsStore.getUserSettings(userId);
  return { name: settings?.slackName, email: settings?.email };
}

/** `userId`'s llmux key for this call, or null (shared key) when there is no user or no key. */
export async function userTenantKey(userId: string | undefined): Promise<TenantKeyLease | null> {
  if (!userId) return null;
  return ensureTenantKey(userId, tenantKeyProfile(userId));
}
