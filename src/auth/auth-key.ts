/**
 * AuthKey v2 — tagged union of all credential shapes the daemon can use
 * to authenticate a Claude Code spawn (#575).
 *
 * Two top-level arms:
 *   • `ApiKeySlot`   — raw Anthropic API keys (sk-ant-api03-…). Headless,
 *                      no OAuth attachment, no ToS risk flag.
 *   • `CctSlot`      — a consumer-console (Claude Code) credential. Further
 *                      split into a sub-union on `source`:
 *         ◦ `source: 'setup'`                — a real setupToken bound to a
 *                                              Max seat. OAuth attachment is
 *                                              optional (lifted on first use).
 *         ◦ `source: 'legacy-attachment'`    — v1 schemas that shipped only
 *                                              an `oauth_credentials` blob
 *                                              with no matching setupToken.
 *                                              Requires `oauthAttachment` and
 *                                              the `acknowledgedConsumerTosRisk`
 *                                              literal-true flag.
 *
 * `keyId` is the immutable ULID identity (replaces the v1 `slotId`).
 * `name` is the mutable human-facing label.
 */

/** Refresh-flow fields that can be attached to a CCT slot. */
export interface OAuthAttachment {
  accessToken: string;
  refreshToken: string;
  /** Absolute epoch ms — Date.now() + expires_in*1000 at refresh time. */
  expiresAtMs: number;
  scopes: string[];
  /** e.g. 'max_5x'. */
  subscriptionType?: string;
  /** e.g. 'default_claude_max_5x'. */
  rateLimitTier?: string;
  /**
   * Operator must acknowledge that attaching consumer OAuth to a daemon
   * slot is not sanctioned by Anthropic's Consumer ToS. Literal-true so
   * the migrator / UI cannot silently drop the flag.
   */
  acknowledgedConsumerTosRisk: true;
}

/** Raw Anthropic API key. Headless; no OAuth attachment. */
export interface ApiKeySlot {
  kind: 'api_key';
  keyId: string;
  name: string;
  value: string;
  createdAt: string;
}

/**
 * CCT slot whose primary identity is a real setupToken (`sk-ant-oat01-…`).
 * OAuth attachment is optional — it appears after the first refresh or
 * after explicit operator attachment.
 */
export interface CctSlotWithSetup {
  kind: 'cct';
  source: 'setup';
  keyId: string;
  name: string;
  /** sk-ant-oat01-… */
  setupToken: string;
  oauthAttachment?: OAuthAttachment;
  createdAt: string;
}

/**
 * CCT slot that was migrated from a v1 `oauth_credentials` record — we
 * never saw the source setupToken, only the access/refresh blob. The
 * attachment is mandatory; without it the slot is useless.
 */
export interface CctSlotLegacyAttachmentOnly {
  kind: 'cct';
  source: 'legacy-attachment';
  keyId: string;
  name: string;
  oauthAttachment: OAuthAttachment;
  createdAt: string;
}

export type CctSlot = CctSlotWithSetup | CctSlotLegacyAttachmentOnly;

/** Top-level 2-arm tagged union persisted in `CctStoreSnapshot.registry.slots`. */
export type AuthKey = ApiKeySlot | CctSlot;

/**
 * Exhaustive kind literal for quick-access switches. Keep in sync with the
 * union above — TS will fail at the consumer sites if a new arm is added
 * but this alias is not extended.
 */
export type AuthKeyKind = AuthKey['kind'];

/**
 * Type guard: narrows an `AuthKey` to the CCT arm. Centralised so callers
 * don't each re-write the `kind === 'cct'` check (and forget the sub-union).
 */
export function isCctSlot(key: AuthKey): key is CctSlot {
  return key.kind === 'cct';
}

/** Type guard: true for the CCT sub-arm that carries a setupToken. */
export function isCctWithSetup(key: AuthKey): key is CctSlotWithSetup {
  return key.kind === 'cct' && key.source === 'setup';
}

/** Type guard: true for the CCT sub-arm lifted from a v1 oauth-only record. */
export function isCctLegacyAttachmentOnly(key: AuthKey): key is CctSlotLegacyAttachmentOnly {
  return key.kind === 'cct' && key.source === 'legacy-attachment';
}

/** Type guard: true for bare API-key slots. */
export function isApiKeySlot(key: AuthKey): key is ApiKeySlot {
  return key.kind === 'api_key';
}
