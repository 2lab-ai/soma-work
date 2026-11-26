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
 * The same work twice (.prd/36 v2 D12, SSOT_5): a person's request names its work by keys (`keysInText`). When every
 * key already runs or waits in another thread of theirs, nothing starts: the thread is told who has it (fast-fail),
 * and 그래도 시작 sends it on once. It is the person's line on the shared line rules (`somalib/work-queue/line.ts`):
 * claims, places, and a record of what left the line.
 *
 * No Slack, no session registry, no timers in here: every effect is injected (`UserTaskQueueDeps`). The gate and the
 * admission are synchronous on purpose — they run inside the ingress fence, where an `await` would let two messages
 * in the same tick both start.
 */
import { randomUUID } from 'node:crypto';
import { keysInText, WORK_KEYS_MAX } from 'somalib/work-queue/keys';
import {
  appendRecords,
  type KeyClaim,
  type LineEntryView,
  type LineItem,
  type LineQueueView,
  type LineRecord,
  personQueueId,
  splitKeys,
} from 'somalib/work-queue/line';
import {
  admittedOf,
  append,
  emptyLedger,
  findEntry,
  lineItemOf,
  positionOf,
  putFirst,
  recordOf,
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
  /** The work keys the task registered (its requests' keys, its card's issue and PR). */
  keys?: string[];
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
  /** The person chose 그래도 시작 on a refused request: it is not checked for the same work again. */
  sameWorkOk?: boolean;
}

export type GateResult =
  | { action: 'run' }
  | { action: 'drop' }
  /** Every key it names already runs or waits in another thread of the person: nothing starts (fast-fail). */
  | { action: 'same-work'; keys: string[]; claims: KeyClaim[] }
  /** A redelivery (Slack retried an event it thinks was not acked) of a message already in line, or just gone from it. */
  | { action: 'duplicate' }
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
  /** A request for work that already runs or waits (every key claimed): tell the thread who has it. */
  refused?(thread: UserTaskThread & { userId: string }, claims: KeyClaim[], token: string): void;
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
  /** Send a message through the ingress again (그래도 시작 on a refused request). */
  resend?(message: Record<string, unknown>): void;
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

/** How long a message that left the line is remembered: past Slack's retries (seconds to minutes), with room. */
export const REDELIVERY_MEMORY_MS = 30 * 60_000;
/** How long a refused request can still be sent on (그래도 시작). In memory: a restart forgets it. */
export const SAME_WORK_HOLD_MS = 30 * 60_000;

/** A request a person sent (not a host continuation, not a scheduled fire, not a host-made message). */
function isPersonRequest(input: GateInput): boolean {
  return input.continuation === 'none' && !cronJobOf(input.message) && input.message?.synthetic !== true;
}

