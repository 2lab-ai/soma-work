/**
 * OAuth helper modules for Claude CCT credentials.
 *
 * Pure functions — no global state or coupling to TokenManager. The W2
 * integrator wires these into the CCT slot store.
 *
 * This barrel exports exactly the surface consumed by `src/index.ts`
 * (its only importer). Import submodules directly for anything else.
 */

export { evaluateAndMaybeRotate } from './auto-rotate';
export { notifyAutoRotation } from './auto-rotate-notifier';
export {
  OAuthRefreshScheduler,
  startOAuthRefreshScheduler,
} from './oauth-refresh-scheduler';
export {
  startUsageRefreshScheduler,
  UsageRefreshScheduler,
} from './usage-scheduler';
