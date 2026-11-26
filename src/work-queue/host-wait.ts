/**
 * "This thread waits on the host" (.prd/36 D8, .prd/37 §6) — one read for the board, the goal loop and the follow-up
 * question:
 *
 * - its entry waits in a work queue → `queued` (the host wakes it when its turn comes);
 * - an environment hand-off it asked for runs → `env`, or `queued` when that environment user's thread itself waits in a
 *   queue (the requester shows the line its work stands in);
 * - its entry runs and it has no turn → `running` (shown, but not a wait: the thread is the one to act).
 */
import { type EnvHandoffRuns, envHandoffRuns } from '../slack/env-handoff-runs';
import { getActiveWorkQueueHost, type WorkQueueHost } from './host';

export type HostWait =
  | { kind: 'queued'; queue: string; position: number; since: number }
  | { kind: 'running'; queue: string; since: number }
  | { kind: 'env'; owner: string; since: number };

export interface HostWaitDeps {
  host: Pick<WorkQueueHost, 'statusFor'> | undefined;
  handoffs: Pick<EnvHandoffRuns, 'statusFor'>;
}

const live = (): HostWaitDeps => ({ host: getActiveWorkQueueHost(), handoffs: envHandoffRuns });

export function hostWaitFor(
  channel: string | undefined,
  threadTs: string | undefined,
  deps: HostWaitDeps = live(),
): HostWait | undefined {
  const handoff = deps.handoffs.statusFor(channel, threadTs);
  if (handoff) {
    const env = handoff.envThread && deps.host?.statusFor(handoff.envThread.channel, handoff.envThread.threadTs);
    if (env?.state === 'waiting') return { kind: 'queued', queue: env.queue, position: env.position, since: env.since };
    return { kind: 'env', owner: handoff.owner, since: handoff.since };
  }
  const own = deps.host?.statusFor(channel, threadTs);
  if (!own) return undefined;
  if (own.state === 'waiting') return { kind: 'queued', queue: own.queue, position: own.position, since: own.since };
  return { kind: 'running', queue: own.queue, since: own.since };
}

/** The thread's next actor is the host: no goal judgement, no follow-up question. */
export function waitsOnHost(
  channel: string | undefined,
  threadTs: string | undefined,
  deps: HostWaitDeps = live(),
): boolean {
  const wait = hostWaitFor(channel, threadTs, deps);
  return wait !== undefined && wait.kind !== 'running';
}
