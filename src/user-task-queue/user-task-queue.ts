/**
 * The per-user task queue (유저 작업 큐).
 *
 * A person may run `limitFor(user)` tasks at once — a task is a thread whose turn is running (or whose goal loop is
 * about to run the next one). A non-admin may run 1, an admin has no limit, and an admin may set any person's number
 * (dashboard settings, 작업 큐 tab). A message that would start a turn in another thread while the person is at the
 * limit does not start it: it waits in the person's queue, and the host starts it on its own when a running task ends.
 *
 * What passes the gate:
 * - a replay that carries its admission (`takeAdmission` already took it);
 * - a host continuation of a task that already runs (goal loop, auto-resume, a host wake) — it is not a new task;
 * - anything while the person is under the limit and has nothing waiting (no jumping the line).
 *
 * A thread that has an entry waiting holds everything sent to it: a goal continuation is dropped (the waiting entry
 * carries the task on), anything else waits behind it.
 *
 * 먼저 진행 (bypass): the person lets a waiting task go first. If no slot is free, the task that started last is
 * stopped and put first in line (`resume`), and the waiting task starts now; the stopped one carries on when it ends.
 *
 * No Slack, no session registry, no timers in here: every effect is injected (`UserTaskQueueDeps`). The gate and the
 * admission are synchronous on purpose — they run inside the ingress fence, where an `await` would let two messages
 * in the same tick both start.
 */
import { randomUUID } from 'node:crypto';
import {
  admittedOf,
  append,
  emptyLedger,
  findEntry,
  positionOf,
  putFirst,
  recoverAfterRestart,
  remove,
  type UserTaskEntry,
  type UserTaskLedger,
  type UserTaskThread,
  update,
  waitingForSession,
  waitingOf,
} from './ledger';

/** No limit (an admin). */
export const UNLIMITED = Number.POSITIVE_INFINITY;
/** A non-admin runs this many tasks at once unless an admin set otherwise. */
export const DEFAULT_TASK_LIMIT = 1;
/** An admission whose turn never arrived (the replay was lost) stops holding its place after this long. */
export const ADMISSION_TTL_MS = 2 * 60_000;
/** The preview of a request is cut to this many characters. */
export const PREVIEW_MAX = 120;

/** A task of the person that runs right now. */
export interface RunningTask extends UserTaskThread {
  title?: string;
  /** When its current turn (or chain) started — the newest one is stopped first by 먼저 진행. */
  startedAt?: number;
  /**
   * Why 먼저 진행 must not stop it (a deploy or QA lane it holds, an environment hand-off it waits on): stopping it
   * halfway could leave a deploy half done. Never picked as the task to stop.
   */
  guard?: string;
}

export interface GateInput extends UserTaskThread {
  /** The task's owner. */
  userId: string;
  text?: string;
  /** The message as it arrived (JSON) — replayed when its turn comes. */
  message: Record<string, unknown>;
  /**
   * `none` — a person's request (or a scheduled one): a new task.
   * `pass` — a host continuation of a task that already runs (a host wake, auto-resume, a compact replay).
   * `drop` — a goal continuation: passes like `pass`, but is dropped when its thread waits in line.
   * (A scheduled fire whose job already has a fire waiting is dropped as well.)
   */
  continuation: 'none' | 'pass' | 'drop';
  /** The message carried an admission that `takeAdmission` took. */
  admitted: boolean;
  /**
   * A host event that reserved its slot before it was sent (`reserveHostTurn` — pr-watch): it runs on that
   * reservation, taken once. Without one (it expired) it is gated like any other message.
   */
  hostReserved?: boolean;
}

export type GateResult =
  | { action: 'run' }
  | { action: 'drop' }
  | { action: 'queued'; entry: UserTaskEntry; position: number; limit: number; running: RunningTask[] };

export interface QueuedNoticeContext {
  position: number;
  limit: number;
  running: RunningTask[];
  /** The person's entry right ahead of this one (from the second place on): what starts before it. */
  ahead?: UserTaskEntry;
}

/** The Slack side of the queue. Every call is fire-and-forget: a notice that fails never touches the queue. */
export interface UserTaskQueueNotifier {
  /** The entry joined the line (a person's request, not a host continuation's). */
  queued(entry: UserTaskEntry, ctx: QueuedNoticeContext): void;
  /** Its turn came: `turn` — a running task ended; `bypass` — the person let it go first. */
  started(entry: UserTaskEntry, how: 'turn' | 'bypass'): void;
  /** It left the line: `person` — 대기 취소; `closed` — its thread's session was closed. */
  cancelled(entry: UserTaskEntry, why?: 'person' | 'closed'): void;
  /** `victim` was stopped so `first` could go first; it carries on after. */
  deferred(victim: RunningTask, first: UserTaskEntry): void;
}

