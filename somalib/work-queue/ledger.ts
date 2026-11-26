/**
 * The lane ledger (.prd/36 v2, .prd/37 §2) — who runs in which lane, who waits, what left. Pure: every function takes
 * the ledger and `now` and returns a new ledger (the same object when nothing changed), so the MCP processes and the
 * host apply the same rules inside one transaction ({@link WorkQueueStore.mutate}).
 *
 * A lane is the one-at-a-time case of the shared line (`line.ts`), which a person's queue uses too:
 * - A lane is named by the work that uses it (`qa-dev2`) and exists from its first entry — nothing is configured first.
 * - An entry names its work by keys (`keys.ts`). A key already running or waiting in the same lane refuses the whole
 *   entry, naming who has it and which keys are still free: the newcomer drops the claimed ones and enters again, or
 *   stops when none is left.
 * - One thread holds at most one entry per lane.
 * - One entry runs per lane. When it ends (done, cancelled, released) the oldest waiting entry runs at once — in the
 *   same change, so two never run together. A promoted entry has no `notifiedAt` yet: the host wakes its thread and
 *   stamps it ({@link markNotified}). An entry that runs from the moment it entered is stamped then (its own tool
 *   answer told the model).
 * - `enter` waits for a place; `try` takes a free lane and otherwise adds nothing — it says what is ahead.
 * - Every entry that leaves leaves a record (`records`): the lane's history shows it ran one at a time.
 */
import { isQueueName, normalizeQueueName } from './config';
import { parseWorkKeys, WORK_KEYS_MAX } from './keys';
import {
  appendRecords,
  claimsOn,
  isLineHolder,
  isLineRecord,
  type KeyClaim,
  type LineEnd,
  type LineEntryView,
  type LineHolder,
  type LineQueueView,
  type LineRecord,
  type LineState,
  sameThread,
  splitKeys,
  waitingPlace,
} from './line';

export type WorkQueueHolder = LineHolder;
export type WorkQueueState = LineState;
/** How a lane entry ends (a subset of the line's ends). */
export type WorkQueueEnd = Extract<LineEnd, 'done' | 'cancelled' | 'released'>;

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

export interface WorkQueueLedger {
  version: 2;
  seq: number;
  entries: WorkQueueEntry[];
  /** What left the line, oldest first (`LINE_RECORDS_KEEP`). */
  records: LineRecord[];
}

/** A note longer than this is cut. */
const NOTE_MAX = 300;

export function emptyLedger(): WorkQueueLedger {
  return { version: 2, seq: 0, entries: [], records: [] };
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
    isLineHolder(x.holder) &&
    (x.state === 'running' || x.state === 'waiting') &&
    Number.isFinite(x.enteredAt)
  );
}

/** The v1 ledger (.prd/36 v1, 2026-11-19): `<lane>:<env>` names, `queued`, `ended` with `grantedAt`. */
function fromV1(raw: Record<string, unknown>): WorkQueueLedger {
  const { seq, entries, ended } = raw as { seq?: unknown; entries?: unknown; ended?: unknown };
  if (!Number.isInteger(seq) || !Array.isArray(entries) || !Array.isArray(ended)) {
    throw new Error('work-queues: a v1 ledger of the wrong shape');
  }
  const entry = (e: Record<string, unknown>): WorkQueueEntry => ({
    ...(e as unknown as WorkQueueEntry),
    queue: normalizeQueueName(String(e.queue ?? '')),
    state: e.state === 'queued' ? 'waiting' : (e.state as WorkQueueState),
  });
  const record = (e: Record<string, unknown>): LineRecord => {
    const r: LineRecord = {
      id: String(e.id),
      queue: normalizeQueueName(String(e.queue ?? '')),
      keys: e.keys as string[],
      holder: e.holder as LineHolder,
      ...(typeof e.note === 'string' ? { label: e.note } : {}),
      enteredAt: e.enteredAt as number,
      ...(Number.isFinite(e.grantedAt) ? { startedAt: e.grantedAt as number } : {}),
      endedAt: e.endedAt as number,
      end: e.end as LineEnd,
      ...(typeof e.reason === 'string' ? { reason: e.reason } : {}),
    };
    return r;
  };
  return {
    version: 2,
    seq: seq as number,
    entries: (entries as Record<string, unknown>[]).map(entry),
    records: (ended as Record<string, unknown>[]).map(record),
  };
}

/**
 * The stored ledger, record by record: a v2 ledger as it is, a v1 ledger (a host that ran .prd/36 v1) moved to v2.
 * Anything else throws — never an empty ledger (rules/config.md 4: an empty read would let every waiting entry vanish).
 */
