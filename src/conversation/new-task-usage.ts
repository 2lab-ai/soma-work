/**
 * Dashboard "New task" — inputs for the quota battery and the channel list
 * (SSOT 2026-10-23 T3/T5), normalised from the two account pools soma-work can
 * run on, plus two small TTL caches so opening the composer does not hammer
 * llmux or Slack.
 *
 *   - llmux mode: `/llmux/status` accounts (utilization 0..1, model-scoped
 *     weekly windows). Read through the same helpers the `auth` card uses
 *     (`src/slack/auth/capacity.ts`), so the dashboard and Slack agree.
 *   - CCT mode: TokenManager slots (utilization 0..100, 5h / 7d / 7d-sonnet).
 *
 * Only routable accounts count: blocked, auth-failed and API-key accounts are
 * left out of the battery.
 */

import type { LlmuxAccount } from '../auth/llmux-client';
import type { SlotState } from '../cct-store/types';
import { accountGroup, collectScopedWindows, remaining, resetAt } from '../slack/auth/capacity';
import type { UsageAccountView, UsageWindowView } from './new-task';

function llmuxWindow(label: string, window: Parameters<typeof remaining>[0], nowMs: number): UsageWindowView {
  const view: UsageWindowView = { label };
  const left = remaining(window, nowMs);
  if (left !== undefined) view.remaining = left;
  const at = window ? resetAt(window, nowMs) : undefined;
  if (at !== undefined) view.resetsAt = at;
  return view;
}

/** llmux pool → battery inputs. */
export function llmuxAccountsToUsage(accounts: LlmuxAccount[], nowMs: number): UsageAccountView[] {
  return accounts
    .filter((a) => !a.blocked && a.status !== 'auth_failed' && a.type !== 'apikey')
    .map((a) => ({
      group: accountGroup(a),
      windows: [
        llmuxWindow('5h', a.five_hour, nowMs),
        llmuxWindow('7d', a.seven_day, nowMs),
        ...collectScopedWindows(a).map(({ label, window }) => llmuxWindow(label, window, nowMs)),
      ],
      unavailable:
        a.status === 'cooldown' || (Number.isFinite(a.cooldown_until) && (a.cooldown_until ?? 0) > nowMs / 1000),
    }));
}

function cctWindow(label: string, window: { utilization: number; resetsAt: string } | undefined): UsageWindowView {
  const view: UsageWindowView = { label };
  if (window && Number.isFinite(window.utilization)) {
    view.remaining = Math.max(0, Math.min(1, 1 - window.utilization / 100));
    const at = Date.parse(window.resetsAt);
    if (Number.isFinite(at)) view.resetsAt = Math.floor(at / 1000);
  }
  return view;
}

/** CCT slots (TokenManager snapshot state) → battery inputs. All CCT slots serve Claude models. */
export function cctSlotsToUsage(slots: SlotState[], nowMs: number): UsageAccountView[] {
  return slots
    .filter((s) => !s.tombstoned && s.authState === 'healthy')
    .map((s) => {
      const cooldown = s.cooldownUntil ? Date.parse(s.cooldownUntil) : Number.NaN;
      return {
        group: 'claude',
        windows: [
          cctWindow('5h', s.usage?.fiveHour),
          cctWindow('7d', s.usage?.sevenDay),
          cctWindow('7d-sonnet', s.usage?.sevenDaySonnet),
        ],
        unavailable: Number.isFinite(cooldown) && cooldown > nowMs,
      };
    });
}

/**
 * A per-key TTL cache over an async loader. A failed load is not cached (the
 * caller sees the error and the next call retries); `fresh` bypasses the
 * cached value — used for the authorization re-check right before a task is
 * posted.
 */
export function createTtlCache<K, V>(load: (key: K) => Promise<V>, ttlMs: number, now: () => number = Date.now) {
  const entries = new Map<K, { value: V; at: number }>();
  return {
    async get(key: K, options: { fresh?: boolean } = {}): Promise<V> {
      const hit = entries.get(key);
      if (!options.fresh && hit && now() - hit.at < ttlMs) return hit.value;
      const value = await load(key);
      entries.set(key, { value, at: now() });
      return value;
    },
  };
}
