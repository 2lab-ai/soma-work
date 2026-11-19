/**
 * The work-queue ledger (.prd/36, .prd/37 §2) — who runs in which queue, who waits, what ended. Pure: every function
 * takes the ledger and `now` and returns a new ledger (the same object when nothing changed), so the MCP process and
 * the host apply the same rules inside one transaction ({@link WorkQueueStore.mutate}).
 *
 * Rules:
 * - An entry carries keys (Jira / GitHub, `keys.ts`). A key already running or waiting in the same queue refuses the
 *   whole entry, naming who holds it: the newcomer drops it and enters again, or stops when every key is taken.
 * - One thread holds at most one entry per queue.
 * - One entry runs per queue. When it ends (done, cancelled, released by the host) the oldest waiting entry of that
 *   queue runs at once — in the same change, so two entries never run together. A promoted entry has no `notifiedAt`
 *   yet: the host wakes its thread and stamps it ({@link markNotified}). An entry that runs from the moment it entered
 *   is stamped then (its own tool answer told the model).
 */
import { normalizeQueueId, type WorkQueueDef } from './config';
import { parseWorkKeys, WORK_KEYS_MAX } from './keys';

export interface WorkQueueHolder {
  user: string;
  channel: string;
  threadTs: string;
}

export type WorkQueueState = 'running' | 'queued';
export type WorkQueueEnd = 'done' | 'cancelled' | 'released';

export interface WorkQueueEntry {
  /** `wq-<seq>`. */
  id: string;
  queue: string;
  keys: string[];
  holder: WorkQueueHolder;
  note?: string;
  state: WorkQueueState;
  enteredAt: number;
  /** When it started running. */
  grantedAt?: number;
  /** When its thread learned it runs: its own enter answer, or the host's wake. */
  notifiedAt?: number;
}

export interface WorkQueueEnded extends WorkQueueEntry {
  endedAt: number;
  end: WorkQueueEnd;
  reason?: string;
}

export interface WorkQueueLedger {
  version: 1;
  seq: number;
  entries: WorkQueueEntry[];
  /** The most recent ended entries, oldest first ({@link ENDED_KEEP}). */
  ended: WorkQueueEnded[];
}

/** Ended entries kept for `queue_list` and for "already ended" answers. */
export const ENDED_KEEP = 50;

/** A note longer than this is cut. */
const NOTE_MAX = 300;

export function emptyLedger(): WorkQueueLedger {
  return { version: 1, seq: 0, entries: [], ended: [] };
}

function isHolder(h: unknown): h is WorkQueueHolder {
  const x = h as WorkQueueHolder | null;
  return !!x && typeof x === 'object' && typeof x.channel === 'string' && typeof x.threadTs === 'string';
}

function isEntry(e: unknown): e is WorkQueueEntry {
  const x = e as WorkQueueEntry | null;
  return (
    !!x &&
    typeof x === 'object' &&
    typeof x.id === 'string' &&
    typeof x.queue === 'string' &&
    Array.isArray(x.keys) &&
    x.keys.every((k) => typeof k === 'string') &&
    isHolder(x.holder) &&
    (x.state === 'running' || x.state === 'queued') &&
    Number.isFinite(x.enteredAt)
  );
}

/** The ledger shape this module writes, record by record; anything else is a broken file. */
export function isWorkQueueLedger(value: unknown): value is WorkQueueLedger {
  const v = value as WorkQueueLedger | null;
  return (
    !!v &&
    typeof v === 'object' &&
    v.version === 1 &&
    Number.isInteger(v.seq) &&
    Array.isArray(v.entries) &&
    v.entries.every(isEntry) &&
    Array.isArray(v.ended) &&
    v.ended.every((e) => isEntry(e) && Number.isFinite((e as WorkQueueEnded).endedAt))
  );
}

export function sameHolder(a: Pick<WorkQueueHolder, 'channel' | 'threadTs'>, b: WorkQueueHolder): boolean {
  return a.channel === b.channel && a.threadTs === b.threadTs;
}

/** A short view of an entry for answers (who, what, where). */
export interface WorkQueueEntryBrief {
  id: string;
  queue: string;
  state: WorkQueueState;
  keys: string[];
  holder: WorkQueueHolder;
  since: number;
}

export function briefOf(e: WorkQueueEntry): WorkQueueEntryBrief {
  return {
    id: e.id,
    queue: e.queue,
    state: e.state,
    keys: [...e.keys],
    holder: { ...e.holder },
    since: e.grantedAt ?? e.enteredAt,
  };
}

export interface WorkQueueConflict {
  key: string;
  entry: string;
  state: WorkQueueState;
  holder: WorkQueueHolder;
}

export type EnterError =
  | { ok: false; code: 'UNKNOWN_QUEUE'; message: string; queues: string[] }
  | { ok: false; code: 'NO_KEYS'; message: string }
  | { ok: false; code: 'INVALID_KEYS'; message: string; invalid: string[] }
  | { ok: false; code: 'TOO_MANY_KEYS'; message: string }
  | { ok: false; code: 'ALREADY_IN_QUEUE'; message: string; entry: WorkQueueEntryBrief }
  | { ok: false; code: 'CONFLICT'; message: string; conflicts: WorkQueueConflict[] };

