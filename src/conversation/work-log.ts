/**
 * Work log — the verbose, per-conversation stream of what the model is doing
 * (instructions, narration, tool calls, results, notices, errors). Slack only
 * shows the minimal surface; the standalone dashboard shows this log.
 *
 * Storage: `${DATA_DIR}/worklogs/<conversationId>.jsonl`, append-only, one
 * entry per line, written in `seq` order.
 *
 * Durability: an entry is published — `appendWorkLog` resolves and the
 * dashboard broadcast fires — only after its line is fdatasync'd (and the
 * directory fsync'd when the write created the file). Cost: one fdatasync per
 * entry. Entries are per tool event / narration segment, a low rate, and the
 * write is off the turn's path (the stream executor does not await it).
 *
 * seq: monotonic per conversation and never reused once published. The first
 * append in a process reads the last seq back from the file's tail. The
 * sidecar `<id>.seq` reserves seqs in blocks, durably and before any seq in the
 * block is used, so every seq ever used is ≤ the reservation. When the tail
 * cannot be read within the scan budget, the log is quarantined to
 * `<id>.jsonl.corrupt-<ms>` and a fresh one continues above the reservation.
 *
 * Reads: every scan has a byte budget (WORK_LOG_SCAN_BUDGET_BYTES). The latest
 * window and the seed scan back from the end; `afterSeq` pages first try a
 * short backward scan (the reconnect case), else binary-search byte offsets
 * (lines are in seq order) and read forward. A read that runs out of budget
 * returns what it found with `hasMore: true` and logs a warning.
 *
 * Line contract: a line longer than WORK_LOG_MAX_LINE_BYTES is never an entry —
 * readers skip it whatever its chunk alignment, and the writer refuses to
 * produce one (`text` ≤ 4000 chars, `tool`/`turnId` ≤ 200 chars).
 *
 * Contract: .prd/10-agent-inbox-board-spec.md §3.3.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteJson, readJsonWithBackup } from '@soma/common/atomic-json';
import { DATA_DIR } from '../env-paths';
import { Logger } from '../logger';

const logger = new Logger('WorkLog');

// ── Types (spec §3.3, verbatim) ──
// Same shape as packages/slack/src/work-log.ts, which the emitter side owns.
// Kept local so this module compiles on its own; dedupe to an import once both
// sides are on main.

export type WorkLogKind = 'instruction' | 'narration' | 'tool' | 'tool_result' | 'final' | 'notice' | 'error';
export interface WorkLogInput {
  kind: WorkLogKind;
  text: string;
  tool?: string;
  ok?: boolean;
  turnId?: string;
  ts?: number;
}
export interface WorkLogEntry extends WorkLogInput {
  seq: number;
  ts: number;
}

export interface WorkLogPage {
  entries: WorkLogEntry[];
  /**
   * With `afterSeq`: newer entries exist past the returned page.
   * Without: older entries exist before the returned (latest) window.
   * Also true when the read stopped at its byte budget.
   */
  hasMore: boolean;
}

/** Max characters kept per entry `text` (spec §3.3). */
export const WORK_LOG_TEXT_MAX = 4000;
/** Max characters kept for `tool` and `turnId`. */
export const WORK_LOG_FIELD_MAX = 200;
/** Default (and API maximum) number of entries returned by a read. */
export const WORK_LOG_DEFAULT_LIMIT = 500;
/** Read granularity. */
export const WORK_LOG_READ_CHUNK_BYTES = 64 * 1024;
/** A line longer than this (excluding its `\n`) is never an entry. */
export const WORK_LOG_MAX_LINE_BYTES = 1024 * 1024;
/** Most bytes any single read or seed scan may read. */
export const WORK_LOG_SCAN_BUDGET_BYTES = 8 * 1024 * 1024;
/** seqs reserved per sidecar write. */
export const WORK_LOG_SEQ_RESERVE_BLOCK = 1000;
/** Idle per-conversation writer states kept warm (each costs one tail read to rebuild). */
export const WORK_LOG_MAX_CACHED_STATES = 256;
/**
 * Lower bound on the bytes per line this module writes (the smallest entry,
 * `{"seq":1,"ts":1,"kind":"tool","text":""}`, is 40), used to bound the seqs a
 * file without a sidecar can hold.
 */
const MIN_ENTRY_BYTES = 32;
/** Share of the budget an `afterSeq` read spends on the backward reconnect fast path. */
const FAST_PATH_BUDGET_BYTES = WORK_LOG_SCAN_BUDGET_BYTES / 4;

