/**
 * soma-work session identity — app-side conventions over the shared
 * soma-lib `domain/session-identity` model (convergence roadmap Step 4d).
 *
 * Canonical session key format: `work:<channelId>:<threadTs|direct>`
 * (shared triplet `tenant:channel:thread`). This replaces the legacy ad-hoc
 * `<channelId>-<threadTs|direct>` format that predated the shared model.
 *
 * Migration model — three persistence surfaces carry keys across the format
 * switch:
 *
 * 1. `sessions.json` — `loadSessions()` re-derives every map key from the
 *    persisted `channelId`/`threadTs` fields via `buildWorkSessionKey`, so
 *    old-format `key` fields migrate automatically (and idempotently) on the
 *    first load after deploy. (The `key` FIELD itself stays in legacy form
 *    for rollback compatibility — see `buildLegacySessionKey`.)
 * 2. Slack action payloads — buttons posted before the deploy embed
 *    old-format keys in their `value` and outlive the restart. Registry
 *    by-key lookups run `normalizeSessionKey` so those clicks keep resolving.
 * 3. Metrics events — records written before the switch carry legacy
 *    `sessionKey`s forever; the report aggregator normalizes keys on READ
 *    at its per-session grouping point, so one session spanning the deploy
 *    does not split into two rows.
 */
import { buildSessionKeyFromInput, parseSessionKey } from 'soma-lib';

/**
 * Tenant id for every soma-work session. soma-work is a single-tenant
 * deployment; the tenant segment names the app family (mirrors soma's
 * app-side `SCHEDULER_TENANT_ID` convention) so keys stay disjoint from
 * soma's `default`/`cron` tenants if the repos ever share storage.
 */
export const WORK_TENANT_ID = 'work';

/**
 * Thread segment used when a session is not bound to a Slack thread
 * (channel-level session). Carried over verbatim from the legacy key format.
 */
export const DIRECT_THREAD_ID = 'direct';

/**
 * Build the canonical session key for a channel/thread pair.
 * Single source of truth — every key construction site routes through here.
 */
export function buildWorkSessionKey(channelId: string, threadTs?: string): string {
  return buildSessionKeyFromInput({
    tenantId: WORK_TENANT_ID,
    channelId,
    threadId: threadTs || DIRECT_THREAD_ID,
  });
}

/**
 * Legacy key format, kept ONLY for the persisted `SerializedSession.key`
 * field. The running system derives its map keys via `buildWorkSessionKey`
 * and ignores the persisted field — its sole consumer is a PRE-4d binary
 * after an emergency rollback, which loads `serialized.key` verbatim and
 * derives legacy keys for lookup. Writing the legacy form there keeps
 * sessions.json loadable in both directions during the transition; drop
 * this (and the field's format) once the rollback horizon has passed.
 */
export function buildLegacySessionKey(channelId: string, threadTs?: string): string {
  return `${channelId}-${threadTs || DIRECT_THREAD_ID}`;
}

/**
 * Normalize a session key that may be in the legacy `<channel>-<thread>`
 * format (e.g. from a Slack action payload posted before the format switch).
 *
 * - Keys that parse as the shared `tenant:channel:thread` format pass
 *   through unchanged.
 * - Legacy keys are split at the FIRST `-` (Slack channel ids are
 *   alphanumeric and never contain `-`; the remainder is the threadTs or
 *   the `direct` sentinel) and rebuilt in the canonical format.
 * - Strings that fit neither shape are returned unchanged — lookups with
 *   them miss, exactly as they did before.
 */
export function normalizeSessionKey(key: string): string {
  try {
    parseSessionKey(key);
    return key;
  } catch {
    const separatorIndex = key.indexOf('-');
    if (separatorIndex <= 0 || separatorIndex === key.length - 1) return key;
    const channelId = key.slice(0, separatorIndex);
    const threadTs = key.slice(separatorIndex + 1);
    try {
      return buildWorkSessionKey(channelId, threadTs === DIRECT_THREAD_ID ? undefined : threadTs);
    } catch {
      return key;
    }
  }
}