export function parseWorkQueueLedger(value: unknown): WorkQueueLedger {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('work-queues: not a ledger');
  const raw = value as Record<string, unknown>;
  const ledger = raw.version === 1 ? fromV1(raw) : (raw as unknown as WorkQueueLedger);
  if (
    ledger.version !== 2 ||
    !Number.isInteger(ledger.seq) ||
    !Array.isArray(ledger.entries) ||
    !ledger.entries.every(isEntry) ||
    !Array.isArray(ledger.records) ||
    !ledger.records.every(isLineRecord)
  ) {
    throw new Error('work-queues: a ledger of the wrong shape');
  }
  return ledger;
}

export function sameHolder(a: Pick<WorkQueueHolder, 'channel' | 'threadTs'>, b: WorkQueueHolder): boolean {
  return sameThread(a, b);
}

/** A short view of an entry for answers (who, what, where). */
export interface WorkQueueEntryBrief {
  id: string;
  queue: string;
  state: WorkQueueState;
  keys: string[];
  holder: WorkQueueHolder;
  note?: string;
  since: number;
}

export function briefOf(e: WorkQueueEntry): WorkQueueEntryBrief {
  return {
    id: e.id,
    queue: e.queue,
    state: e.state,
    keys: [...e.keys],
    holder: { ...e.holder },
    ...(e.note ? { note: e.note } : {}),
    since: e.grantedAt ?? e.enteredAt,
  };
}

export type WorkQueueConflict = KeyClaim;

export type EnterError =
  | { ok: false; code: 'INVALID_QUEUE'; message: string }
  | { ok: false; code: 'NO_KEYS'; message: string }
  | { ok: false; code: 'INVALID_KEYS'; message: string; invalid: string[] }
  | { ok: false; code: 'TOO_MANY_KEYS'; message: string }
  | { ok: false; code: 'ALREADY_IN_QUEUE'; message: string; entry: WorkQueueEntryBrief }
  | { ok: false; code: 'CONFLICT'; message: string; conflicts: WorkQueueConflict[]; free: string[] };

export type EnterResult =
  | {
      ok: true;
      /** `running` — it runs now; `waiting` — it waits for its turn (enter). */
      status: WorkQueueState;
      entry: WorkQueueEntry;
      /** 0 = it runs now; n = n-th of the waiting entries of its lane. */
      position: number;
      /** What runs or waits before it, in order. */
      ahead: WorkQueueEntryBrief[];
      /** No entry or record of this lane existed before: a new lane (a misspelt name would make one too). */
      created: boolean;
    }
  | {
      ok: true;
      /** `try` on a lane in use: nothing was added. */
      status: 'busy';
      queue: string;
      /** The place it would have taken. */
      position: number;
      ahead: WorkQueueEntryBrief[];
    }
  | EnterError;

export interface EnterRequest {
  queue: string;
  keys: unknown;
  holder: WorkQueueHolder;
  note?: unknown;
  /** `wait` (default) — line up; `try` — take a free lane, otherwise add nothing. */
  mode?: 'wait' | 'try';
}

function inQueue(ledger: WorkQueueLedger, queue: string): WorkQueueEntry[] {
  return ledger.entries.filter((e) => e.queue === queue);
}