/** Conversation ids are UUIDs; anything outside this set never touches the filesystem. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const EMPTY = Buffer.alloc(0);

interface ConversationLogState {
  /** Last seq on disk; null = not read from the file yet (or unknown after a failed write). */
  lastSeq: number | null;
  /** Highest seq the durable sidecar allows without another reservation. */
  reservedSeq: number;
  /** The file ends mid-line (torn write); the next line must start on a fresh one. */
  needsLeadingNewline: boolean;
  /** The next write may create the file, so the directory must be fsync'd after it. */
  fileMayBeNew: boolean;
  /** Serialized write chain for this file — appends never interleave. */
  queue: Promise<void>;
  /** Appends queued and not yet settled; a state is only evicted at 0. */
  pending: number;
}

interface Budget {
  left: number;
}
type ScanEnd = 'done' | 'stopped' | 'budget';

const states = new Map<string, ConversationLogState>();
let dirReady: Promise<void> | null = null;
let _onAppended: ((conversationId: string, entry: WorkLogEntry) => void) | null = null;

class WorkLogScanError extends Error {}

function workLogDir(): string {
  return path.join(DATA_DIR, 'worklogs');
}

function workLogPaths(conversationId: string): { log: string; sidecar: string } | null {
  if (typeof conversationId !== 'string' || !SAFE_ID.test(conversationId)) return null;
  const base = path.join(workLogDir(), conversationId);
  return { log: `${base}.jsonl`, sidecar: `${base}.seq` };
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/** fsync a directory so a create/rename inside it survives power loss. */
async function syncDir(dir: string): Promise<void> {
  if (process.platform === 'win32') return; // directories cannot be opened for fsync there
  const fh = await fs.promises.open(dir, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close().catch(() => {});
  }
}

function ensureDir(): Promise<void> {
  if (!dirReady) {
    dirReady = fs.promises
      .mkdir(workLogDir(), { recursive: true })
      .then(async (created) => {
        if (created) await syncDir(path.dirname(workLogDir()));
      })
      .catch((err) => {
        dirReady = null; // retry on the next append
        throw err;
      });
  }
  return dirReady;
}

function parseEntry(line: Buffer): WorkLogEntry | null {
  // Shape check first, so a long run of junk lines costs no JSON.parse throws.
  if (line[0] !== 0x7b) return null; // '{'
  let last = line.length - 1;
  while (last > 0 && (line[last] === 0x0d || line[last] === 0x20 || line[last] === 0x09)) last--; // CRLF / padding
  if (line[last] !== 0x7d) return null; // '}'
  try {
    const value = JSON.parse(line.toString('utf-8')) as Partial<WorkLogEntry> | null;
    if (!value || typeof value.seq !== 'number' || !Number.isFinite(value.seq)) return null;
    return value as WorkLogEntry;
  } catch {
    return null; // torn or corrupt line
  }
}

// ── Chunked, budgeted line scanning ──

async function readExactly(fh: fs.promises.FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  // Files only grow, and every read stays below the size taken from stat().
  if (bytesRead !== length) throw new WorkLogScanError('work log shrank while being read');
  return buf;
}

/**
 * Feed lines to `onLine` from the end of the file towards the start; stop when
 * it returns false or the budget runs out. The last segment counts as a line
 * even without a trailing newline (a fully written entry whose `\n` was lost is
 * still an entry). Lines over the size limit are skipped: the completed length
 * is checked before `onLine`, and a partial line that already exceeds the limit
 * is dropped instead of being buffered further.
 */
async function scanBackward(
  fh: fs.promises.FileHandle,
  size: number,
  budget: Budget,
  onLine: (line: Buffer) => boolean,
): Promise<ScanEnd> {
  let pos = size;
  let carry: Buffer = EMPTY; // end part of a line that began before `pos`
  let dropping = false; // the line ending at the next newline found is over the limit
  while (pos > 0) {
    const n = Math.min(WORK_LOG_READ_CHUNK_BYTES, pos, budget.left);
    if (n <= 0) return 'budget';
    budget.left -= n;
    pos -= n;
    const chunk = await readExactly(fh, pos, n);
    const buf = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk;
    let end = buf.length;
    for (
      let idx = end > 0 ? buf.lastIndexOf(0x0a, end - 1) : -1;
      idx !== -1;
      idx = end > 0 ? buf.lastIndexOf(0x0a, end - 1) : -1
    ) {
      if (dropping) {
        dropping = false; // buf[idx+1, end) is the start of the dropped line
      } else {
        const len = end - idx - 1;
        if (len > 0 && len <= WORK_LOG_MAX_LINE_BYTES && !onLine(buf.subarray(idx + 1, end))) return 'stopped';
      }
      end = idx;
    }
    if (dropping) continue; // still inside the dropped line
    carry = buf.subarray(0, end);
    if (carry.length > WORK_LOG_MAX_LINE_BYTES) {
      carry = EMPTY;
      dropping = true;
    }
  }
  if (carry.length > 0) onLine(carry); // empty while dropping: the dropped line is never buffered
  return 'done';
}

/** Feed lines to `onLine` from byte offset `from` (a line start) forwards; same rules as scanBackward. */
async function scanForward(
  fh: fs.promises.FileHandle,
  size: number,
  from: number,
  budget: Budget,
  onLine: (line: Buffer) => boolean,
): Promise<ScanEnd> {
  let pos = from;
  let carry: Buffer = EMPTY; // start part of a line that continues past `pos`
  let dropping = false; // the bytes up to the next newline belong to an over-limit line
  while (pos < size) {
    const n = Math.min(WORK_LOG_READ_CHUNK_BYTES, size - pos, budget.left);
    if (n <= 0) return 'budget';
    budget.left -= n;
    const chunk = await readExactly(fh, pos, n);
    pos += n;
    const buf = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
    let start = 0;
    for (let idx = buf.indexOf(0x0a, start); idx !== -1; idx = buf.indexOf(0x0a, start)) {
      if (dropping) {
        dropping = false; // buf[start, idx) is the end of the dropped line
      } else {
        const len = idx - start;
        if (len > 0 && len <= WORK_LOG_MAX_LINE_BYTES && !onLine(buf.subarray(start, idx))) return 'stopped';
      }
      start = idx + 1;
    }
    if (dropping) continue;
    carry = buf.subarray(start);
    if (carry.length > WORK_LOG_MAX_LINE_BYTES) {
      carry = EMPTY;
      dropping = true;
    }
  }
  if (carry.length > 0) onLine(carry); // empty while dropping: the dropped line is never buffered
  return 'done';
}

/** First parseable entry that starts after byte `at`, read from one chunk. */
async function probeAfter(
  fh: fs.promises.FileHandle,
  size: number,
  at: number,
  budget: Budget,
): Promise<{ start: number; seq: number } | null | 'budget'> {
  if (at >= size) return null;
  const n = Math.min(WORK_LOG_READ_CHUNK_BYTES, size - at, budget.left);
  if (n <= 0) return 'budget';
  budget.left -= n;
  const buf = await readExactly(fh, at, n);
  let start = buf.indexOf(0x0a);
  while (start !== -1) {
    const next = buf.indexOf(0x0a, start + 1);
    const lineEnd = next !== -1 ? next : at + n >= size ? buf.length : -1;
    if (lineEnd === -1) return null; // line runs past this chunk
    const entry = lineEnd - start - 1 > 0 ? parseEntry(buf.subarray(start + 1, lineEnd)) : null;
    if (entry) return { start: at + start + 1, seq: entry.seq };
    start = next;
  }
  return null;
}

/**
 * Byte offset of a line start such that every line before it has
 * `seq <= afterSeq`. Lines are in seq order, so this is a binary search on byte
 * offsets. Only `lo` moves on evidence (a parsed line ≤ afterSeq); a missed or
 * unparseable probe only lowers `hi`, which costs scanning, never correctness.
 * Out of budget, the current `lo` is still a valid (if early) start.
 */
async function findPageStart(
  fh: fs.promises.FileHandle,
  size: number,
  afterSeq: number,
  budget: Budget,
): Promise<number> {
  let lo = 0;
  let hi = size;
  while (hi - lo > WORK_LOG_READ_CHUNK_BYTES) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const probe = await probeAfter(fh, size, mid, budget);
    if (probe === 'budget') break;
    if (probe && probe.seq <= afterSeq) lo = probe.start;
    else hi = mid;
  }
  return lo;
}

