/**
 * The host side of the work queue (.prd/36, .prd/37 §4).
 *
 * The MCP processes line threads up in the ledger file and hand the lane on when an entry ends (`somalib/work-queue`).
 * What only the host can do lives here:
 *
 * - **Wake** — an entry that was promoted to `running` and whose thread has not been told (`notifiedAt` unset) gets
 *   one host turn in its thread (`deliver`: the settled delivery the PR watch and RUN_ENV_SKILL use). Stamped once
 *   the wake went in; a thread that cannot take it (gone, asleep) gives its turn to the next entry.
 * - **Sweep** — a running entry whose thread stopped working on it is given back: not working, no environment hand-off
 *   running, and idle for {@link WORK_QUEUE_IDLE_GRACE_MS} (waiting on a person: {@link WORK_QUEUE_ASKING_GRACE_MS})
 *   since it last changed or was woken, or working longer than {@link WORK_QUEUE_WORKING_MAX_MS} (a crash left it so).
 *   Its thread gets one `⏹` line. A waiting entry whose thread is gone leaves the line. A model that forgets
 *   `queue_done` never blocks a lane.
 * - **Read** — where a thread stands (`statusFor`), whether it waits on the host (`awaitsHost`: the board, the goal
 *   loop and the follow-up question read it), and `whenFree` (an environment hand-off ends when the environment
 *   user's thread holds no entry, .prd/36 D9). Every read re-reads the file when it changed — a turn that just
 *   entered the queue must read as waiting at the very moment it ends.
 */
import type { WorkQueueEntry, WorkQueueHolder, WorkQueueLedger } from 'somalib/work-queue/ledger';
import { emptyLedger, markNotified, queuePosition, releaseByHost, sameHolder } from 'somalib/work-queue/ledger';
import type { WorkQueueStore } from 'somalib/work-queue/store';
import { Logger } from '../logger';

/** A running entry whose thread stopped working this long (idle) is given back. */
export const WORK_QUEUE_IDLE_GRACE_MS = 5 * 60_000;
/** … this long, when the thread waits on a person's answer. */
export const WORK_QUEUE_ASKING_GRACE_MS = 10 * 60_000;
/** A turn working longer than this reads as stuck (a crash left the session `working`). */
export const WORK_QUEUE_WORKING_MAX_MS = 6 * 60 * 60_000;
/** How often the host looks at the file (it re-reads only when it changed). */
export const WORK_QUEUE_TICK_MS = 3_000;
/** How often the host sweeps. */
export const WORK_QUEUE_SWEEP_MS = 15_000;

/** What the host knows of a holder's session. */
export interface HolderProbe {
  /** The session is there, open and awake. */
  exists: boolean;
  activity?: 'working' | 'waiting' | 'idle';
  activityChangedAt?: number;
  /** An environment hand-off this thread asked for is still running. */
  handoffActive?: boolean;
}

export type WakeOutcome = 'injected' | 'expired' | 'gone';

export interface WorkQueueHostDeps {
  store: Pick<WorkQueueStore, 'read' | 'mutate' | 'mtimeMs'>;
  probe: (holder: WorkQueueHolder) => HolderProbe;
  /** One host turn into the holder's thread once it is free; `done` says how it ended. */
  deliver: (holder: WorkQueueHolder, text: string, done: (outcome: WakeOutcome) => void) => void;
  /** One line into the holder's thread (never throws to the caller). */
  post: (holder: WorkQueueHolder, text: string) => Promise<unknown>;
  now?: () => number;
}

/** Where a thread stands in the queues: its waiting entry first, else its running one. */
export interface WorkQueueThreadStatus {
  queue: string;
  entry: string;
  state: 'queued' | 'running';
  /** 0 = runs; n = n-th waiting. */
  position: number;
  keys: string[];
  /** When it entered the state it is in. */
  since: number;
}

