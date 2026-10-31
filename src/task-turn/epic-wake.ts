/**
 * E4 ⑥ — waking an epic (.prd/19 D7).
 *
 * An epic with pending chain-end events (⑤) wakes when it is idle: one start
 * through the controller as a host start (the tree's slot, window and cost
 * cap apply), with a fixed text. The start's saved first turn consumes the
 * events (`beginTaskTurn(…, consume)`), so a refused start leaves them
 * pending, and a wake chain reconciled `interrupted` on restart puts them back.
 *
 * Callers (index.ts): the post-drain idle hook (the epic's chain ended), the
 * registry's event listener (an event was just added), and a boot scan after
 * the web server is up. A wake runs off the commit path (`queueMicrotask`).
 * Two that overlap start once: the controller admits one chain per task
 * before its first await, and the other's events stay pending for the next.
 * Never the cron path or `wakeFromSleep`.
 */
import type { ConversationSession } from '../types';
import { epicWakeText, isEpicDone, wakeableEpicEvents } from './epic-plan';
import type { TaskTurnController } from './task-turn-controller';

export interface EpicWakerDeps {
  getSession(sessionKey: string): ConversationSession | undefined;
  controller: Pick<TaskTurnController, 'start'>;
  logger: { info(message: string, meta?: object): void; warn(message: string, meta?: object): void };
}

export interface EpicWaker {
  /** Wake this task if it is a live, idle epic that is not done and has pending events. Never throws. */
  wake(sessionKey: string): void;
}

export function createEpicWaker(deps: EpicWakerDeps): EpicWaker {
  async function drain(sessionKey: string): Promise<void> {
    const epic = deps.getSession(sessionKey);
    if (!epic || epic.slackless !== true || epic.kind !== 'epic' || epic.terminated) return;
    if ((epic.activityState ?? 'idle') !== 'idle' || isEpicDone(epic.plan)) return;
    const events = wakeableEpicEvents(epic.epicEvents);
    if (events.length === 0) return;
    const started = await deps.controller.start({
      sessionKey,
      text: epicWakeText(events),
      actorUserId: epic.ownerId,
      initiator: 'host',
    });
    if (started.status !== 202) {
      deps.logger.info('Epic wake not started — its events stay pending', {
        sessionKey,
        status: started.status,
        error: started.body.error,
      });
    }
  }

  return {
    wake(sessionKey) {
      queueMicrotask(() => {
        drain(sessionKey).catch((error) => {
          deps.logger.warn('Epic wake failed — its events stay pending', {
            sessionKey,
            error: (error as Error)?.message ?? String(error),
          });
        });
      });
    },
  };
}
