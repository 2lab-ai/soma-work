/**
 * The line every work queue shares (.prd/36 v2 §2, .prd/37 §2) — a lane (`qa-dev2`) and a person's queue are one
 * model:
 *
 * - an entry is one task (a thread) and names the work it is for by keys (`keys.ts`);
 * - entries stand in arrival order: `running` ones hold the queue's places, `waiting` ones wait for one;
 * - a key a live entry already claims is not claimed twice — the newcomer learns who has it;
 * - an entry that leaves the line leaves a record (내역), so anyone can see the queue ran one at a time.
 *
 * Pure: plain data in, plain data out. The lane ledger (`ledger.ts`, shared between processes in SQLite) and the
 * per-person queue (`src/user-task-queue`, in the host) keep their own entries and use these rules on them.
 */

export interface LineHolder {
  user: string;
  channel: string;
  threadTs: string;
}

export type LineState = 'running' | 'waiting';

/** What the line needs of an entry, whichever queue keeps it. */
export interface LineItem {
  id: string;
  keys: readonly string[];
  state: LineState;
  holder: LineHolder;
  enteredAt: number;
}

/** A key a live entry already claims. */
export interface KeyClaim {
  key: string;
  entry: string;
  state: LineState;
  holder: LineHolder;
}

export function sameThread(a: Pick<LineHolder, 'channel' | 'threadTs'>, b: Pick<LineHolder, 'channel' | 'threadTs'>) {
  return a.channel === b.channel && a.threadTs === b.threadTs;
}

/** Each key of `keys` that a live entry claims (the first entry in line that names it). */
export function claimsOn(live: readonly LineItem[], keys: readonly string[]): KeyClaim[] {
  const claims: KeyClaim[] = [];
  for (const key of keys) {
    const owner = live.find((e) => e.keys.includes(key));
    if (owner) claims.push({ key, entry: owner.id, state: owner.state, holder: { ...owner.holder } });
  }
  return claims;
}

/** `keys` split into the ones nobody claims and the claims on the rest. */
export function splitKeys(live: readonly LineItem[], keys: readonly string[]): { free: string[]; claimed: KeyClaim[] } {
  const claimed = claimsOn(live, keys);
  const taken = new Set(claimed.map((c) => c.key));
  return { free: keys.filter((k) => !taken.has(k)), claimed };
}

/** 1-based place among the waiting entries of `items` (their order is the line); 0 for a running or absent entry. */
export function waitingPlace(items: readonly LineItem[], id: string): number {
  const waiting = items.filter((e) => e.state === 'waiting');
  return waiting.findIndex((e) => e.id === id) + 1;
}

/**
 * How an entry left the line:
 * - `started`   — a person's waiting request got its turn (the task then runs as a turn, not as an entry);
 * - `done`      — a lane's holder finished the work;
 * - `cancelled` — taken out of line by its holder, its owner, an admin, or a closed thread;
 * - `released`  — a running lane entry given back (the host: its thread stopped working; an admin);
 * - `refused`   — never entered: every key it named was already claimed (the same work sent again).
 */
export type LineEnd = 'started' | 'done' | 'cancelled' | 'released' | 'refused';

export interface LineRecord {
  id: string;
  queue: string;
  keys: string[];
  holder: LineHolder;
  /** A short line saying what the work was (a lane's note, a request's first words). */
  label?: string;
  enteredAt: number;
  /** When it got a place (a lane entry that ran). */
  startedAt?: number;
  endedAt: number;
  end: LineEnd;
  reason?: string;
}

/** Records kept per ledger (newest last). */
export const LINE_RECORDS_KEEP = 200;

/** `records` with `more` after them, the oldest dropped past {@link LINE_RECORDS_KEEP}. */
export function appendRecords(records: readonly LineRecord[], ...more: LineRecord[]): LineRecord[] {
  return [...records, ...more].slice(-LINE_RECORDS_KEEP);
}

export function isLineRecord(value: unknown): value is LineRecord {
  const r = value as LineRecord | null;
  return (
    !!r &&
    typeof r === 'object' &&
    typeof r.id === 'string' &&
    typeof r.queue === 'string' &&
    Array.isArray(r.keys) &&
    r.keys.every((k) => typeof k === 'string') &&
    isLineHolder(r.holder) &&
    Number.isFinite(r.enteredAt) &&
    Number.isFinite(r.endedAt) &&
    ['started', 'done', 'cancelled', 'released', 'refused'].includes(r.end)
  );
}

export function isLineHolder(h: unknown): h is LineHolder {
  const x = h as LineHolder | null;
  return !!x && typeof x === 'object' && typeof x.channel === 'string' && typeof x.threadTs === 'string';
}

/** One entry as the board and the settings page draw it. */
export interface LineEntryView {
  id: string;
  keys: string[];
  holder: LineHolder;
  state: LineState;
  /** 0 = runs; n = n-th waiting. */
  position: number;
  enteredAt: number;
  startedAt?: number;
  label?: string;
}

/**
 * One queue as the board's 작업 큐 section and the settings page draw it — the same shape for a lane and a person:
 * how many may run at once, what runs, what waits (in order), and what recently left (newest first).
 */
export interface LineQueueView {
  /** `qa-dev2` for a lane, `user:<id>` for a person. */
  id: string;
  kind: 'lane' | 'person';
  /** How many run at once; `null` = no limit. */
  capacity: number | null;
  running: LineEntryView[];
  waiting: LineEntryView[];
  recent: LineRecord[];
}

/** The id a person's queue goes by in views and routes. */
export function personQueueId(userId: string): string {
  return `user:${userId}`;
}