/** 0 for the running entry; n for the n-th waiting entry of its lane (line order). */
export function queuePosition(ledger: WorkQueueLedger, entry: WorkQueueEntry): number {
  return waitingPlace(inQueue(ledger, entry.queue), entry.id);
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
  now: number,
): { ledger: WorkQueueLedger; result: EnterResult } {
  const refuse = (result: EnterError) => ({ ledger, result });
  const queue = normalizeQueueName(String(req.queue ?? ''));
  if (!isQueueName(queue)) {
    return refuse({
      ok: false,
      code: 'INVALID_QUEUE',
      message: `"${String(req.queue ?? '')}" is not a lane name: lower case letters, digits and . _ - (e.g. qa-dev2).`,
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
  const live = inQueue(ledger, queue);
  const mine = live.find((e) => sameHolder(req.holder, e.holder));
  if (mine) {
    return refuse({
      ok: false,
      code: 'ALREADY_IN_QUEUE',
      message: `This thread already holds ${mine.id} in ${queue} (${mine.state}). Finish or cancel it first.`,
      entry: briefOf(mine),
    });
  }
  const { free, claimed } = splitKeys(live, keys);
  if (claimed.length > 0) {
    return refuse({
      ok: false,
      code: 'CONFLICT',
      message:
        `Already in ${queue}: ${claimed.map((c) => `${c.key} (${c.entry}, ${c.state})`).join(', ')}. ` +
        (free.length > 0
          ? `Someone else does that work — enter again with the rest: ${free.join(', ')}.`
          : 'Someone else does all of this work — it is not needed.'),
      conflicts: claimed,
      free,
    });
  }
  const runs = !live.some((e) => e.state === 'running');
  const ahead = live.map(briefOf);
  if (!runs && req.mode === 'try') {
    return {
      ledger,
      result: {
        ok: true,
        status: 'busy',
        queue,
        position: live.filter((e) => e.state === 'waiting').length + 1,
        ahead,
      },
    };
  }
  const created = live.length === 0 && !ledger.records.some((r) => r.queue === queue);
  const seq = ledger.seq + 1;
  const note = typeof req.note === 'string' && req.note.trim() ? req.note.trim().slice(0, NOTE_MAX) : undefined;
  const entry: WorkQueueEntry = {
    id: `wq-${seq}`,
    queue,
    keys,
    holder: { user: req.holder.user, channel: req.holder.channel, threadTs: req.holder.threadTs },
    ...(note ? { note } : {}),
    state: runs ? 'running' : 'waiting',
    enteredAt: now,
    ...(runs ? { grantedAt: now, notifiedAt: now } : {}),
  };
  const next: WorkQueueLedger = { ...ledger, seq, entries: [...ledger.entries, entry] };
  return {
    ledger: next,
    result: { ok: true, status: entry.state, entry, position: queuePosition(next, entry), ahead, created },
  };
}

/** Run the oldest waiting entry of `queue` when none runs. Mutates `entries` (a copy owned by the caller). */
function promote(entries: WorkQueueEntry[], queue: string, now: number): WorkQueueEntry | undefined {
  if (entries.some((e) => e.queue === queue && e.state === 'running')) return undefined;
  const at = entries.findIndex((e) => e.queue === queue && e.state === 'waiting');
  if (at < 0) return undefined;
  const granted: WorkQueueEntry = { ...entries[at], state: 'running', grantedAt: now };
  entries[at] = granted;
  return granted;
}

export type EndResult =
  | { ok: true; ended: LineRecord; entry: WorkQueueEntry; granted?: WorkQueueEntry }
  | { ok: false; code: 'UNKNOWN_ENTRY'; message: string }
  | { ok: false; code: 'NOT_HOLDER'; message: string }
  | { ok: false; code: 'ALREADY_ENDED'; message: string; ended: LineRecord };

export interface EndRequest {
  id: string;
  end: WorkQueueEnd;
  /** The thread asking (only the holder may end its entry), the host, or an admin. */
  actor: Pick<WorkQueueHolder, 'channel' | 'threadTs'> | 'host' | 'admin';
  reason?: string;
}

function recordOf(entry: WorkQueueEntry, end: WorkQueueEnd, now: number, reason?: string): LineRecord {
  return {
    id: entry.id,
    queue: entry.queue,
    keys: [...entry.keys],
    holder: { ...entry.holder },
    ...(entry.note ? { label: entry.note } : {}),
    enteredAt: entry.enteredAt,
    ...(entry.grantedAt !== undefined ? { startedAt: entry.grantedAt } : {}),
    endedAt: now,
    end,
    ...(reason ? { reason } : {}),
  };
}

export function endEntry(
  ledger: WorkQueueLedger,
  req: EndRequest,
  now: number,
): { ledger: WorkQueueLedger; result: EndResult } {
  const at = ledger.entries.findIndex((e) => e.id === req.id);
  if (at < 0) {
    const past = [...ledger.records].reverse().find((e) => e.id === req.id);
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
  if (req.actor !== 'host' && req.actor !== 'admin' && !sameHolder(req.actor, entry.holder)) {
    return {
      ledger,
      result: { ok: false, code: 'NOT_HOLDER', message: `${req.id} belongs to another thread; only it ends it.` },
    };
  }
  const reason = typeof req.reason === 'string' && req.reason.trim() ? req.reason.trim().slice(0, NOTE_MAX) : undefined;
  const ended = recordOf(entry, req.end, now, reason);
  const entries = ledger.entries.filter((_, i) => i !== at);
  const granted = promote(entries, entry.queue, now);
  return {
    ledger: { ...ledger, entries, records: appendRecords(ledger.records, ended) },
    result: { ok: true, ended, entry, ...(granted ? { granted } : {}) },
  };
}

/** The host's sweep: release every named entry (`released`, with its reason) and promote each lane it freed. */
export function releaseByHost(
  ledger: WorkQueueLedger,
  releases: ReadonlyArray<{ id: string; reason: string }>,
  now: number,
): {
  ledger: WorkQueueLedger;
  ended: Array<LineRecord & { state: WorkQueueState }>;
  granted: WorkQueueEntry[];
} {
  let current = ledger;
  const ended: Array<LineRecord & { state: WorkQueueState }> = [];
  const granted: WorkQueueEntry[] = [];
  for (const r of releases) {
    const { ledger: next, result } = endEntry(
      current,
      { id: r.id, end: 'released', actor: 'host', reason: r.reason },
      now,
    );
    if (!result.ok) continue;
    current = next;
    ended.push({ ...result.ended, state: result.entry.state });
    if (result.granted) granted.push(result.granted);
  }
  // An entry granted by one release and released by a later one is not granted any more.
  const stillRunning = granted.filter((g) => current.entries.some((e) => e.id === g.id && e.state === 'running'));
  return { ledger: current, ended, granted: stillRunning };
}

/** An admin lets a waiting entry go first: ahead of every other waiting entry of its lane. */
export function putFirst(
  ledger: WorkQueueLedger,
  id: string,
): { ledger: WorkQueueLedger; result: { ok: true } | { ok: false; code: 'UNKNOWN_ENTRY' | 'NOT_WAITING' } } {
  const entry = ledger.entries.find((e) => e.id === id);
  if (!entry) return { ledger, result: { ok: false, code: 'UNKNOWN_ENTRY' } };
  if (entry.state !== 'waiting') return { ledger, result: { ok: false, code: 'NOT_WAITING' } };
  const rest = ledger.entries.filter((e) => e.id !== id);
  const firstWaiting = rest.findIndex((e) => e.queue === entry.queue && e.state === 'waiting');
  const at = firstWaiting < 0 ? rest.length : firstWaiting;
  const entries = [...rest.slice(0, at), entry, ...rest.slice(at)];
  return { ledger: { ...ledger, entries }, result: { ok: true } };
}

/** Stamp that the holder of a running entry was told it runs. Same ledger when there is nothing to stamp. */
export function markNotified(ledger: WorkQueueLedger, id: string, now: number): WorkQueueLedger {
  const at = ledger.entries.findIndex((e) => e.id === id && e.state === 'running' && e.notifiedAt === undefined);
  if (at < 0) return ledger;
  const entries = [...ledger.entries];
  entries[at] = { ...entries[at], notifiedAt: now };
  return { ...ledger, entries };
}

function entryView(ledger: WorkQueueLedger, e: WorkQueueEntry): LineEntryView {
  return {
    id: e.id,
    keys: [...e.keys],
    holder: { ...e.holder },
    state: e.state,
    position: queuePosition(ledger, e),
    enteredAt: e.enteredAt,
    ...(e.grantedAt !== undefined ? { startedAt: e.grantedAt } : {}),
    ...(e.note ? { label: e.note } : {}),
  };
}

/**
 * Every lane as the board, the settings page and `queue_list` show it: the pinned lanes first (in their order, even
 * empty), then every other lane that has entries or records, by name. One runs at a time (`capacity: 1`).
 */
export function queueViews(
  ledger: WorkQueueLedger,
  pinned: readonly string[] = [],
  recentPerQueue = 20,
): LineQueueView[] {
  const seen = new Set(pinned);
  const others = new Set<string>();
  for (const e of ledger.entries) if (!seen.has(e.queue)) others.add(e.queue);
  for (const r of ledger.records) if (!seen.has(r.queue)) others.add(r.queue);
  const names = [...pinned, ...[...others].sort()];
  return names.map((id) => {
    const live = inQueue(ledger, id);
    return {
      id,
      kind: 'lane' as const,
      capacity: 1,
      running: live.filter((e) => e.state === 'running').map((e) => entryView(ledger, e)),
      waiting: live.filter((e) => e.state === 'waiting').map((e) => entryView(ledger, e)),
      recent: ledger.records
        .filter((r) => r.queue === id)
        .slice(-recentPerQueue)
        .reverse(),
    };
  });
}

/** The live entries that claim any of `keys` in `queue` (for answers that name who has them). */
export function claimsIn(ledger: WorkQueueLedger, queue: string, keys: readonly string[]): KeyClaim[] {
  return claimsOn(inQueue(ledger, normalizeQueueName(queue)), keys);
}
