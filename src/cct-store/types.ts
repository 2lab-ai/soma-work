/**
 * Persistent state types for the CCT token-slot store.
 *
 * A "slot" is a named container for one credential — either a legacy
 * `setup_token` (sk-ant-oat01-...) or an `oauth_credentials` bundle
 * owned by the operator. Slot identity (`slotId`) is immutable; the
 * human-facing `name` is mutable.
 *
 * Schema versioning:
 *   - `version: 1` — original shape (no per-slot `configDir`).
 *   - `version: 2` — adds optional `configDir` on
 *     {@link OAuthCredentialsSlot} so each oauth slot can own a private
 *     `CLAUDE_CONFIG_DIR`. `setup_token` slots are unchanged.
 *
 * Migrations are implemented in `migrate-v2.ts` (pure) and consumed by
 * `CctStore.upgradeIfNeeded()` on `TokenManager.init()`.
 */

export type SlotKind = 'setup_token' | 'oauth_credentials';

export interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  /** Absolute epoch ms — Date.now() + expires_in*1000 at refresh time. */
  expiresAtMs: number;
  scopes: string[];
  /** e.g. 'default_claude_max_5x' */
  rateLimitTier?: string;
  /** e.g. 'max_5x' */
  subscriptionType?: string;
}

export interface SetupTokenSlot {
  /** ULID — immutable. */
  slotId: string;
  /** Human-facing display name, renamable. */
  name: string;
  kind: 'setup_token';
  /** sk-ant-oat01-... */
  value: string;
  /** ISO UTC. */
  createdAt: string;
  /** Always false/undefined for setup_token. */
  acknowledgedConsumerTosRisk?: false;
}

export interface OAuthCredentialsSlot {
  slotId: string;
  name: string;
  kind: 'oauth_credentials';
  credentials: OAuthCredentials;
  createdAt: string;
  /** Required true for oauth_credentials slots. */
  acknowledgedConsumerTosRisk: true;
  /**
   * Private `CLAUDE_CONFIG_DIR` for this slot. Populated on schema-v2
   * upgrade and on `addSlot({ kind: 'oauth_credentials' })`. Owned by the
   * CCT data dir (`<dataDir>/cct-store.dirs/<slotId>`, mode 0o700).
   *
   * Optional for historical/test fixtures that pre-date v2; in practice
   * every oauth slot created through {@link TokenManager.addSlot} after
   * v2 carries a populated value.
   */
  configDir?: string;
}

export type TokenSlot = SetupTokenSlot | OAuthCredentialsSlot;

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
}

export interface CctRegistry {
  activeSlotId?: string;
  slots: TokenSlot[];
}

/**
 * Current on-disk shape. `version` is widened to `1 | 2` so that a v1
 * snapshot can still be read raw; any consumer of a v2-shape-only value
 * should use {@link SnapshotV2} for clarity.
 */
export interface CctStoreSnapshot {
  version: 1 | 2;
  /** Monotonic counter for optimistic CAS on save. */
  revision: number;
  registry: CctRegistry;
  /** Keyed by slotId. */
  state: Record<string, SlotState>;
}

/**
 * Internal v1 shape — only used as input to the v1→v2 migrator. Same
 * structure as {@link CctStoreSnapshot} but with the literal `version: 1`
 * narrowed.
 */
export interface SnapshotV1 extends Omit<CctStoreSnapshot, 'version'> {
  version: 1;
}

/**
 * Alias for the v2 shape exposed by `CctStore.load()` post-migration.
 * Structurally identical to {@link CctStoreSnapshot}; aliased for
 * migrator signature readability.
 */
export type SnapshotV2 = CctStoreSnapshot;
