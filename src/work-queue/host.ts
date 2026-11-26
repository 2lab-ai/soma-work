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
 * - **Manage** (.prd/36 v2 D13) — an admin takes a waiting entry out of line, lets one go first, or gives a running
 *   turn back (its thread hears `⏹`, the next entry is woken) — the same transitions the tools and the sweep use.
 */

import type { WorkQueueEntry, WorkQueueHolder, WorkQueueLedger } from 'somalib/work-queue/ledger';
import {
  emptyLedger,
  endEntry,
  forgetQueue,
  markNotified,
  putFirst,
  queuePosition,
  queueViews,
  releaseByHost,
  sameHolder,
} from 'somalib/work-queue/ledger';
import type { LineQueueView, LineState } from 'somalib/work-queue/line';
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
  store: Pick<WorkQueueStore, 'read' | 'mutate' | 'stamp'>;
  probe: (holder: WorkQueueHolder) => HolderProbe;
  /**
   * One host turn into the holder's thread once it is free; `done` says how it ended. `current` turns false once the
   * wake is no longer due (the entry ended, or was stamped) — the delivery then drops it.
   */
  deliver: (
    holder: WorkQueueHolder,
    text: string,
    done: (outcome: WakeOutcome) => void,
    current: () => boolean,
  ) => void;
  /** One line into the holder's thread (never throws to the caller). */
  post: (holder: WorkQueueHolder, text: string) => Promise<unknown>;
  /** The lanes `config.json#workQueues` pins: listed even while empty. */
  pinned?: () => readonly string[];
  now?: () => number;
}

/** Where a thread stands in the queues: its waiting entry first, else its running one. */
export interface WorkQueueThreadStatus {
  queue: string;
  entry: string;
  state: LineState;
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
  'wake-expired': '차례를 알리지 못함',
};

function releaseWhy(reason: string): string {
  if (reason.startsWith('admin:')) return '관리자가 돌려놓음';
  return RELEASE_WHY[reason] ?? reason;
}

export function releasedText(entry: Pick<WorkQueueEntry, 'queue' | 'id'>, reason: string): string {
  return (
    `⏹ 작업 큐 \`${entry.queue}\` 차례를 돌려놓았습니다 (${entry.id} · ${releaseWhy(reason)}). ` +
    '다시 하려면 큐에 다시 들어가세요.'
  );
}

/** What an admin does to an entry from the board or the settings page. */
export type ManageAction = 'cancel' | 'first' | 'release';
export type ManageResult = { ok: true } | { ok: false; code: 'UNKNOWN_ENTRY' | 'NOT_WAITING' | 'NOT_RUNNING' };
type ManageOutcome = { ok: true; entry: WorkQueueEntry } | Exclude<ManageResult, { ok: true }>;