async function openForRead(filePath: string): Promise<{ fh: fs.promises.FileHandle; size: number } | null> {
  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(filePath, 'r');
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
  try {
    return { fh, size: (await fh.stat()).size };
  } catch (err) {
    await fh.close().catch(() => {});
    throw err;
  }
}

// ── Writer ──

function readReservation(sidecarPath: string): number | null {
  // Shared state-store loader (rules/config.md §4): `.bak` fallback with a WARN,
  // and a throw — never a silent 0 — when both copies are unusable.
  const value = readJsonWithBackup(
    sidecarPath,
    (raw) => {
      const seq = (raw as { reservedSeq?: unknown } | null)?.reservedSeq;
      if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) {
        throw new Error('reservedSeq must be a non-negative integer');
      }
      return seq;
    },
    { warn: (message, detail) => logger.warn(message, detail) },
  );
  return value ?? null;
}

async function writeReservation(sidecarPath: string, reservedSeq: number): Promise<void> {
  // Shared atomic writer (temp → fsync → rename); it leaves the directory
  // unsynced, and the rename must survive power loss for the reservation to
  // bound every seq used after it.
  atomicWriteJson(sidecarPath, { reservedSeq }, { warn: (message, detail) => logger.warn(message, detail) });
  await syncDir(path.dirname(sidecarPath));
}

