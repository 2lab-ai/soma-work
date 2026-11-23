/**
 * The per-user task queue's ledger — plain data and pure steps over it, no I/O.
 *
 * One list for every person, kept in line order: a person's entries, read in list order, are their queue. An entry is
 * one task (one thread) that could not start because its owner already runs as many tasks as they may:
 *
 * - `request` — a message that would have started a turn; it is replayed as it arrived when its turn comes.
 * - `resume`  — a task that was stopped so another could go first (먼저 진행); a host turn carries it on.
 *
 * `waiting` entries stand in line. `admitted` ones were started and are on their way to their turn: they still hold
 * a place until the turn takes it (`take`), so a second release cannot start a task into the same free slot.
 */

export type UserTaskKind = 'request' | 'resume';
export type UserTaskState = 'waiting' | 'admitted';

export interface UserTaskThread {
  sessionKey: string;
  channel: string;
  threadTs: string;
}

export interface UserTaskEntry extends UserTaskThread {
  id: string;
  /** Whose task it is: the thread's owner (the sender, for a new thread). */
  userId: string;
  kind: UserTaskKind;
  /** A short line saying what the task is (the request's first words, or the stopped task's title). */
  preview: string;
  enqueuedAt: number;
  state: UserTaskState;
  admittedAt?: number;
  /** `request`: the message as it arrived (JSON), replayed when its turn comes. */
  message?: Record<string, unknown>;
  /** The Slack notice this entry posted, rewritten when it starts or leaves the line. */
  notice?: { channel: string; ts: string };
  /** `resume`: the task that went first and put this one back. */
  deferredFor?: UserTaskThread;
  /** The person let it go first (먼저 진행) while the running task's stop was still landing: it starts as such. */
  bypass?: boolean;
}

export interface UserTaskLedger {
  version: 1;
  entries: UserTaskEntry[];
}

export function emptyLedger(): UserTaskLedger {
  return { version: 1, entries: [] };
}

export function entriesOf(ledger: UserTaskLedger, userId: string): UserTaskEntry[] {
  return ledger.entries.filter((e) => e.userId === userId);
}

export function waitingOf(ledger: UserTaskLedger, userId: string): UserTaskEntry[] {
  return ledger.entries.filter((e) => e.userId === userId && e.state === 'waiting');
}

export function admittedOf(ledger: UserTaskLedger, userId: string): UserTaskEntry[] {
  return ledger.entries.filter((e) => e.userId === userId && e.state === 'admitted');
}

/** 1-based place among the person's waiting entries; 0 when the entry does not wait. */
export function positionOf(ledger: UserTaskLedger, id: string): number {
  const entry = ledger.entries.find((e) => e.id === id);
  if (!entry || entry.state !== 'waiting') return 0;
  return waitingOf(ledger, entry.userId).findIndex((e) => e.id === id) + 1;
}

export function findEntry(ledger: UserTaskLedger, id: string): UserTaskEntry | undefined {
  return ledger.entries.find((e) => e.id === id);
}

export function waitingForSession(ledger: UserTaskLedger, sessionKey: string): UserTaskEntry | undefined {
  return ledger.entries.find((e) => e.sessionKey === sessionKey && e.state === 'waiting');
}

export function append(ledger: UserTaskLedger, entry: UserTaskEntry): UserTaskLedger {
  return { ...ledger, entries: [...ledger.entries, entry] };
}

/** Put `entries` ahead of everything of their owner (in the given order). */
export function putFirst(ledger: UserTaskLedger, ...entries: UserTaskEntry[]): UserTaskLedger {
  const ids = new Set(entries.map((e) => e.id));
  return { ...ledger, entries: [...entries, ...ledger.entries.filter((e) => !ids.has(e.id))] };
}

export function remove(ledger: UserTaskLedger, id: string): UserTaskLedger {
  return { ...ledger, entries: ledger.entries.filter((e) => e.id !== id) };
}

export function update(ledger: UserTaskLedger, id: string, patch: Partial<UserTaskEntry>): UserTaskLedger {
  return { ...ledger, entries: ledger.entries.map((e) => (e.id === id ? { ...e, ...patch } : e)) };
}

/**
 * After a restart nothing admitted can still be on its way (the process that started it is gone): it waits again,
 * where it stood.
 */
export function recoverAfterRestart(ledger: UserTaskLedger): UserTaskLedger {
  return {
    ...ledger,
    entries: ledger.entries.map((e) => {
      if (e.state !== 'admitted') return e;
      const { admittedAt: _dropped, ...rest } = e;
      return { ...rest, state: 'waiting' as const };
    }),
  };
}

/** Throws on anything that is not a ledger (the store's schema gate). */
export function parseLedger(raw: unknown): UserTaskLedger {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
  const { version, entries } = raw as { version?: unknown; entries?: unknown };
  if (version !== 1) throw new Error(`unknown version ${String(version)}`);
  if (!Array.isArray(entries)) throw new Error('entries is not a list');
  for (const e of entries) {
    if (!e || typeof e !== 'object') throw new Error('entry is not an object');
    const entry = e as Partial<UserTaskEntry>;
    for (const field of ['id', 'userId', 'sessionKey', 'channel', 'threadTs'] as const) {
      if (typeof entry[field] !== 'string' || !entry[field]) throw new Error(`entry ${field} missing`);
    }
    if (entry.kind !== 'request' && entry.kind !== 'resume') throw new Error('entry kind unknown');
    if (entry.state !== 'waiting' && entry.state !== 'admitted') throw new Error('entry state unknown');
    // A request is replayed as it arrived: one without its message could never run.
    if (entry.kind === 'request') {
      const m = entry.message as { channel?: unknown } | undefined;
      if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.channel !== 'string') {
        throw new Error('request entry has no replayable message');
      }
    }
  }
  return raw as UserTaskLedger;
}