export class WorkQueueHost {
  private readonly logger = new Logger('WorkQueueHost');
  private readonly now: () => number;
  private ledger: WorkQueueLedger = emptyLedger();
  private seenStamp: string | undefined | null = null;
  /** A restart is not idle time: no holder's idle clock starts before this host did. */
  private readonly startedAt: number;
  /** Entries whose wake is on its way (never sent twice). */
  private readonly waking = new Set<string>();
  private readonly freeWaiters = new Map<string, Array<() => void>>();
  private lastSweep = 0;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly deps: WorkQueueHostDeps) {
    this.now = deps.now ?? Date.now;
    this.startedAt = this.now();
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
    const shown = mine.find((e) => e.state === 'waiting') ?? mine[0];
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
    return this.statusFor(channel, threadTs)?.state === 'waiting';
  }

  /** Every lane as the board and the settings page draw it (pinned lanes first, even empty). */
  views(pinned: readonly string[] = this.deps.pinned?.() ?? []): LineQueueView[] {
    this.refresh();
    return queueViews(this.ledger, pinned);
  }

  /**
   * An admin's hand on a lane: `cancel` a waiting entry, let one go `first`, or `release` a running one (its thread is
   * told, the next entry is woken). The record names the admin (`admin:<id>`).
   */
  manage(id: string, action: ManageAction, by: string): ManageResult {
    const reason = `admin:${by}`;
    // The state is checked inside the change: another process (an MCP's queue_done) may promote the entry between a
    // read and the write — a waiting entry that became running is not cancelled as waiting (review 2026-11-26).
    const outcome = this.deps.store.mutate((ledger): { ledger: WorkQueueLedger; result: ManageOutcome } => {
      const entry = ledger.entries.find((e) => e.id === id);
      if (!entry) return { ledger, result: { ok: false, code: 'UNKNOWN_ENTRY' } };
      if (action === 'first') {
        const moved = putFirst(ledger, id);
        return { ledger: moved.ledger, result: moved.result.ok ? { ok: true, entry } : moved.result };
      }
      if (action === 'cancel' && entry.state !== 'waiting')
        return { ledger, result: { ok: false, code: 'NOT_WAITING' } };
      if (action === 'release' && entry.state !== 'running')
        return { ledger, result: { ok: false, code: 'NOT_RUNNING' } };
      const ended = endEntry(
        ledger,
        { id, end: action === 'cancel' ? 'cancelled' : 'released', actor: 'admin', reason },
        this.now(),
      );
      if (!ended.result.ok) return { ledger, result: { ok: false, code: 'UNKNOWN_ENTRY' } };
      return { ledger: ended.ledger, result: { ok: true, entry } };
    });
    this.refresh(true);
    if (!outcome.ok) return outcome;
    this.logger.info('Work queue entry managed by an admin', { entry: id, queue: outcome.entry.queue, action, by });
    if (action === 'release') {
      void this.deps.post(outcome.entry.holder, releasedText(outcome.entry, reason)).catch(() => undefined);
    }
    this.wake();
    this.settleFree();
    return { ok: true };
  }

  /**
   * An admin forgets an idle lane: its history goes and an unpinned lane leaves the board (a lane named once by a test
   * or a typo). A lane with a running or waiting entry is refused (`BUSY`).
   */
  forget(queue: string, by: string): { ok: true; removed: number } | { ok: false; code: 'INVALID_QUEUE' | 'BUSY' } {
    const result = this.deps.store.mutate((ledger) => forgetQueue(ledger, queue));
    this.refresh(true);
    if (result.ok) this.logger.info('Work queue lane forgotten by an admin', { queue, removed: result.removed, by });
    return result;
  }

  /**
   * Settles once the thread holds no entry and no turn of it works (a woken turn that called `queue_done` is still
   * writing its end) — at once when that holds now.
   */
  whenFree(channel: string, threadTs: string): Promise<void> {
    this.refresh();
    if (this.free(channel, threadTs)) return Promise.resolve();
    return new Promise((resolve) => {
      const key = `${channel}\u0000${threadTs}`;
      const list = this.freeWaiters.get(key) ?? [];
      list.push(resolve);
      this.freeWaiters.set(key, list);
    });
  }

  /**
   * Give back what nobody works on; drop waiting entries whose thread is gone. A running entry's thread works on it
   * while its turn runs (up to {@link WORK_QUEUE_WORKING_MAX_MS}) or an environment hand-off it asked for runs; idle,
   * it keeps the entry for {@link WORK_QUEUE_IDLE_GRACE_MS}, waiting on a person for
   * {@link WORK_QUEUE_ASKING_GRACE_MS} — counted from the latest of its last activity change, the wake (or the grant,
   * while the wake waits) and this host's start. An entry whose wake waits for a working thread keeps its turn.
   */
  sweep(): void {
    this.lastSweep = this.now();
    this.refresh(true);
    const now = this.now();
    const releases: Array<{ id: string; reason: string }> = [];
    for (const e of this.ledger.entries) {
      const probe = this.safeProbe(e.holder);
      if (!probe.exists) {
        releases.push({ id: e.id, reason: 'holder-gone' });
        continue;
      }
      if (e.state !== 'running' || probe.handoffActive) continue;
      const since = Math.max(Number(probe.activityChangedAt) || 0, e.notifiedAt ?? e.grantedAt ?? 0, this.startedAt);
      if (probe.activity === 'working') {
        if (now - since > WORK_QUEUE_WORKING_MAX_MS) releases.push({ id: e.id, reason: 'holder-stuck' });
        continue;
      }
      const grace = probe.activity === 'waiting' ? WORK_QUEUE_ASKING_GRACE_MS : WORK_QUEUE_IDLE_GRACE_MS;
      if (now - since >= grace) {
        releases.push({ id: e.id, reason: probe.activity === 'waiting' ? 'holder-asking' : 'holder-idle' });
      }
    }
    if (releases.length === 0) {
      this.settleFree();
      return;
    }
    this.releaseAndTell(releases);
  }

  /** Release entries, tell each running one's thread (a gone thread hears nothing), wake who comes next. */
  private releaseAndTell(releases: Array<{ id: string; reason: string }>): void {
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

  /** The thread holds no entry and no turn of it works. */
  private free(channel: string, threadTs: string): boolean {
    if (this.holds(channel, threadTs)) return false;
    return this.safeProbe({ user: '', channel, threadTs }).activity !== 'working';
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
          } else if (this.due(e.id)) {
            this.releaseAndTell([{ id: e.id, reason: outcome === 'gone' ? 'holder-gone' : 'wake-expired' }]);
          }
        } catch (error) {
          this.logger.warn('Work queue wake bookkeeping failed', { entry: e.id, error: (error as Error)?.message });
        } finally {
          this.waking.delete(e.id);
        }
      };
      try {
        this.deps.deliver(e.holder, wakeText(e), done, () => this.due(e.id));
      } catch (error) {
        this.waking.delete(e.id);
        this.logger.warn('Work queue wake failed', { entry: e.id, error: (error as Error)?.message });
      }
    }
  }

  /** The entry still runs and its thread has not been told: its wake is still due. */
  private due(id: string): boolean {
    this.refresh();
    return this.ledger.entries.some((x) => x.id === id && x.state === 'running' && x.notifiedAt === undefined);
  }

  private settleFree(): void {
    for (const [key, resolvers] of [...this.freeWaiters]) {
      const [channel, threadTs] = key.split('\u0000');
      if (!this.free(channel, threadTs)) continue;
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
    const stamp = this.deps.store.stamp();
    if (!force && stamp === this.seenStamp) return;
    try {
      this.ledger = this.deps.store.read();
      this.seenStamp = stamp;
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