export type EnterResult =
  | {
      ok: true;
      entry: WorkQueueEntry;
      /** 0 = it runs now; n = n-th of the waiting entries of its queue. */
      position: number;
      /** What runs or waits before it, in order. */
      ahead: WorkQueueEntryBrief[];
    }
  | EnterError;

export interface EnterRequest {
  queue: string;
  keys: unknown;
  holder: WorkQueueHolder;
  note?: unknown;
}

function inQueue(ledger: WorkQueueLedger, queue: string): WorkQueueEntry[] {
  return ledger.entries.filter((e) => e.queue === queue);
}

/** 0 for the running entry; n for the n-th waiting entry of its queue (arrival order). */
export function queuePosition(ledger: WorkQueueLedger, entry: WorkQueueEntry): number {
  if (entry.state === 'running') return 0;
  return (
    inQueue(ledger, entry.queue)
      .filter((e) => e.state === 'queued')
      .findIndex((e) => e.id === entry.id) + 1
  );
}

export function entriesOfHolder(
  ledger: WorkQueueLedger,
  holder: Pick<WorkQueueHolder, 'channel' | 'threadTs'>,
): WorkQueueEntry[] {
  return ledger.entries.filter((e) => sameHolder(holder, e.holder));
}

export function enterQueue(
  ledger: WorkQueueLedger,
  req: EnterRequest,
  queues: readonly WorkQueueDef[],
  now: number,
): { ledger: WorkQueueLedger; result: EnterResult } {
  const refuse = (result: EnterError) => ({ ledger, result });
  req = { ...req, queue: normalizeQueueId(String(req.queue ?? '')) };
  if (!queues.some((q) => q.id === req.queue)) {
    const names = queues.map((q) => q.id);
    return refuse({
      ok: false,
      code: 'UNKNOWN_QUEUE',
      message: names.length
        ? `No queue "${req.queue}" on this host. Queues: ${names.join(', ')}.`
        : 'This host has no work queues.',
      queues: names,
    });
  }
  const { keys, invalid } = parseWorkKeys(req.keys);
  if (invalid.length > 0) {
    return refuse({
      ok: false,
      code: 'INVALID_KEYS',
      message: `Not a Jira key (ABC-1234) or a GitHub key (owner/repo#123): ${invalid.join(', ')}.`,
      invalid,
    });
  }
  if (keys.length === 0) {
    return refuse({ ok: false, code: 'NO_KEYS', message: 'Name the work: at least one Jira or GitHub key.' });
  }
  if (keys.length > WORK_KEYS_MAX) {
    return refuse({ ok: false, code: 'TOO_MANY_KEYS', message: `At most ${WORK_KEYS_MAX} keys per entry.` });
  }
  const live = inQueue(ledger, req.queue);
  const mine = live.find((e) => sameHolder(req.holder, e.holder));
  if (mine) {
    return refuse({
      ok: false,
      code: 'ALREADY_IN_QUEUE',
      message: `This thread already holds ${mine.id} in ${req.queue} (${mine.state}). Finish or cancel it first.`,
      entry: briefOf(mine),
    });
  }
  const conflicts: WorkQueueConflict[] = [];
  for (const key of keys) {
    const owner = live.find((e) => e.keys.includes(key));
    if (owner) conflicts.push({ key, entry: owner.id, state: owner.state, holder: { ...owner.holder } });
  }
  if (conflicts.length > 0) {
    return refuse({
      ok: false,
      code: 'CONFLICT',
      message:
        `Already in ${req.queue}: ${conflicts.map((c) => `${c.key} (${c.entry}, ${c.state})`).join(', ')}. ` +
        'Someone else does that work — drop those keys and enter again with the rest; if none is left, the work is not needed.',
      conflicts,
    });
  }
  const seq = ledger.seq + 1;
  const runs = !live.some((e) => e.state === 'running');
  const note = typeof req.note === 'string' && req.note.trim() ? req.note.trim().slice(0, NOTE_MAX) : undefined;
  const entry: WorkQueueEntry = {
    id: `wq-${seq}`,
    queue: req.queue,
    keys,
    holder: { user: req.holder.user, channel: req.holder.channel, threadTs: req.holder.threadTs },
    ...(note ? { note } : {}),
    state: runs ? 'running' : 'queued',
    enteredAt: now,
    ...(runs ? { grantedAt: now, notifiedAt: now } : {}),
  };
  const next: WorkQueueLedger = { ...ledger, seq, entries: [...ledger.entries, entry] };
  return {
    ledger: next,
    result: { ok: true, entry, position: queuePosition(next, entry), ahead: live.map(briefOf) },
  };
}

/** Run the oldest waiting entry of `queue` when none runs. Mutates `entries` (a copy owned by the caller). */
function promote(entries: WorkQueueEntry[], queue: string, now: number): WorkQueueEntry | undefined {
  if (entries.some((e) => e.queue === queue && e.state === 'running')) return undefined;
  const at = entries.findIndex((e) => e.queue === queue && e.state === 'queued');
  if (at < 0) return undefined;
  const granted: WorkQueueEntry = { ...entries[at], state: 'running', grantedAt: now };
  entries[at] = granted;
  return granted;
}