export interface UserTaskQueueDeps {
  store: { load(): UserTaskLedger | undefined; save(ledger: UserTaskLedger): void };
  /** How many tasks the person may run at once ({@link UNLIMITED} = no limit). */
  limitFor(userId: string): number;
  /** The person's tasks that run right now. */
  runningTasks(userId: string): RunningTask[];
  /**
   * Start an admitted entry: replay its request, or carry the stopped task on (`resume`). Runs the ingress fence
   * synchronously; a throw means it could not start (the entry is dropped).
   */
  start(entry: UserTaskEntry): void;
  /**
   * Stop a running task's turn so another may go first: `stopped` — it stopped (or nothing of it runs now: a goal loop
   * between turns, whose next turn the gate holds); `pending` — its turn is still starting and the stop lands later
   * (the host calls `stopResolved`); `gone` — it already ended.
   */
  interrupt(task: RunningTask): StopOutcome;
  notify?: UserTaskQueueNotifier;
  /** The queue changed (the dashboard repaints). */
  onChange?(): void;
  now?(): number;
  newId?(): string;
}

export interface WaitingView {
  id: string;
  kind: UserTaskEntry['kind'];
  sessionKey: string;
  channel: string;
  threadTs: string;
  preview: string;
  position: number;
  enqueuedAt: number;
  state: UserTaskEntry['state'];
}

export interface UserQueueView {
  userId: string;
  /** `null` = no limit. */
  limit: number | null;
  running: RunningTask[];
  waiting: WaitingView[];
}

/** What the ingress needs of the queue (`SlackHandler.handleMessage`). */
export type UserTaskGatePort = Pick<UserTaskQueue, 'gate' | 'takeAdmission' | 'dropSession'>;

export type StopOutcome = 'stopped' | 'pending' | 'gone';

export type QueueActionResult =
  | { ok: true; deferred?: RunningTask; pending?: boolean }
  | { ok: false; reason: Exclude<QueueActionRefusal, 'protected'> }
  | { ok: false; reason: 'protected'; guard: string };
/** `protected` — every task that runs holds a deploy/QA lane or an environment hand-off: none may be stopped. */
export type QueueActionRefusal = 'not-found' | 'not-waiting' | 'forbidden' | 'protected';

/** The cron job behind a scheduled fire (`MessageEvent.cron`), if the message is one. */
function cronJobOf(message: Record<string, unknown> | undefined): string | undefined {
  const cron = message?.cron as { jobId?: unknown } | undefined;
  return typeof cron?.jobId === 'string' && cron.jobId ? cron.jobId : undefined;
}

function previewOf(text: string | undefined): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= PREVIEW_MAX) return flat;
  return `${flat.slice(0, PREVIEW_MAX - 1)}…`;
}