async function appendDurably(filePath: string, line: string): Promise<void> {
  const fh = await fs.promises.open(filePath, 'a');
  try {
    await fh.writeFile(line, 'utf-8');
    await fh.datasync();
  } catch (error) {
    await fh.close().catch(() => {});
    throw error;
  }
  await fh.close();
}

interface Seed {
  lastSeq: number;
  reservedSeq: number;
  needsLeadingNewline: boolean;
  fileMayBeNew: boolean;
}

/**
 * Read the writer's starting point: the reservation and, from the file's tail,
 * the seq of the last parseable line and whether the file ends mid-line. Only
 * ENOENT means "no log yet"; any other failure throws so the caller never
 * guesses a seq. A tail with no parseable line within the budget quarantines
 * the file and continues above every seq it can have held.
 */
async function readSeed(conversationId: string, logPath: string, sidecarPath: string): Promise<Seed> {
  const reserved = readReservation(sidecarPath);
  const floor = reserved ?? 0;

  const opened = await openForRead(logPath);
  if (!opened) return { lastSeq: floor, reservedSeq: floor, needsLeadingNewline: false, fileMayBeNew: true };
  const { fh, size } = opened;
  const tail: { seq: number | null } = { seq: null };
  let end: ScanEnd = 'done';
  let lastByteIsNewline = true;
  try {
    if (size > 0) {
      lastByteIsNewline = (await readExactly(fh, size - 1, 1))[0] === 0x0a;
      end = await scanBackward(fh, size, { left: WORK_LOG_SCAN_BUDGET_BYTES }, (line) => {
        const entry = parseEntry(line);
        if (!entry) return true; // torn/corrupt — keep looking further back
        tail.seq = entry.seq;
        return false;
      });
    }
  } finally {
    await fh.close().catch(() => {});
  }

  if (tail.seq !== null) {
    return { lastSeq: tail.seq, reservedSeq: floor, needsLeadingNewline: !lastByteIsNewline, fileMayBeNew: false };
  }
  if (end !== 'budget') {
    // Whole file read, no entry in it: nothing it holds was ever published.
    return { lastSeq: floor, reservedSeq: floor, needsLeadingNewline: !lastByteIsNewline, fileMayBeNew: false };
  }

  // The tail is unreadable within budget. Set the file aside and continue above
  // every seq it can hold: the reservation bounds every seq this module ever
  // used for it (one is written before the first append); a log without a
  // sidecar falls back to the most lines its size can hold.
  const quarantined = `${logPath}.corrupt-${Date.now()}`;
  await fs.promises.rename(logPath, quarantined);
  await syncDir(path.dirname(logPath));
  const resume = reserved ?? Math.ceil(size / MIN_ENTRY_BYTES);
  logger.warn('Work log tail unreadable within the scan budget; quarantined and continuing above it', {
    conversationId,
    quarantined,
    size,
    resumeAfterSeq: resume,
  });
  return { lastSeq: resume, reservedSeq: floor, needsLeadingNewline: false, fileMayBeNew: true };
}

function clampChars(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1; // leave room for the ellipsis
  const lastKept = text.charCodeAt(end - 1);
  if (lastKept >= 0xd800 && lastKept <= 0xdbff) end -= 1; // never split a surrogate pair
  return `${text.slice(0, end)}…`;
}

