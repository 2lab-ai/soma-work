/**
 * OAuth helper modules for Claude CCT credentials.
 *
 * Pure functions — no global state or coupling to TokenManager. The W2
 * integrator wires these into the CCT slot store.
 */

export type { UsageSnapshot } from '../cct-store/types';
export {
  type ActiveSummary,
  buildRotationDebug,
  type EvaluateAndRotateOpts,
  evaluateAndMaybeRotate,
  type RejectReason,
  type RotationCandidate,
  type RotationDebug,
  type RotationDeps,
  type RotationOutcome,
  type RotationThresholds,
  selectBestRotationCandidate,
} from './auto-rotate';
export { notifyAutoRotation, type RotationNotifyPayload } from './auto-rotate-notifier';
export {
  hintsIndicateExhausted,
  parseRateLimitHeaders,
  type RateLimitHint,
} from './header-parser';
export {
  DEFAULT_OAUTH_REFRESH_INTERVAL_MS,
  DEFAULT_OAUTH_REFRESH_TIMEOUT_MS,
  OAuthRefreshScheduler,
  type OAuthRefreshSchedulerOpts,
  startOAuthRefreshScheduler,
} from './oauth-refresh-scheduler';
export {
  CLAUDE_OAUTH_PROFILE_URL,
  fetchOAuthProfile,
  type OAuthProfile,
  OAuthProfileUnauthorizedError,
} from './profile';
export type { OAuthCredentials } from './refresher';
export {
  CLAUDE_OAUTH_CLIENT_ID,
  CLAUDE_OAUTH_REFRESH_URL,
  OAuthRefreshError,
  refreshClaudeCredentials,
} from './refresher';
export {
  CLAUDE_USAGE_URL,
  fetchUsage,
  nextUsageBackoffMs,
  UsageFetchError,
  type UsageFetchResult,
} from './usage';
export {
  startUsageRefreshScheduler,
  UsageRefreshScheduler,
  type UsageSchedulerOpts,
} from './usage-scheduler';