export class UserTaskQueue {
  private ledger: UserTaskLedger;
  /** Stops 먼저 진행 asked for whose turn was still starting, by the stopped thread (in memory: a restart ends them). */
  private readonly pendingStops = new Map<string, { victim: RunningTask; firstId: string; resumeId: string }>();
  /** Slots host events reserved on their way to the gate (in memory: a restart drops them, as it drops the events). */
  private readonly hostReservations = new Map<string, { userId: string; at: number }>();
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly deps: UserTaskQueueDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => `utq_${randomUUID().slice(0, 8)}`);
    this.ledger = recoverAfterRestart(deps.store.load() ?? emptyLedger());
  }

  /** Decide, synchronously, whether a message may start its turn now. */
  gate(input: GateInput): GateResult {
    if (input.admitted) return { action: 'run' };
    if (input.hostReserved) {
      this.expireAdmissions();
      if (this.hostReservations.get(input.sessionKey)?.userId === input.userId) {
        this.hostReservations.delete(input.sessionKey);
        return { action: 'run' };
      }
    }
    const limit = this.deps.limitFor(input.userId);
    if (limit === UNLIMITED) return { action: 'run' };

    // The thread already waits in line: what is sent to it waits too (a goal continuation is dropped — the waiting
    // entry carries the task on).
    if (waitingForSession(this.ledger, input.sessionKey)) {
      if (input.continuation === 'drop') return { action: 'drop' };
      return this.enqueue(
        input,
        limit,
        this.othersRunning(input.userId, input.sessionKey),
        input.continuation === 'none',
      );
    }
    if (input.continuation !== 'none') return { action: 'run' };
    // A scheduled job whose last fire still waits: this fire would only line up behind it (a frequent job of a person
    // at their limit would fill the line). It is dropped; the waiting fire runs.
    const cronJob = cronJobOf(input.message);
    if (cronJob && waitingOf(this.ledger, input.userId).some((e) => cronJobOf(e.message) === cronJob)) {
      return { action: 'drop' };
    }

    const running = this.othersRunning(input.userId, input.sessionKey);
    const holding = running.length + this.admittedElsewhere(input.userId, input.sessionKey);
    if (holding < limit && waitingOf(this.ledger, input.userId).length === 0) return { action: 'run' };
    return this.enqueue(input, limit, running, true);
  }

  /**
   * The replay of an admitted entry arrived: take its admission (once). `false` for an id that is not admitted, or
   * not for this thread — a made-up id admits nothing.
   */
  takeAdmission(entryId: string, sessionKey: string): boolean {
    const entry = findEntry(this.ledger, entryId);
    if (!entry || entry.state !== 'admitted' || entry.sessionKey !== sessionKey) return false;
    this.commit(remove(this.ledger, entryId));
    return true;
  }

  /** Start what may start: for one person, or for everyone who waits. */
  release(userId?: string): void {
    this.expireAdmissions();
    for (const user of userId ? [userId] : this.usersWaiting()) this.releaseUser(user);
  }

  /** 먼저 진행: let a waiting entry go first. */
  bypass(entryId: string, by: string, opts: { admin?: boolean } = {}): QueueActionResult {
    const entry = findEntry(this.ledger, entryId);
    if (!entry) return { ok: false, reason: 'not-found' };
    if (entry.userId !== by && !opts.admin) return { ok: false, reason: 'forbidden' };
    if (entry.state !== 'waiting') return { ok: false, reason: 'not-waiting' };

    this.expireAdmissions();
    const limit = this.deps.limitFor(entry.userId);
    const running = this.othersRunning(entry.userId, entry.sessionKey);
    const holding = running.length + this.admittedElsewhere(entry.userId, entry.sessionKey);
    if (holding < limit) {
      this.admitAndStart(entry, 'bypass', true);
      return { ok: true };
    }

    // A task holding a deploy/QA lane (or waiting on an environment hand-off) is never stopped halfway.
    const victim = running.filter((t) => !t.guard).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
    if (running.length > 0 && !victim) return { ok: false, reason: 'protected', guard: running[0].guard as string };
    if (!victim) {
      // Over the limit only by admissions on their way: go first in line, the next release starts it.
      this.commit(putFirst(this.ledger, entry));
      return { ok: true };
    }
    const resume: UserTaskEntry = {
      id: this.newId(),
      userId: entry.userId,
      kind: 'resume',
      sessionKey: victim.sessionKey,
      channel: victim.channel,
      threadTs: victim.threadTs,
      preview: previewOf(victim.title),
      enqueuedAt: this.now(),
      state: 'waiting',
      deferredFor: { sessionKey: entry.sessionKey, channel: entry.channel, threadTs: entry.threadTs },
    };
    const stop = this.deps.interrupt(victim);
    if (stop === 'gone') {
      // It ended meanwhile: the slot is free, nothing to stop or carry on.
      this.admitAndStart(entry, 'bypass', true);
      return { ok: true };
    }
    if (stop === 'pending') {
      // Its turn is still starting (no stop handle yet): this entry goes first in line and starts once the stop lands
      // and the slot frees — never beside it (`stopResolved`).
      const first: UserTaskEntry = { ...entry, bypass: true };
      this.commit(putFirst(this.ledger, first, resume));
      this.pendingStops.set(victim.sessionKey, { victim, firstId: first.id, resumeId: resume.id });
      return { ok: true, deferred: victim, pending: true };
    }
    const admitted: UserTaskEntry = { ...entry, state: 'admitted', admittedAt: this.now() };
    this.commit(putFirst(this.ledger, admitted, resume));
    this.safe(() => this.deps.notify?.deferred(victim, admitted));
    this.startAdmitted(admitted, 'bypass');
    return { ok: true, deferred: victim };
  }

  /**
   * A stop 먼저 진행 asked for on a running turn is settled: `landed` — the turn was stopped (its thread is told, it
   * carries on later); otherwise it ended by itself, or could not be stopped in time — it was never paused, so it is
   * not carried on. `freed` — the turn let go of its slot: the entry that goes first takes it now. Otherwise (a
   * teardown that never finished in time) the entry stays first in line for the next release.
   */
  stopResolved(sessionKey: string, landed: boolean, freed = true): void {
    const pending = this.pendingStops.get(sessionKey);
    if (!pending) return;
    this.pendingStops.delete(sessionKey);
    const first = findEntry(this.ledger, pending.firstId);
    if (landed) {
      if (first) this.safe(() => this.deps.notify?.deferred(pending.victim, first));
    } else if (findEntry(this.ledger, pending.resumeId)?.state === 'waiting') {
      this.commit(remove(this.ledger, pending.resumeId));
    }
    // The stopped task let go of its slot (it took the stop, or ended first): that slot is the entry's that went
    // first — it starts now, whatever else the person still runs (an admin may have lowered the limit meanwhile).
    if (freed && first?.state === 'waiting') {
      this.admitAndStart(first, 'bypass', true);
      return;
    }
    this.release(this.ownerOf(pending));
  }

  /** Take a waiting entry out of line. */
  cancel(entryId: string, by: string, opts: { admin?: boolean } = {}): QueueActionResult {
    const entry = findEntry(this.ledger, entryId);
    if (!entry) return { ok: false, reason: 'not-found' };
    if (entry.userId !== by && !opts.admin) return { ok: false, reason: 'forbidden' };
    if (entry.state !== 'waiting') return { ok: false, reason: 'not-waiting' };
    this.commit(remove(this.ledger, entryId));
    this.safe(() => this.deps.notify?.cancelled(entry, 'person'));
    this.release(entry.userId);
    return { ok: true };
  }

  /**
   * The thread's session was closed: what of it waits leaves the line (replaying it would bring the closed work back —
   * a shared dev host, 2026-11-24, a CI message for a merged PR started a new session in the thread its owner had closed).
   * Returns how many entries left. Never throws into the caller's teardown.
   */
  dropSession(sessionKey: string): number {
    const gone = this.ledger.entries.filter((e) => e.sessionKey === sessionKey && e.state === 'waiting');
    if (gone.length === 0) return 0;
    let next = this.ledger;
    for (const e of gone) next = remove(next, e.id);
    this.commit(next);
    for (const e of gone) this.safe(() => this.deps.notify?.cancelled(e, 'closed'));
    for (const user of new Set(gone.map((e) => e.userId))) this.release(user);
    return gone.length;
  }

  /**
   * A host event of the person's (a pr-watch CI or review message) may start now: they are under their limit and
   * nothing of theirs waits (their requests go first). The thread itself does not count against its own event.
   */
  hasFreeSlot(userId: string, sessionKey: string): boolean {
    this.expireAdmissions();
    const limit = this.deps.limitFor(userId);
    if (limit === UNLIMITED) return true;
    if (waitingOf(this.ledger, userId).some((e) => e.sessionKey !== sessionKey)) return false;
    const holding = this.othersRunning(userId, sessionKey).length + this.admittedElsewhere(userId, sessionKey);
    return holding < limit;
  }

  /**
   * Hold a free slot for a host event about to be sent (pr-watch): between its send and its gate another request, or
   * a second host event, must not take the same slot. False when there is none (`hasFreeSlot`). The event's gate takes
   * it (`hostReserved`); one never taken expires with the admissions.
   */
  reserveHostTurn(userId: string, sessionKey: string): boolean {
    if (!this.hasFreeSlot(userId, sessionKey)) return false;
    if (this.deps.limitFor(userId) !== UNLIMITED) this.hostReservations.set(sessionKey, { userId, at: this.now() });
    return true;
  }

  /** Remember where the entry's Slack notice is (to rewrite it later). */
  setNotice(entryId: string, notice: { channel: string; ts: string }): void {
    if (!findEntry(this.ledger, entryId)) return;
    this.commit(update(this.ledger, entryId, { notice }));
  }

  /** The thread's waiting entry, if it waits in line. */
  waitingEntryFor(sessionKey: string): UserTaskEntry | undefined {
    return waitingForSession(this.ledger, sessionKey);
  }

  entry(entryId: string): UserTaskEntry | undefined {
    return findEntry(this.ledger, entryId);
  }

  /** Everyone who has an entry in line. */
  usersWaiting(): string[] {
    return [...new Set(this.ledger.entries.filter((e) => e.state === 'waiting').map((e) => e.userId))];
  }

  /** One person's queue: the limit, what runs, what waits (in order). */
  viewFor(userId: string): UserQueueView {
    const limit = this.deps.limitFor(userId);
    return {
      userId,
      limit: limit === UNLIMITED ? null : limit,
      running: this.deps.runningTasks(userId),
      waiting: this.ledger.entries
        .filter((e) => e.userId === userId)
        .map((e) => ({
          id: e.id,
          kind: e.kind,
          sessionKey: e.sessionKey,
          channel: e.channel,
          threadTs: e.threadTs,
          preview: e.preview,
          position: positionOf(this.ledger, e.id),
          enqueuedAt: e.enqueuedAt,
          state: e.state,
        })),
    };
  }

  snapshot(): UserTaskLedger {
    return structuredClone(this.ledger);
  }

  private enqueue(input: GateInput, limit: number, running: RunningTask[], announce: boolean): GateResult {
    const entry: UserTaskEntry = {
      id: this.newId(),
      userId: input.userId,
      kind: 'request',
      sessionKey: input.sessionKey,
      channel: input.channel,
      threadTs: input.threadTs,
      preview: previewOf(input.text),
      enqueuedAt: this.now(),
      state: 'waiting',
      message: JSON.parse(JSON.stringify(input.message)) as Record<string, unknown>,
    };
    this.commit(append(this.ledger, entry));
    const position = positionOf(this.ledger, entry.id);
    const line = waitingOf(this.ledger, input.userId);
    const ahead = position > 1 ? line[position - 2] : undefined;
    if (announce) this.safe(() => this.deps.notify?.queued(entry, { position, limit, running, ahead }));
    return { action: 'queued', entry, position, limit, running };
  }

  private releaseUser(userId: string): void {
    const limit = this.deps.limitFor(userId);
    // Bounded: every pass admits or drops one entry.
    for (let guard = 0; guard < 1000; guard++) {
      const next = waitingOf(this.ledger, userId)[0];
      if (!next) return;
      if (limit !== UNLIMITED) {
        const running = this.othersRunning(userId, next.sessionKey);
        const holding = running.length + admittedOf(this.ledger, userId).length;
        // The next entry's own thread still running (a turn of it went on): wait for it too.
        const ownBusy = this.deps.runningTasks(userId).some((t) => t.sessionKey === next.sessionKey);
        if (holding >= limit || ownBusy) return;
      }
      this.admitAndStart(next, next.bypass ? 'bypass' : 'turn', false);
    }
  }

  private admitAndStart(entry: UserTaskEntry, how: 'turn' | 'bypass', first: boolean): void {
    const admitted: UserTaskEntry = { ...entry, state: 'admitted', admittedAt: this.now() };
    const next = update(this.ledger, entry.id, admitted);
    this.commit(first ? putFirst(next, admitted) : next);
    this.startAdmitted(admitted, how);
  }

  private startAdmitted(entry: UserTaskEntry, how: 'turn' | 'bypass'): void {
    this.safe(() => this.deps.notify?.started(entry, how));
    try {
      this.deps.start(entry);
    } catch {
      // It cannot start (its thread is gone): it leaves the line, the next one may go.
      if (findEntry(this.ledger, entry.id)) this.commit(remove(this.ledger, entry.id));
    }
  }

  private ownerOf(pending: { firstId: string; resumeId: string }): string | undefined {
    return (findEntry(this.ledger, pending.firstId) ?? findEntry(this.ledger, pending.resumeId))?.userId;
  }

  private othersRunning(userId: string, sessionKey: string): RunningTask[] {
    return this.deps.runningTasks(userId).filter((t) => t.sessionKey !== sessionKey);
  }

  private admittedElsewhere(userId: string, sessionKey: string): number {
    let reserved = 0;
    for (const [key, r] of this.hostReservations) if (r.userId === userId && key !== sessionKey) reserved++;
    return admittedOf(this.ledger, userId).filter((e) => e.sessionKey !== sessionKey).length + reserved;
  }

  private expireAdmissions(): void {
    const cutoff = this.now() - ADMISSION_TTL_MS;
    for (const [key, r] of this.hostReservations) if (r.at < cutoff) this.hostReservations.delete(key);
    const stale = this.ledger.entries.filter((e) => e.state === 'admitted' && (e.admittedAt ?? 0) < cutoff);
    if (stale.length === 0) return;
    let next = this.ledger;
    for (const e of stale) next = remove(next, e.id);
    this.commit(next);
  }

  private commit(next: UserTaskLedger): void {
    this.deps.store.save(next);
    this.ledger = next;
    this.safe(() => this.deps.onChange?.());
  }

  private safe(fn: () => void): void {
    try {
      fn();
    } catch {
      // A notice or a repaint never touches the queue.
    }
  }
}
