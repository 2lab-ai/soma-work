/**
 * Nominal auth-kind alias shared across CCT callers.
 *
 * This is a pure type-level declaration — there is no runtime consumer.
 *
 * - `setup_token` — legacy `sk-ant-oat01-...` static token slot.
 * - `oauth_credentials` — operator-owned OAuth refresh+access pair.
 * - `api_key` — reserved for the v2.1 `ANTHROPIC_API_KEY` slot kind.
 *   NOT wired into the persisted {@link TokenSlot} union in this file —
 *   the on-disk schema stays 2-way until the API-key work lands.
 *
 * Scope guard: the CCT store's `TokenSlot` union remains
 * `setup_token | oauth_credentials`. `AuthKind` exists so callers that
 * want to forward-declare a future api_key branch can do so without
 * polluting the persisted schema today.
 */
export type AuthKind = 'setup_token' | 'oauth_credentials' | 'api_key';
