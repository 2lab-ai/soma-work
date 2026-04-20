/**
 * Compaction Tracking (#617) — turn-end threshold check.
 *
 * Runs after every completed assistant turn. When the current context-usage %
 * is greater than or equal to the user's per-user threshold (50–95, default 80),
 * it marks the session with `autoCompactPending=true` and announces the
 * decision on the thread. The next user turn is intercepted by
 * `InputProcessor` and converted into a `/compact` prompt (AC3).
 *
 * The check is idempotent within a turn — repeated calls while
 * `autoCompactPending` is already set are no-ops so that re-entry paths
 * (continuation, `/compact` loop) don't double-post.
 */

import type { Logger } from '../logger';
import { resolveContextWindow } from '../metrics/model-registry';
import { ContextWindowManager } from '../slack/context-window-manager';
import type { SlackApiHelper } from '../slack/slack-api-helper';
import type { ConversationSession } from '../types';
import type { UserSettingsStore } from '../user-settings-store';

/**
 * Integer context-usage percent for a session. Uses the shared
 * `ContextWindowManager.computeUsedTokens` so the formula stays in sync with
 * the dashboard. Returns `undefined` when usage is missing — caller treats
 * that as "below threshold".
 */
export function computeContextUsagePct(session: ConversationSession): number | undefined {
  const usage = session.usage;
  if (!usage) return undefined;
  const contextWindow =
    usage.contextWindow && usage.contextWindow > 0 ? usage.contextWindow : resolveContextWindow(session.model);
  if (contextWindow <= 0) return undefined;

  const usedTokens = ContextWindowManager.computeUsedTokens(usage);
  const pct = (usedTokens / contextWindow) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

export interface CheckAndSchedulePendingCompactArgs {
  session: ConversationSession;
  userId: string;
  channel: string;
  threadTs: string;
  userSettings: UserSettingsStore;
  slackApi: SlackApiHelper;
  logger?: Logger;
}

/**
 * Returns `true` when the threshold was crossed and `autoCompactPending` was
 * set (so the caller can log/meter the transition). Returns `false` when the
 * session is still under threshold, when `autoCompactPending` was already
 * scheduled, or when usage data is unavailable.
 *
 * Trace: docs/issues/compact-tracking.md AC3.
 */
export async function checkAndSchedulePendingCompact(args: CheckAndSchedulePendingCompactArgs): Promise<boolean> {
  const { session, userId, channel, threadTs, userSettings, slackApi, logger } = args;

  // Already scheduled — another turn will consume it. Idempotent by design.
  if (session.autoCompactPending) return false;

  const pct = computeContextUsagePct(session);
  if (pct === undefined) return false;

  // Remember the latest observation regardless of threshold; used as the "Y"
  // fallback by the PostCompact "complete" post when the SDK-provided usage
  // data is unavailable.
  session.lastKnownUsagePct = pct;

  const threshold = userSettings.getUserCompactThreshold(userId);
  if (pct < threshold) return false;

  session.autoCompactPending = true;

  try {
    await slackApi.postSystemMessage(
      channel,
      `🗜️ Context usage ${pct}% ≥ threshold ${threshold}% — next turn will auto /compact`,
      { threadTs },
    );
  } catch (err) {
    // Posting is best-effort — even if Slack is flaky, the flag is already set
    // and the next turn will still be compacted. Just log.
    logger?.warn('checkAndSchedulePendingCompact: slackPost failed', {
      error: (err as Error)?.message ?? String(err),
    });
  }

  return true;
}
