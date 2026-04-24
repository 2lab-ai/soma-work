import path from 'node:path';

// Re-export the AuthKey union so existing callers that imported the old
// v1 `TokenSlot` family from this package get a single, typed replacement.
export type {
  ApiKeySlot,
  AuthKey,
  AuthKeyKind,
  CctSlot,
  CctSlotLegacyAttachmentOnly,
  CctSlotWithSetup,
  OAuthAttachment,
} from '../auth/auth-key';
export { isApiKeySlot, isCctLegacyAttachmentOnly, isCctSlot, isCctWithSetup } from '../auth/auth-key';
export { migrateLegacyCooldowns } from './migrate';
export { migrateV1ToV2 } from './migrate-v2';
export { CctStore, RevisionConflictError } from './store';
export type {
  AuthState,
  CctRegistry,
  CctStoreSnapshot,
  Lease,
  PersistedSnapshot,
  RateLimitSource,
  RefreshErrorInfo,
  RefreshErrorKind,
  SlotState,
  UsageSnapshot,
  UsageWindow,
} from './types';

/**
 * Default on-disk location for the CCT store.
 *
 * Mirrors the convention used by sibling modules (e.g. `hook-state`,
 * `mcp-call-tracker`, `metrics/report-scheduler`) which all join their
 * file name under `DATA_DIR`. We avoid `require`-ing `env-paths` here so
 * this helper stays usable from tests / scripts that want a DATA_DIR
 * override without triggering `env-paths` branch-detection side effects.
 */
export function defaultCctStorePath(): string {
  const dataDir = process.env.DATA_DIR || './data';
  return path.join(dataDir, 'cct-store.json');
}
