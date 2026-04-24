/**
 * Persistent state types for the AuthKey v2 store (#575 PR-A).
 *
 * Schema v2 replaces the v1 `TokenSlot` union with the richer `AuthKey`
 * tagged union (see `src/auth/auth-key.ts`). The on-disk layout changes:
 *
 *   v1:  { version: 1, registry: { activeSlotId?, slots: TokenSlot[] },
 *                     state: Record<slotId, SlotState> }
 *   v2:  { version: 2, registry: { activeKeyId?,  slots: AuthKey[] },
 *                     state: Record<keyId,  SlotState> }
 *
 * The v1 → v2 migrator lives in `./migrate-v2.ts`; it renames
 * `slotId → keyId` / `activeSlotId → activeKeyId`, splits
 * `kind:'setup_token'`  → `{kind:'cct', source:'setup', setupToken}` and
 * `kind:'oauth_credentials'` → `{kind:'cct', source:'legacy-attachment',
 * oauthAttachment}`.
 *
 * Legacy type aliases (`TokenSlot`, `SetupTokenSlot`, `OAuthCredentialsSlot`,
 * `SlotKind`, `OAuthCredentials`) are intentionally *not* re-exported from
 * this module (AC-1 of PR-A). Call sites that still need a per-file alias
 * should define it locally on top of `AuthKey`.
 */

import type { AuthKey } from '../auth/auth-key';

export type AuthState = 'healthy' | 'refresh_failed' | 'revoked';

export type RateLimitSource = 'response_header' | 'error_string' | 'manual';

export interface Lease {
  leaseId: string;
  /** e.g. "stream-executor:<channel>:<ts>" */
  ownerTag: string;
  acquiredAt: string;
  /** TTL 15m by default; heartbeat extends. */
  expiresAt: string;
}

export interface UsageWindow {
  utilization: number;
  resetsAt: string;
}

export interface UsageSnapshot {
  fetchedAt: string;
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  sevenDaySonnet?: UsageWindow;
}

/**
 * Bucketed cause for the most recent OAuth refresh failure. Used both as a
 * UI styling hint (emoji + wording per kind in `buildSlotStatusLine`) and
 * as a metric-grouping key. When deserialising an older snapshot whose
 * persisted kind is not one of these arms, callers fall back to
 * `'unknown'` rather than throwing — we do not want a bad disk string to
 * brick the card.
 */
export type RefreshErrorKind =
  | 'unauthorized'
  | 'revoked'
  | 'rate_limited'
  | 'server'
  | 'network'
  | 'timeout'
  | 'parse'
  | 'unknown';

/**
 * Persistent diagnostic payload for the most recent OAuth refresh failure.
 * Written by `TokenManager.markRefreshFailure`, cleared by the success
 * path of `refreshAccessToken` and by `detachOAuth` / `attachOAuth`.
 *
 * **Safety model (non-negotiable):** the `message` field is sourced ONLY
 * from a fixed ASCII template table in
 * `TokenManager.classifyRefreshError`. Raw `err.message`,
 * `OAuthRefreshError.body`, and any adversary-controlled string never
 * reach this field. This is the secret-leak containment boundary;
 * `src/token-manager.classify-refresh-error.test.ts` fires adversarial
 * `sk-ant-oat01-…` patterns through the classifier and asserts the
 * stored message is exactly the template.
 */
export interface RefreshErrorInfo {
  /** HTTP status if the failure came from the refresh endpoint (401/403/429/5xx); `undefined` for network/abort/parse. */
  status?: number;
  /** UI-safe fixed-template message. NEVER interpolates user-facing or adversary-controlled text. */
  message: string;
  /** Epoch ms — duplicates `SlotState.lastRefreshFailedAt` so log payloads stay self-describing. */
  at: number;
  /** Coarse bucket for UI styling + metric grouping. */
  kind: RefreshErrorKind;
}

export interface SlotState {
  /** ISO UTC; set when rate limit first detected in current window. */
  rateLimitedAt?: string;
  rateLimitSource?: RateLimitSource;
  /** ISO UTC. */
  cooldownUntil?: string;
  /** Default 'healthy'. */
  authState: AuthState;
  /** Replaces refcount. */
  activeLeases: Lease[];
  /** Removal-in-progress; exclude from pickNext. */
  tombstoned?: boolean;
  lastUsageFetchedAt?: string;
  nextUsageFetchAllowedAt?: string;
  usage?: UsageSnapshot;
  /** Count of consecutive usage-fetch failures; reset to 0 on success.
   *  Used as the ladder index for {@link nextUsageBackoffMs}. */
  consecutiveUsageFailures?: number;
  /**
   * Epoch ms of the last OAuth refresh attempt that succeeded. Cleared on
   * detach/attach. The `/cct` card uses this (together with
   * {@link lastRefreshFailedAt}) to contextualise the usage panel's
   * `fetched <ago>` suffix when a refresh is currently failing.
   */
  lastRefreshAt?: number;
  /** Epoch ms of the last OAuth refresh attempt that failed. Cleared on the next successful refresh and on detach/attach. */
  lastRefreshFailedAt?: number;
  /** Diagnostic payload for the last failure. See {@link RefreshErrorInfo} for the fixed-template safety model. */
  lastRefreshError?: RefreshErrorInfo;
  /** Count of consecutive OAuth refresh failures; reset to 0 on success. Absent = 0. */
  consecutiveRefreshFailures?: number;
}

export interface CctRegistry {
  /** keyId of the AuthKey currently selected as active. */
  activeKeyId?: string;
  slots: AuthKey[];
}

export interface CctStoreSnapshot {
  version: 2;
  /** Monotonic counter for optimistic CAS on save. */
  revision: number;
  registry: CctRegistry;
  /** Keyed by AuthKey.keyId. */
  state: Record<string, SlotState>;
}

/**
 * V1 on-disk shape — kept internally for the migrator only. Not part of
 * the public surface; do not re-export from `./index.ts`.
 */
export interface LegacyV1SetupTokenSlot {
  slotId: string;
  name: string;
  kind: 'setup_token';
  value: string;
  createdAt: string;
  acknowledgedConsumerTosRisk?: false;
}

export interface LegacyV1OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  scopes: string[];
  rateLimitTier?: string;
  subscriptionType?: string;
}

export interface LegacyV1OAuthCredentialsSlot {
  slotId: string;
  name: string;
  kind: 'oauth_credentials';
  credentials: LegacyV1OAuthCredentials;
  createdAt: string;
  acknowledgedConsumerTosRisk: true;
}

export type LegacyV1TokenSlot = LegacyV1SetupTokenSlot | LegacyV1OAuthCredentialsSlot;

export interface LegacyV1Registry {
  activeSlotId?: string;
  slots: LegacyV1TokenSlot[];
}

export interface LegacyV1Snapshot {
  version: 1;
  revision: number;
  registry: LegacyV1Registry;
  state: Record<string, SlotState>;
}

/**
 * Either on-disk shape. The `readSnapshotRaw` helper returns this and
 * `load()` decides whether to run the migrator.
 */
export type PersistedSnapshot = CctStoreSnapshot | LegacyV1Snapshot;
