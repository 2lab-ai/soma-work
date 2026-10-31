/**
 * E4 ⑥ — waking an epic (.prd/19 D7).
 *
 * An epic with pending chain-end events (⑤) wakes when it is idle: one start
 * through the controller as a host start (the tree's slot, window and cost
 * cap apply), with a fixed text. The start's saved first turn consumes the
 * events (`beginTaskTurn(…, consume)`), so a refused start leaves them
 * pending, and a wake chain reconciled `interrupted` on restart puts them back.
 *
 * Callers (index.ts): the controller's chain end (`onChainEnd`, after the task
 * is free), the post-drain idle hook, the registry's event listener (an event
 * was just added), and a boot scan after the web server is up. A wake runs off
 * the commit path (`queueMicrotask`). A start refused for now (429 — the tree's
 * window, slot or cost cap; 503 — shutting down) arms one timed retry per
 * epic, so a window that later frees does not leave the events waiting for
 * the next event (fable #702 R1 P2). Only one: a refusal of that retry arms
 * nothing more until a wake is admitted or nothing waits (grok #702 R2) — a
 * cost-capped epic is not knocked on every minute.
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
  /** The delay of the one retry after a 429 or 503 (default one minute). */
  retryMs?: number;
}

export interface EpicWaker {
  /** Wake this task if it is a live, idle epic that is not done and has pending events. Never throws. */
  wake(sessionKey: string): void;
}

export function createEpicWaker(deps: EpicWakerDeps): EpicWaker {
  const retryMs = deps.retryMs ?? 60_000;
  /** One armed retry per epic at most. */
  const retries = new Map<string, ReturnType<typeof setTimeout>>();
  /** Epics whose retry has fired: no other until a wake is admitted or nothing waits. */
  const spent = new Set<string>();

  function retryLater(sessionKey: string): void {
    if (retries.has(sessionKey) || spent.has(sessionKey)) return;
    const timer = setTimeout(() => {
      retries.delete(sessionKey);
      spent.add(sessionKey);
      wake(sessionKey);
    }, retryMs);
    timer.unref?.();
    retries.set(sessionKey, timer);
  }

  async function drain(sessionKey: string): Promise<void> {
    const epic = deps.getSession(sessionKey);
    if (!epic || epic.slackless !== true || epic.kind !== 'epic' || epic.terminated) {
      spent.delete(sessionKey);
      return;
    }
    if ((epic.activityState ?? 'idle') !== 'idle' || isEpicDone(epic.plan)) return;
    const events = wakeableEpicEvents(epic.epicEvents);
    if (events.length === 0) {
      spent.delete(sessionKey);
      return;
    }
    const started = await deps.controller.start({
      sessionKey,
      text: epicWakeText(events),
      actorUserId: epic.ownerId,
      initiator: 'host',
    });
    if (started.status === 202) {
      spent.delete(sessionKey);
      return;
    }
    deps.logger.info('Epic wake not started — its events stay pending', {
      sessionKey,
      status: started.status,
      error: started.body.error,
    });
    if (started.status === 429 || started.status === 503) retryLater(sessionKey);
  }

  function wake(sessionKey: string): void {
    queueMicrotask(() => {
      drain(sessionKey).catch((error) => {
        deps.logger.warn('Epic wake failed — its events stay pending', {
          sessionKey,
          error: (error as Error)?.message ?? String(error),
        });
      });
    });
  }

  return { wake };
}
