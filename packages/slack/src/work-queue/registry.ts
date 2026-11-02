/**
 * The work queues from `config.json#workQueues`, installed once at boot (like
 * `setUiSurfacesConfig`). One process serves every user, so the one
 * `WorkQueueService` the `SlackHandler` builds over these queues is the
 * "across all users" scope.
 */
import { DEFAULT_WORK_QUEUES, parseWorkQueuesConfig, type WorkQueueDef } from './config';

let queues: WorkQueueDef[] = DEFAULT_WORK_QUEUES.map((q) => ({ ...q }));

/** Install `config.json#workQueues`. Returns the parser's warnings. */
export function setWorkQueuesConfig(raw: unknown): { queues: WorkQueueDef[]; warnings: string[] } {
  const parsed = parseWorkQueuesConfig(raw);
  queues = parsed.queues;
  return parsed;
}

export function getWorkQueues(): readonly WorkQueueDef[] {
  return queues;
}