/** Evict idle states, oldest first, until the cache fits (never `keep`). */
function trimStates(keep?: string): void {
  if (states.size <= WORK_LOG_MAX_CACHED_STATES) return;
  for (const [id, s] of states) {
    if (states.size <= WORK_LOG_MAX_CACHED_STATES) break;
    // Idle states hold nothing the files do not; busy ones must keep their queue.
    if (s.pending === 0 && id !== keep) states.delete(id);
  }
}

/** Get (or create) a conversation's writer state, keeping the map an LRU of bounded size. */
function touchState(conversationId: string): ConversationLogState {
  let state = states.get(conversationId);
  if (state) {
    states.delete(conversationId);
  } else {
    state = {
      lastSeq: null,
      reservedSeq: 0,
      needsLeadingNewline: false,
      fileMayBeNew: true,
      queue: Promise.resolve(),
      pending: 0,
    };
  }
  states.set(conversationId, state);
  trimStates(conversationId);
  return state;
}

/** Cached writer-state ids, least recently used first (tests). */
export function _cachedWorkLogStateIds(): string[] {
  return Array.from(states.keys());
}

/**
 * Register the single in-process listener fired after every published append
 * (the dashboard WS broadcast). Mirrors recorder's `setOnTurnRecordedCallback`.
 */
export function setOnWorkLogAppendedCallback(fn: ((conversationId: string, entry: WorkLogEntry) => void) | null): void {
  _onAppended = fn;
}

type EntryFields = Omit<WorkLogEntry, 'seq'>;

async function writeEntry(
  conversationId: string,
  files: { log: string; sidecar: string },
  state: ConversationLogState,
  fields: EntryFields,
): Promise<WorkLogEntry> {
  if (state.lastSeq === null) {
    try {
      const seed = await readSeed(conversationId, files.log, files.sidecar);
      state.lastSeq = seed.lastSeq;
      state.reservedSeq = seed.reservedSeq;
      state.needsLeadingNewline = seed.needsLeadingNewline;
      state.fileMayBeNew = seed.fileMayBeNew;
    } catch (error) {
      // State stays unseeded, so the next append reads the tail again.
      logger.warn('Work log seed failed; entry dropped', { conversationId, error });
      throw error;
    }
  }

  const entry: WorkLogEntry = { seq: state.lastSeq + 1, ...fields };
  const json = JSON.stringify(entry);
  // Unreachable through the field caps above; a backstop so the writer can
  // never produce a line every reader would skip.
  if (Buffer.byteLength(json, 'utf-8') > WORK_LOG_MAX_LINE_BYTES) {
    logger.warn('Work log entry dropped: over the line size limit', { conversationId, seq: entry.seq });
    throw new Error('Work log entry exceeds the line size limit');
  }
  const line = `${state.needsLeadingNewline ? '\n' : ''}${json}\n`;
  try {
    await ensureDir();
    if (entry.seq > state.reservedSeq) {
      const reservedSeq = entry.seq + WORK_LOG_SEQ_RESERVE_BLOCK - 1;
      await writeReservation(files.sidecar, reservedSeq);
      state.reservedSeq = reservedSeq;
    }
    await appendDurably(files.log, line);
    if (state.fileMayBeNew) {
      await syncDir(workLogDir());
      state.fileMayBeNew = false;
    }
  } catch (error) {
    // The file may now hold nothing, part, or all of the line. Forget the seed
    // (the newline flag is left as it was) so the next append re-reads the tail
    // and the reservation instead of guessing — that gets seq and newline right
    // in every case.
    state.lastSeq = null;
    logger.error('Failed to persist work log entry', { conversationId, seq: entry.seq, error });
    throw error;
  }
  state.lastSeq = entry.seq;
  state.needsLeadingNewline = false;

  if (_onAppended) {
    try {
      _onAppended(conversationId, entry);
    } catch (error) {
      logger.warn('Work log listener failed', { conversationId, error });
    }
  }
  return entry;
}

/**
 * Append one entry. `ts` defaults to the call time; `seq` is assigned when the
 * entry reaches the front of this conversation's write queue. Resolves with the
 * stored entry once it is durable (the listener has fired by then); rejects —
 * already logged — when the id is unsafe, the seed read fails, the entry is
 * over the line limit, or the write fails.
 */
