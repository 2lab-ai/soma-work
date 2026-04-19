/**
 * OAuth helper modules for Claude CCT credentials.
 *
 * Pure functions — no global state or coupling to TokenManager. The W2
 * integrator wires these into the CCT slot store.
 */

export type { UsageSnapshot } from '../cct-store/types';
export {
  hintsIndicateExhausted,
  parseRateLimitHeaders,
  type RateLimitHint,
} from './header-parser';
export type { OAuthCredentials } from './refresher';
export {
  CLAUDE_OAUTH_CLIENT_ID,
  CLAUDE_OAUTH_REFRESH_URL,
  OAuthRefreshError,
  refreshClaudeCredentials,
} from './refresher';
export { hasRequiredScopes, missingScopes, REQUIRED_OAUTH_SCOPES } from './scope-check';
export {
  CLAUDE_USAGE_URL,
  fetchUsage,
  nextUsageBackoffMs,
  UsageFetchError,
  type UsageFetchResult,
} from './usage';