export function wakeText(entry: WorkQueueEntry): string {
  return (
    `[work-queue] Your turn in ${entry.queue}: entry ${entry.id} (${entry.keys.join(', ')}) runs now. ` +
    'Do the work it was entered for now — re-check what changed while it waited — and call ' +
    `queue_done {"entry": "${entry.id}"} when the work ends (queue_cancel if it is no longer needed). ` +
    'This comes from the host, not the user.'
  );
}

const RELEASE_WHY: Record<string, string> = {
  'holder-idle': '세션이 일을 하지 않음',
  'holder-asking': '사람 답을 오래 기다림',
  'holder-stuck': '턴이 너무 오래 멈춰 있음',
};

export function releasedText(entry: WorkQueueEntry, reason: string): string {
  return (
    `⏹ 작업 큐 \`${entry.queue}\` 차례를 돌려놓았습니다 (${entry.id} · ${RELEASE_WHY[reason] ?? reason}). ` +
    '다시 하려면 큐에 다시 들어가세요.'
  );
}

export class WorkQueueHost {
  private readonly logger = new Logger('WorkQueueHost');
  private readonly now: () => number;
  private ledger: WorkQueueLedger = emptyLedger();
  private seenMtime: number | undefined | null = null;
  /** Entries whose wake is on its way (never sent twice). */
  private readonly waking = new Set<string>();
  private readonly freeWaiters = new Map<string, Array<() => void>>();
  private lastSweep = 0;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly deps: WorkQueueHostDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(intervalMs = WORK_QUEUE_TICK_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Re-read when the file changed, wake, sweep when due, settle `whenFree`. Never throws. */
  tick(): void {
    try {
      this.refresh();
      this.wake();
      if (this.now() - this.lastSweep >= WORK_QUEUE_SWEEP_MS) this.sweep();
      this.settleFree();
    } catch (error) {
      this.logger.warn('Work queue tick failed', { error: (error as Error)?.message ?? String(error) });
    }
  }

  statusFor(channel: string | undefined, threadTs: string | undefined): WorkQueueThreadStatus | undefined {
    if (!channel || !threadTs) return undefined;
    this.refresh();
    const mine = this.ledger.entries.filter((e) => sameHolder({ channel, threadTs }, e.holder));
    const shown = mine.find((e) => e.state === 'queued') ?? mine[0];
    if (!shown) return undefined;
    return {
      queue: shown.queue,
      entry: shown.id,
      state: shown.state,
      position: queuePosition(this.ledger, shown),
      keys: [...shown.keys],
      since: shown.state === 'running' ? (shown.grantedAt ?? shown.enteredAt) : shown.enteredAt,
    };
  }

  /** The thread waits in a queue: the host wakes it — no goal judgement, no follow-up question. */
  awaitsHost(channel: string | undefined, threadTs: string | undefined): boolean {
    return this.statusFor(channel, threadTs)?.state === 'queued';
  }

  /** Settles once the thread holds no entry (at once when it holds none now). */
  whenFree(channel: string, threadTs: string): Promise<void> {
    this.refresh();
    if (!this.holds(channel, threadTs)) return Promise.resolve();
    return new Promise((resolve) => {
      const key = `${channel}\u0000${threadTs}`;
      const list = this.freeWaiters.get(key) ?? [];
      list.push(resolve);
      this.freeWaiters.set(key, list);
    });
  }

  /** Give back what nobody works on; drop waiting entries whose thread is gone. */
  sweep(): void {
    this.lastSweep = this.now();
    this.refresh();
    const now = this.now();
    const releases: Array<{ id: string; reason: string }> = [];
    for (const e of this.ledger.entries) {
      const probe = this.safeProbe(e.holder);
      if (!probe.exists) {
        releases.push({ id: e.id, reason: 'holder-gone' });
        continue;
      }
      if (e.state !== 'running' || e.notifiedAt === undefined || this.waking.has(e.id)) continue;
      if (probe.handoffActive) continue;
      const changed = Math.max(Number(probe.activityChangedAt) || 0, e.notifiedAt);
      if (probe.activity === 'working') {
        if (now - changed > WORK_QUEUE_WORKING_MAX_MS) releases.push({ id: e.id, reason: 'holder-stuck' });
        continue;
      }
      const grace = probe.activity === 'waiting' ? WORK_QUEUE_ASKING_GRACE_MS : WORK_QUEUE_IDLE_GRACE_MS;
      if (now - changed >= grace) {
        releases.push({ id: e.id, reason: probe.activity === 'waiting' ? 'holder-asking' : 'holder-idle' });
      }
    }
    if (releases.length === 0) return;
    const ended = this.release(releases);
    for (const e of ended) {
      this.logger.info('Work queue entry released by the host', { entry: e.id, queue: e.queue, reason: e.reason });
      if (e.state === 'running' && e.reason && e.reason !== 'holder-gone') {
        void this.deps.post(e.holder, releasedText(e, e.reason)).catch(() => undefined);
      }
    }
    this.wake();
    this.settleFree();
  }

  private holds(channel: string, threadTs: string): boolean {
    return this.ledger.entries.some((e) => sameHolder({ channel, threadTs }, e.holder));
  }

  private release(releases: Array<{ id: string; reason: string }>) {
    const ended = this.deps.store.mutate((ledger) => {
      const r = releaseByHost(ledger, releases, this.now());
      return { ledger: r.ledger, result: r.ended };
    });
    this.refresh(true);
    return ended;
  }

  private wake(): void {
    for (const e of this.ledger.entries) {
      if (e.state !== 'running' || e.notifiedAt !== undefined || this.waking.has(e.id)) continue;
      this.waking.add(e.id);
      this.logger.info('Work queue turn came — waking the holder', { entry: e.id, queue: e.queue });
      let settled = false;
      const done = (outcome: WakeOutcome): void => {
        if (settled) return;
        settled = true;
        try {
          if (outcome === 'injected') {
            this.deps.store.mutate((ledger) => ({ ledger: markNotified(ledger, e.id, this.now()), result: undefined }));
            this.refresh(true);
          } else {
            this.release([{ id: e.id, reason: outcome === 'gone' ? 'holder-gone' : 'wake-expired' }]);
            this.wake();
            this.settleFree();
          }
        } catch (error) {
          this.logger.warn('Work queue wake bookkeeping failed', { entry: e.id, error: (error as Error)?.message });
        } finally {
          this.waking.delete(e.id);
        }
      };
      try {
        this.deps.deliver(e.holder, wakeText(e), done);
      } catch (error) {
        this.waking.delete(e.id);
        this.logger.warn('Work queue wake failed', { entry: e.id, error: (error as Error)?.message });
      }
    }
  }

  private settleFree(): void {
    for (const [key, resolvers] of [...this.freeWaiters]) {
      const [channel, threadTs] = key.split('\u0000');
      if (this.holds(channel, threadTs)) continue;
      this.freeWaiters.delete(key);
      for (const resolve of resolvers) resolve();
    }
  }

  private safeProbe(holder: WorkQueueHolder): HolderProbe {
    try {
      return this.deps.probe(holder);
    } catch (error) {
      // An unreadable session is not a gone one: keep the entry.
      this.logger.warn('Work queue holder probe failed', { error: (error as Error)?.message });
      return { exists: true, activity: 'working', activityChangedAt: this.now() };
    }
  }

  /** Re-read the ledger when the file changed (`force`: always). A broken file keeps the last good read. */
  private refresh(force = false): void {
    const mtime = this.deps.store.mtimeMs();
    if (!force && mtime === this.seenMtime) return;
    try {
      this.ledger = this.deps.store.read();
      this.seenMtime = mtime;
    } catch (error) {
      this.logger.warn('Work queue ledger unreadable — keeping the last read', {
        error: (error as Error)?.message ?? String(error),
      });
    }
  }
}

/** The process's host (set once at boot); undefined until then — and in tests that do not set it. */
let activeHost: WorkQueueHost | undefined;

export function setActiveWorkQueueHost(host: WorkQueueHost | undefined): void {
  activeHost = host;
}

export function getActiveWorkQueueHost(): WorkQueueHost | undefined {
  return activeHost;
}