export function appendWorkLog(conversationId: string, input: WorkLogInput): Promise<WorkLogEntry> {
  const files = workLogPaths(conversationId);
  if (!files) {
    logger.warn('Rejected work log entry for an unsafe conversationId', { conversationId });
    return Promise.reject(new Error('Invalid work log conversationId'));
  }

  const fields: EntryFields = {
    ts: typeof input.ts === 'number' && Number.isFinite(input.ts) ? input.ts : Date.now(),
    kind: input.kind,
    text: clampChars(String(input.text ?? ''), WORK_LOG_TEXT_MAX),
  };
  if (input.tool !== undefined) fields.tool = clampChars(String(input.tool), WORK_LOG_FIELD_MAX);
  if (input.ok !== undefined) fields.ok = input.ok;
  if (input.turnId !== undefined) fields.turnId = clampChars(String(input.turnId), WORK_LOG_FIELD_MAX);

  const state = touchState(conversationId);
  state.pending += 1;
  const result = state.queue
    .then(() => writeEntry(conversationId, files, state, fields))
    .finally(() => {
      state.pending -= 1;
      trimStates(); // a burst of distinct conversations may have left the cache over its cap
    });
  state.queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Resolve once every queued write in this process has settled (tests, shutdown). */
export async function flushWorkLog(): Promise<void> {
  await Promise.all(Array.from(states.values(), (s) => s.queue));
}

// ── Reader ──

function warnBudget(conversationId: string, mode: string, found: number): void {
  logger.warn('Work log read stopped at its byte budget; returning a partial page', {
    conversationId,
    mode,
    found,
    budgetBytes: WORK_LOG_SCAN_BUDGET_BYTES,
  });
}

/**
 * Without `afterSeq`: the latest `limit` entries (`hasMore` = older exist).
 * With `afterSeq`: the first `limit` entries with `seq > afterSeq`, for forward
 * paging (`hasMore` = newer exist past this page). A read that hits its byte
 * budget returns what it found with `hasMore: true`. Waits for this process's
 * pending writes to the same file first. Unknown or unsafe ids read as empty.
 */
export async function readWorkLog(
  conversationId: string,
  options: { afterSeq?: number; limit?: number } = {},
): Promise<WorkLogPage> {
  const empty: WorkLogPage = { entries: [], hasMore: false };
  const files = workLogPaths(conversationId);
  if (!files) return empty;
  const limit = options.limit ?? WORK_LOG_DEFAULT_LIMIT;
  if (!(limit > 0)) return empty;
  const { afterSeq } = options;

  await states.get(conversationId)?.queue;

  const opened = await openForRead(files.log);
  if (!opened) return empty;
  const { fh, size } = opened;
  try {
    const budget: Budget = { left: WORK_LOG_SCAN_BUDGET_BYTES };

    if (afterSeq === undefined) {
      const newest: WorkLogEntry[] = [];
      const end = await scanBackward(fh, size, budget, (line) => {
        const entry = parseEntry(line);
        if (entry) newest.push(entry);
        return newest.length <= limit; // one extra tells us whether more exist
      });
      if (end === 'budget') warnBudget(conversationId, 'latest', newest.length);
      return { entries: newest.slice(0, limit).reverse(), hasMore: newest.length > limit || end === 'budget' };
    }

    // Reconnect fast path: a short backward scan usually reaches afterSeq.
    const fast: Budget = { left: FAST_PATH_BUDGET_BYTES };
    const newest: WorkLogEntry[] = [];
    const scan = { reachedAfterSeq: false };
    const fastEnd = await scanBackward(fh, size, fast, (line) => {
      const entry = parseEntry(line);
      if (!entry) return true;
      if (entry.seq <= afterSeq) {
        scan.reachedAfterSeq = true;
        return false;
      }
      newest.push(entry);
      return newest.length <= limit;
    });
    budget.left -= FAST_PATH_BUDGET_BYTES - fast.left;
    if (scan.reachedAfterSeq || fastEnd === 'done') {
      // Every entry after afterSeq was collected.
      const all = newest.reverse();
      return { entries: all.slice(0, limit), hasMore: all.length > limit };
    }

    // More than `limit` entries follow afterSeq (or the tail is junk): page
    // forward from its position.
    const start = await findPageStart(fh, size, afterSeq, budget);
    const page: WorkLogEntry[] = [];
    const end = await scanForward(fh, size, start, budget, (line) => {
      const entry = parseEntry(line);
      if (!entry || entry.seq <= afterSeq) return true;
      page.push(entry);
      return page.length <= limit;
    });
    if (end === 'budget') warnBudget(conversationId, 'afterSeq', page.length);
    return { entries: page.slice(0, limit), hasMore: page.length > limit || end === 'budget' };
  } finally {
    await fh.close().catch(() => {});
  }
}
