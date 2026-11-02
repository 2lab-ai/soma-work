/**
 * Work queue state — who holds a slot, who is waiting for one.
 *
 * Pure and synchronous: no Slack, no timers. The host (`WorkQueueService`)
 * calls `tick()` on an interval and turns the returned events into Slack
 * messages and replays. Time and session liveness are injected, so every rule
 * below is a unit test.
 *
 * In memory only. After a restart nothing is held: a deploy that was running
 * is auto-resumed through the same session gate and takes the free slot
 * again; a deploy that was waiting on its own question takes it again when
 * its owner answers. Neither can run without passing the gate, so losing the
 * table on restart never lets two deploys overlap — it only drops pending
 * "deploy after" requests, whose buttons then answer "expired".
 *
 * Slot liveness — a holder keeps its slot while ANY of:
 *   - its turn is running (`probe.active`), or
 *   - it is waiting on its own question for less than `holderIdleMs`.
 * Not alive for `graceMs` (sweep path), or the session is gone → released.
 * The idle hook releases at once (`releaseSession`): a turn chain that ended
 * idle is a finished deploy.
 */
import { randomUUID } from 'node:crypto';
import type { WorkQueueDef } from './config';

export interface SessionProbe {
  exists: boolean;
  /** A turn of this session is running now (RequestCoordinator). */
  active: boolean;
  activity?: 'working' | 'waiting' | 'idle';
  /** When `activity` last changed (ms). */
  activityChangedAt?: number;
  workflow?: string;
  /** The session's queue binding; `new` clears it. */
  workQueueId?: string;
}

export interface WorkQueueParty {
  sessionKey: string;
  userId: string;
  channel: string;
  threadTs: string;
}

export interface WorkQueueHolder extends WorkQueueParty {
  acquiredAt: number;
  lastAliveAt: number;
}

export type WaiterState = 'asking' | 'waiting';

export interface WorkQueueWaiter extends WorkQueueParty {
  id: string;
  queueId: string;
  /** The request to replay when the slot frees. */
  text: string;
  state: WaiterState;
  createdAt: number;
  askDeadline: number;
  /** The busy card, once posted. */
  cardTs?: string;
  /** The session had run turns before this request — never terminate it on cancel. */
  ranBefore: boolean;
}

export type ReleaseReason = 'ended' | 'unresponsive' | 'session-gone';
export type CancelReason = 'ask-timeout' | 'user' | 'session-gone' | 'session-reset';

export type WorkQueueEvent =
  | { type: 'released'; queue: WorkQueueDef; holder: WorkQueueHolder; reason: ReleaseReason }
  | { type: 'start'; queue: WorkQueueDef; waiter: WorkQueueWaiter }
  | { type: 'cancelled'; queue: WorkQueueDef; waiter: WorkQueueWaiter; reason: CancelReason };

export type AcquireResult = { ok: true } | { ok: false; holders: WorkQueueHolder[] };

export interface WorkQueueManagerDeps {
  getQueues: () => readonly WorkQueueDef[];
  probe: (sessionKey: string) => SessionProbe;
  now?: () => number;
  /** Sweep-only grace before a not-alive holder is released. */
  graceMs?: number;
}

export const DEFAULT_GRACE_MS = 60_000;

export class WorkQueueManager {
  private readonly holdersByQueue = new Map<string, WorkQueueHolder[]>();
  private readonly waiters = new Map<string, WorkQueueWaiter>();
  private readonly now: () => number;
  private readonly graceMs: number;

  constructor(private readonly deps: WorkQueueManagerDeps) {
    this.now = deps.now ?? Date.now;
    this.graceMs = deps.graceMs ?? DEFAULT_GRACE_MS;
  }

  /** Nothing held, nothing waiting — the sweep has nothing to do. */
  isIdle(): boolean {
    if (this.waiters.size > 0) return false;
    for (const list of this.holdersByQueue.values()) if (list.length > 0) return false;
    return true;
  }

  queues(): readonly WorkQueueDef[] {
    return this.deps.getQueues();
  }

  getQueue(id: string): WorkQueueDef | undefined {
    return this.deps.getQueues().find((q) => q.id === id);
  }

  holders(queueId: string): WorkQueueHolder[] {
    return [...(this.holdersByQueue.get(queueId) ?? [])];
  }

  isHolder(queueId: string, sessionKey: string): boolean {
    return (this.holdersByQueue.get(queueId) ?? []).some((h) => h.sessionKey === sessionKey);
  }

  /** Take a slot, or report who holds them. Re-entrant for the holder session. */
  tryAcquire(queue: WorkQueueDef, party: WorkQueueParty): AcquireResult {
    const list = this.holdersByQueue.get(queue.id) ?? [];
    const mine = list.find((h) => h.sessionKey === party.sessionKey);
    if (mine) {
      mine.lastAliveAt = this.now();
      return { ok: true };
    }
    if (list.length >= queue.concurrency) return { ok: false, holders: [...list] };
    const t = this.now();
    list.push({ ...party, acquiredAt: t, lastAliveAt: t });
    this.holdersByQueue.set(queue.id, list);
    return { ok: true };
  }

  getWaiter(id: string): WorkQueueWaiter | undefined {
    return this.waiters.get(id);
  }