/** One Slack message in one thread (its `ts`); undefined for a message with no ts of its own (a host turn's). */
function messageKeyOf(sessionKey: string, message: Record<string, unknown> | undefined): string | undefined {
  const ts = message?.ts;
  return typeof ts === 'string' && ts ? `${sessionKey}|${ts}` : undefined;
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
  /** Messages that left the line (started, cancelled, closed) — a late Slack retry of one is not a new request. */
  private readonly recentlyLeft = new Map<string, number>();
  /** Requests refused as the same work, held for 그래도 시작 (by token). */
  private readonly refusedHeld = new Map<string, { userId: string; message: Record<string, unknown>; at: number }>();
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly deps: UserTaskQueueDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => `utq_${randomUUID().slice(0, 8)}`);
    const loaded = recoverAfterRestart(deps.store.load() ?? emptyLedger());
    // Copies of one message saved before redeliveries were recognised are folded into the first.
    const seen = new Set<string>();
    const folded = loaded.entries.filter((e) => {
      const key = messageKeyOf(e.sessionKey, e.message);
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    this.ledger = folded.length === loaded.entries.length ? loaded : { ...loaded, entries: folded };
    if (this.ledger !== loaded) deps.store.save(this.ledger);
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
      // Its reservation is gone (taken, or expired on the way): it runs only into a free slot. It never lines up as a
      // request — in the ledger a merged PR or a closed session could no longer take it back.
      return this.hasFreeSlot(input.userId, input.sessionKey) ? { action: 'run' } : { action: 'drop' };
    }
    // Slack resends an event it thinks was not acked in time (retry_attempt, reason timeout): the copy of a message
    // already in line — or one that just left it — is not a second request.
    const key = messageKeyOf(input.sessionKey, input.message);
    // 그래도 시작's resend is that request sent on by the host, once — not a Slack retry of it.
    if (key && !input.sameWorkOk) {
      if (this.ledger.entries.some((e) => messageKeyOf(e.sessionKey, e.message) === key))
        return { action: 'duplicate' };
      this.pruneRecentlyLeft();
      if (this.recentlyLeft.has(key)) return { action: 'duplicate' };
    }
    // The same work sent again: every key it names already runs or waits in another thread of the person.
    if (isPersonRequest(input) && !input.sameWorkOk) {
      const keys = keysInText(input.text);
      // A request naming more keys than one entry carries was cut at WORK_KEYS_MAX: the rest might be new work, so it
      // is never refused on the first ones alone.
      if (keys.length > 0 && keys.length < WORK_KEYS_MAX) {
        const { free, claimed } = splitKeys(this.liveItems(input.userId, input.sessionKey), keys);
        if (claimed.length > 0 && free.length === 0) return this.refuseSameWork(input, keys, claimed);
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
    const holding = this.holdingElsewhere(input.userId, input.sessionKey);
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
    this.rememberLeft(entry);
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
    const holding = this.holdingElsewhere(entry.userId, entry.sessionKey);
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
    const started = recordOf(entry, 'started', this.now(), { reason: 'bypass', startedAt: this.now() });
    this.commit(this.withRecords(putFirst(this.ledger, admitted, resume), started));
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
    const reason = entry.userId === by ? 'person' : 'admin';
    this.commit(this.withRecords(remove(this.ledger, entryId), recordOf(entry, 'cancelled', this.now(), { reason })));
    this.rememberLeft(entry);
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
    const now = this.now();
    this.commit(this.withRecords(next, ...gone.map((e) => recordOf(e, 'cancelled', now, { reason: 'closed' }))));
    for (const e of gone) this.rememberLeft(e);
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
    return this.holdingElsewhere(userId, sessionKey) < limit;
  }

  /** Give back a reservation whose event never reached the gate (its send failed). */
  releaseHostTurn(sessionKey: string): void {
    const held = this.hostReservations.get(sessionKey);
    if (!held) return;
    this.hostReservations.delete(sessionKey);
    // The slot it held may be a waiting request's now.
    this.release(held.userId);
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

  /**
   * One person's queue as the shared line view (.prd/36 v2) — the shape a lane has, so the board's 개인별 큐 tab and
   * the settings page draw both kinds alike: the limit, what runs (live tasks), what waits (in order), what left.
   */
  lineView(userId: string, recent = 20): LineQueueView {
    const limit = this.deps.limitFor(userId);
    const running: LineEntryView[] = this.deps.runningTasks(userId).map((t) => ({
      id: `run:${t.sessionKey}`,
      keys: [...(t.keys ?? [])],
      holder: { user: userId, channel: t.channel, threadTs: t.threadTs },
      state: 'running',
      position: 0,
      enteredAt: t.startedAt ?? 0,
      ...(t.startedAt !== undefined ? { startedAt: t.startedAt } : {}),
      ...(t.title ? { label: t.title } : {}),
    }));
    const mine = this.ledger.entries.filter((e) => e.userId === userId);
    const id = personQueueId(userId);
    return {
      id,
      kind: 'person',
      capacity: limit === UNLIMITED ? null : limit,
      running: [
        ...running,
        ...mine
          .filter((e) => e.state === 'admitted')
          .map((e) => ({ ...this.entryView(e), state: 'running' as const, position: 0 })),
      ],
      waiting: mine.filter((e) => e.state === 'waiting').map((e) => this.entryView(e)),
      recent: (this.ledger.records ?? [])
        .filter((r) => r.queue === id)
        .slice(-recent)
        .reverse(),
    };
  }

  /** 그래도 시작: send a request refused as the same work on, once — gated again, minus the same-work check. */
  startSameWork(
    token: string,
    by: string,
    opts: { admin?: boolean } = {},
  ): { ok: true } | { ok: false; reason: 'not-found' | 'forbidden' } {
    this.pruneRefused();
    const held = this.refusedHeld.get(token);
    if (!held) return { ok: false, reason: 'not-found' };
    if (held.userId !== by && !opts.admin) return { ok: false, reason: 'forbidden' };
    this.refusedHeld.delete(token);
    // The resend carries the host's own flag past the redelivery check (`gate`); the original's late Slack retries
    // stay duplicates (review 2026-11-26: deleting the memory let a retry run the instruction a second time).
    const route = (held.message.routeContext as Record<string, unknown> | undefined) ?? {};
    this.deps.resend?.({ ...held.message, routeContext: { ...route, userTaskSameWorkOk: true } });
    return { ok: true };
  }

  snapshot(): UserTaskLedger {
    return structuredClone(this.ledger);
  }

  private entryView(e: UserTaskEntry): LineEntryView {
    return {
      id: e.id,
      keys: [...(e.keys ?? [])],
      holder: { user: e.userId, channel: e.channel, threadTs: e.threadTs },
      state: e.state === 'waiting' ? 'waiting' : 'running',
      position: positionOf(this.ledger, e.id),
      enteredAt: e.enqueuedAt,
      ...(e.preview ? { label: e.preview } : {}),
    };
  }

  /** What of the person runs or waits in threads other than `sessionKey`, as the shared line sees it. */
  private liveItems(userId: string, sessionKey: string): LineItem[] {
    const running: LineItem[] = this.othersRunning(userId, sessionKey).map((t) => ({
      id: `run:${t.sessionKey}`,
      keys: t.keys ?? [],
      state: 'running',
      holder: { user: userId, channel: t.channel, threadTs: t.threadTs },
      enteredAt: t.startedAt ?? 0,
    }));
    const lined = this.ledger.entries.filter((e) => e.userId === userId && e.sessionKey !== sessionKey).map(lineItemOf);
    return [...running, ...lined];
  }

  private refuseSameWork(input: GateInput, keys: string[], claims: KeyClaim[]): GateResult {
    const token = this.newId();
    this.pruneRefused();
    this.refusedHeld.set(token, {
      userId: input.userId,
      message: JSON.parse(JSON.stringify(input.message)) as Record<string, unknown>,
      at: this.now(),
    });
    const now = this.now();
    const record: LineRecord = {
      id: token,
      queue: personQueueId(input.userId),
      keys,
      holder: { user: input.userId, channel: input.channel, threadTs: input.threadTs },
      ...(input.text ? { label: previewOf(input.text) } : {}),
      enteredAt: now,
      endedAt: now,
      end: 'refused',
      // Never another thread's id: a private thread stays unnamed in the history.
      reason:
        claims.length === 1
          ? 'its key already runs or waits in another thread'
          : `its ${claims.length} keys already run or wait in other threads`,
    };
    this.commit(this.withRecords(this.ledger, record));
    // A late Slack retry of the refused message is not a new request either.
    const key = messageKeyOf(input.sessionKey, input.message);
    if (key) this.recentlyLeft.set(key, now);
    this.safe(() =>
      this.deps.notify?.refused?.(
        { userId: input.userId, sessionKey: input.sessionKey, channel: input.channel, threadTs: input.threadTs },
        claims,
        token,
      ),
    );
    return { action: 'same-work', keys, claims };
  }

  private pruneRefused(): void {
    const cutoff = this.now() - SAME_WORK_HOLD_MS;
    for (const [token, held] of this.refusedHeld) if (held.at < cutoff) this.refusedHeld.delete(token);
  }

  private withRecords(ledger: UserTaskLedger, ...records: LineRecord[]): UserTaskLedger {
    return { ...ledger, records: appendRecords(ledger.records ?? [], ...records) };
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
    const keys = keysInText(input.text);
    if (keys.length > 0) entry.keys = keys;
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
      const line = waitingOf(this.ledger, userId);
      let next: UserTaskEntry | undefined;
      for (const candidate of line) {
        if (limit !== UNLIMITED) {
          // Reservations of host events on their way hold their slots too.
          if (this.holdingElsewhere(userId, candidate.sessionKey) >= limit) return;
          // Its own thread still runs (a turn of it went on): it cannot start yet — the free slot goes to the next one
          // in line instead of waiting behind it (a raised limit starts what can start at once).
          if (this.deps.runningTasks(userId).some((t) => t.sessionKey === candidate.sessionKey)) continue;
        }
        next = candidate;
        break;
      }
      if (!next) return;
      this.admitAndStart(next, next.bypass ? 'bypass' : 'turn', false);
    }
  }

  /** A message that left the line (started, cancelled, closed): its late Slack retries are duplicates for a while. */
  private rememberLeft(entry: UserTaskEntry): void {
    const key = messageKeyOf(entry.sessionKey, entry.message);
    if (key) this.recentlyLeft.set(key, this.now());
  }

  private pruneRecentlyLeft(): void {
    const cutoff = this.now() - REDELIVERY_MEMORY_MS;
    for (const [key, at] of this.recentlyLeft) if (at < cutoff) this.recentlyLeft.delete(key);
  }

  private admitAndStart(entry: UserTaskEntry, how: 'turn' | 'bypass', first: boolean): void {
    const now = this.now();
    const admitted: UserTaskEntry = { ...entry, state: 'admitted', admittedAt: now };
    const next = update(this.ledger, entry.id, admitted);
    const started = recordOf(entry, 'started', now, { reason: how, startedAt: now });
    this.commit(this.withRecords(first ? putFirst(next, admitted) : next, started));
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

  /**
   * The slots the person's other threads hold: running, admitted on their way, or reserved by a host event — one per
   * thread, however many of these it is at once (a thread admitted and reserved holds one slot).
   */
  private holdingElsewhere(userId: string, sessionKey: string): number {
    const held = new Set<string>();
    for (const t of this.othersRunning(userId, sessionKey)) held.add(t.sessionKey);
    for (const e of admittedOf(this.ledger, userId)) if (e.sessionKey !== sessionKey) held.add(e.sessionKey);
    for (const [key, r] of this.hostReservations) if (r.userId === userId && key !== sessionKey) held.add(key);
    return held.size;
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
