/**
 * pr-watch's settled delivery, as the per-user task queue needs it (a shared dev host, 2026-11-24).
 *
 * A pr-watch CI or review message wakes a task of its own: when its owner already runs as many tasks as they may, it
 * must not start another. It must not line up as their request either — once in the queue it outlives pr-watch's own
 * checks (a merged PR's message, a closed session's), and the queue replayed it into a thread its owner had closed.
 * So it waits where those checks run: `state` reads `busy` until the owner has a free slot, and `inject` reserves that
 * slot as it sends (`reserveHostTurn`) — a request, or a second pr-watch message, that arrives before this one reaches
 * the gate waits behind it — and marks the event `userTaskReady`, which the gate lets through on that reservation.
 */
import type { SyntheticMessageEvent } from '../cron-scheduler';
import type { DeliveryState } from '../session-pr-watch';
import { releaseUserTaskHostTurn, reserveUserTaskHostTurn, userTaskSlotFree } from './active';

export interface PrWatchSession {
  channelId?: string;
  threadTs?: string;
  ownerId?: string;
  terminated?: boolean;
  activityState?: string;
}

export interface PrWatchPortsDeps {
  getSession(sessionKey: string): PrWatchSession | undefined;
  /** No request runs in the thread and no dispatch slot is held (`SlackHandler.isHostTurnFree`). */
  isHostTurnFree(channel: string, threadTs?: string): boolean;
  inject(event: SyntheticMessageEvent): Promise<void>;
}

export function prWatchDeliveryPorts(deps: PrWatchPortsDeps): {
  state: (sessionKey: string) => DeliveryState;
  inject: (sessionKey: string, text: string) => Promise<void>;
} {
  return {
    state: (sessionKey) => {
      const s = deps.getSession(sessionKey);
      if (!s?.channelId || s.terminated) return 'gone';
      if (s.activityState && s.activityState !== 'idle') return 'busy';
      if (!userTaskSlotFree(s.ownerId, sessionKey)) return 'busy';
      return deps.isHostTurnFree(s.channelId, s.threadTs) ? 'ready' : 'busy';
    },
    inject: async (sessionKey, text) => {
      const s = deps.getSession(sessionKey);
      if (!s?.channelId) return;
      // In the same tick as the `ready` it follows: nothing took the slot in between.
      reserveUserTaskHostTurn(s.ownerId, sessionKey);
      try {
        await deps.inject({
          user: s.ownerId ?? '',
          channel: s.channelId,
          thread_ts: s.threadTs,
          ts: `${Date.now() / 1000}`,
          text,
          synthetic: true,
          skipDispatch: true,
          routeContext: { skipAutoBotThread: true, userTaskReady: true },
        });
      } catch (error) {
        // It never reached the gate: the slot it held goes back (a request would otherwise wait out the expiry).
        releaseUserTaskHostTurn(sessionKey);
        throw error;
      }
    },
  };
}