  waiterForSession(sessionKey: string): WorkQueueWaiter | undefined {
    for (const w of this.waiters.values()) if (w.sessionKey === sessionKey) return w;
    return undefined;
  }

  addWaiter(queue: WorkQueueDef, input: WorkQueueParty & { text: string; ranBefore: boolean }): WorkQueueWaiter {
    const t = this.now();
    const waiter: WorkQueueWaiter = {
      ...input,
      id: randomUUID(),
      queueId: queue.id,
      state: 'asking',
      createdAt: t,
      askDeadline: t + queue.askTimeoutMs,
    };
    this.waiters.set(waiter.id, waiter);
    return waiter;
  }

  setWaiterCard(id: string, cardTs: string): void {
    const w = this.waiters.get(id);
    if (w) w.cardTs = cardTs;
  }

  /** 1-based place among the queue's `waiting` requests, oldest first. */
  position(id: string): number | undefined {
    const w = this.waiters.get(id);
    if (!w || w.state !== 'waiting') return undefined;
    return this.waitingOf(w.queueId).findIndex((x) => x.id === id) + 1;
  }

  /** The requester chose "deploy after the current one". */
  chooseWait(id: string): { outcome: 'started' | 'queued' | 'gone'; position?: number; events: WorkQueueEvent[] } {
    const w = this.waiters.get(id);
    const queue = w && this.getQueue(w.queueId);
    if (!w || !queue) return { outcome: 'gone', events: [] };
    w.state = 'waiting';
    const events = this.promote(queue);
    if (!this.waiters.has(id)) return { outcome: 'started', events };
    return { outcome: 'queued', position: this.position(id), events };
  }

  /** One-way: a cancelled request is gone; a second cancel is a no-op. */
  cancel(id: string, reason: CancelReason): WorkQueueEvent[] {
    const w = this.waiters.get(id);
    if (!w) return [];
    this.waiters.delete(id);
    const queue = this.getQueue(w.queueId);
    return queue ? [{ type: 'cancelled', queue, waiter: w, reason }] : [];
  }

  /** Free every slot this session holds and hand them on. */
  releaseSession(sessionKey: string, reason: ReleaseReason): WorkQueueEvent[] {
    const events: WorkQueueEvent[] = [];
    for (const queue of this.queues()) {
      const list = this.holdersByQueue.get(queue.id);
      const holder = list?.find((h) => h.sessionKey === sessionKey);
      if (!list || !holder) continue;
      list.splice(list.indexOf(holder), 1);
      events.push({ type: 'released', queue, holder, reason });
      events.push(...this.promote(queue));
    }
    return events;
  }

  /** The session was deleted: release its slots and cancel its requests. */
  forgetSession(sessionKey: string): WorkQueueEvent[] {
    const events: WorkQueueEvent[] = [];
    for (const w of [...this.waiters.values()]) {
      if (w.sessionKey === sessionKey) events.push(...this.cancel(w.id, 'session-gone'));
    }
    events.push(...this.releaseSession(sessionKey, 'session-gone'));
    return events;
  }

  /** Answer deadlines and slot liveness. Called by the host's sweep. */
  tick(): WorkQueueEvent[] {
    const t = this.now();
    const events: WorkQueueEvent[] = [];
    for (const w of [...this.waiters.values()]) {
      if (w.state === 'asking' && t >= w.askDeadline) events.push(...this.cancel(w.id, 'ask-timeout'));
    }
    for (const queue of this.queues()) {
      for (const holder of [...(this.holdersByQueue.get(queue.id) ?? [])]) {
        const p = this.deps.probe(holder.sessionKey);
        if (!p.exists) {
          events.push(...this.releaseSession(holder.sessionKey, 'session-gone'));
          continue;
        }
        const waitingSince = p.activityChangedAt ?? holder.lastAliveAt;
        const alive = p.active || (p.activity === 'waiting' && t - waitingSince < queue.holderIdleMs);
        if (alive) {
          holder.lastAliveAt = t;
        } else if (t - holder.lastAliveAt >= this.graceMs) {
          events.push(...this.releaseSession(holder.sessionKey, p.activity === 'waiting' ? 'unresponsive' : 'ended'));
        }
      }
    }
    return events;
  }

  private waitingOf(queueId: string): WorkQueueWaiter[] {
    return [...this.waiters.values()]
      .filter((w) => w.queueId === queueId && w.state === 'waiting')
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Fill free slots with the oldest `waiting` requests (never `asking` ones). */
  private promote(queue: WorkQueueDef): WorkQueueEvent[] {
    const events: WorkQueueEvent[] = [];
    for (const next of this.waitingOf(queue.id)) {
      const list = this.holdersByQueue.get(queue.id) ?? [];
      if (list.length >= queue.concurrency) break;
      this.waiters.delete(next.id);
      const t = this.now();
      list.push({
        sessionKey: next.sessionKey,
        userId: next.userId,
        channel: next.channel,
        threadTs: next.threadTs,
        acquiredAt: t,
        lastAliveAt: t,
      });
      this.holdersByQueue.set(queue.id, list);
      events.push({ type: 'start', queue, waiter: next });
    }
    return events;
  }
}
