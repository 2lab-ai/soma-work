/**
 * Process-wide work queue wiring: the queues from `config.json#workQueues`
 * (installed once at boot, like `setUiSurfacesConfig`) and the one service
 * every Slack surface of this process shares — one process serves all users,
 * so this is the "across all users" scope.
 */
import { DEFAULT_WORK_QUEUES, parseWorkQueuesConfig, type WorkQueueDef } from './config';
import type { WorkQueueService } from './service';

let queues: WorkQueueDef[] = DEFAULT_WORK_QUEUES.map((q) => ({ ...q }));
let service: WorkQueueService | undefined;

/** Install `config.json#workQueues`. Returns the parser's warnings. */
export function setWorkQueuesConfig(raw: unknown): { queues: WorkQueueDef[]; warnings: string[] } {
  const parsed = parseWorkQueuesConfig(raw);
  queues = parsed.queues;
  return parsed;
}

export function getWorkQueues(): readonly WorkQueueDef[] {
  return queues;
}

export function setWorkQueueService(next: WorkQueueService | undefined): void {
  service = next;
}

export function getWorkQueueService(): WorkQueueService | undefined {
  return service;
}