export type EndResult =
  | { ok: true; ended: WorkQueueEnded; granted?: WorkQueueEntry }
  | { ok: false; code: 'UNKNOWN_ENTRY'; message: string }
  | { ok: false; code: 'NOT_HOLDER'; message: string }
  | { ok: false; code: 'ALREADY_ENDED'; message: string; ended: WorkQueueEnded };

export interface EndRequest {
  id: string;
  end: WorkQueueEnd;
  /** The thread asking (only the holder may end its entry), or the host. */
  actor: Pick<WorkQueueHolder, 'channel' | 'threadTs'> | 'host';
  reason?: string;
}

export function endEntry(
  ledger: WorkQueueLedger,
  req: EndRequest,
  now: number,
): { ledger: WorkQueueLedger; result: EndResult } {
  const at = ledger.entries.findIndex((e) => e.id === req.id);
  if (at < 0) {
    const past = [...ledger.ended].reverse().find((e) => e.id === req.id);
    if (past) {
      return {
        ledger,
        result: {
          ok: false,
          code: 'ALREADY_ENDED',
          message: `${req.id} already ended (${past.end}${past.reason ? `: ${past.reason}` : ''}).`,
          ended: past,
        },
      };
    }
    return { ledger, result: { ok: false, code: 'UNKNOWN_ENTRY', message: `No entry ${req.id}.` } };
  }
  const entry = ledger.entries[at];
  if (req.actor !== 'host' && !sameHolder(req.actor, entry.holder)) {
    return {
      ledger,
      result: { ok: false, code: 'NOT_HOLDER', message: `${req.id} belongs to another thread; only it ends it.` },
    };
  }
  const reason = typeof req.reason === 'string' && req.reason.trim() ? req.reason.trim().slice(0, NOTE_MAX) : undefined;
  const ended: WorkQueueEnded = { ...entry, endedAt: now, end: req.end, ...(reason ? { reason } : {}) };
  const entries = ledger.entries.filter((_, i) => i !== at);
  const granted = promote(entries, entry.queue, now);
  return {
    ledger: { ...ledger, entries, ended: [...ledger.ended, ended].slice(-ENDED_KEEP) },
    result: { ok: true, ended, ...(granted ? { granted } : {}) },
  };
}

/** The host's sweep: release every named entry (`released`, with its reason) and promote each queue it freed. */
export function releaseByHost(
  ledger: WorkQueueLedger,
  releases: ReadonlyArray<{ id: string; reason: string }>,
  now: number,
): { ledger: WorkQueueLedger; ended: WorkQueueEnded[]; granted: WorkQueueEntry[] } {
  let current = ledger;
  const ended: WorkQueueEnded[] = [];
  const granted: WorkQueueEntry[] = [];
  for (const r of releases) {
    const { ledger: next, result } = endEntry(
      current,
      { id: r.id, end: 'released', actor: 'host', reason: r.reason },
      now,
    );
    if (!result.ok) continue;
    current = next;
    ended.push(result.ended);
    if (result.granted) granted.push(result.granted);
  }
  // An entry granted by one release and released by a later one is not granted any more.
  const stillRunning = granted.filter((g) => current.entries.some((e) => e.id === g.id && e.state === 'running'));
  return { ledger: current, ended, granted: stillRunning };
}

/** Stamp that the holder of a running entry was told it runs. Same ledger when there is nothing to stamp. */
export function markNotified(ledger: WorkQueueLedger, id: string, now: number): WorkQueueLedger {
  const at = ledger.entries.findIndex((e) => e.id === id && e.state === 'running' && e.notifiedAt === undefined);
  if (at < 0) return ledger;
  const entries = [...ledger.entries];
  entries[at] = { ...entries[at], notifiedAt: now };
  return { ...ledger, entries };
}

export interface WorkQueueView {
  queue: string;
  lane: string;
  env: string;
  running?: WorkQueueEntryBrief;
  queued: WorkQueueEntryBrief[];
  /** Most recent first. */
  recent: Array<WorkQueueEntryBrief & { end: WorkQueueEnd; endedAt: number; reason?: string }>;
}

/** Every configured queue as `queue_list` shows it. */
export function queueViews(
  ledger: WorkQueueLedger,
  queues: readonly WorkQueueDef[],
  recentPerQueue = 5,
): WorkQueueView[] {
  return queues.map((q) => {
    const live = inQueue(ledger, q.id);
    const running = live.find((e) => e.state === 'running');
    return {
      queue: q.id,
      lane: q.lane,
      env: q.env,
      ...(running ? { running: briefOf(running) } : {}),
      queued: live.filter((e) => e.state === 'queued').map(briefOf),
      recent: ledger.ended
        .filter((e) => e.queue === q.id)
        .slice(-recentPerQueue)
        .reverse()
        .map((e) => ({ ...briefOf(e), end: e.end, endedAt: e.endedAt, ...(e.reason ? { reason: e.reason } : {}) })),
    };
  });
}
