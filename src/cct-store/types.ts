/**
 * Persistent state types for the CCT token-slot store.
 *
 * A "slot" is a named container for one credential — either a legacy
 * `setup_token` (sk-ant-oat01-...) or an `oauth_credentials` bundle
 * owned by the operator. Slot identity (`slotId`) is immutable; the
 * human-facing `name` is mutable.
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
}

export interface CctRegistry {
  activeSlotId?: string;
  slots: TokenSlot[];
}

export interface CctStoreSnapshot {
  version: 1;
  /** Monotonic counter for optimistic CAS on save. */
  revision: number;
  registry: CctRegistry;
  /** Keyed by slotId. */
  state: Record<string, SlotState>;
}
