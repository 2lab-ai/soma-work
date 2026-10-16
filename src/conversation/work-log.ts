/**
 * Work log — the verbose, per-conversation stream of what the model is doing
 * (instructions, narration, tool calls, results, notices, errors). Slack only
 * shows the minimal surface; the standalone dashboard shows this log.
 *
 * Storage: `${DATA_DIR}/worklogs/<conversationId>.jsonl`, append-only, one
 * entry per line, written in `seq` order. `seq` is monotonic per conversation
 * and survives restarts: the first append in a process reads it back from the
 * file's tail.
 *
 * Every read is bounded. Nothing reads a whole log file: the writer's seed and
 * the "latest entries" read scan back from the end, and `afterSeq` pages find
 * their start with a binary search over byte offsets (lines are in seq order).
 *
 * Contract: .prd/10-agent-inbox-board-spec.md §3.3.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
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
   */
  hasMore: boolean;
}

/** Max characters kept per entry `text` (spec §3.3). */
export const WORK_LOG_TEXT_MAX = 4000;
/** Default (and API maximum) number of entries returned by a read. */
export const WORK_LOG_DEFAULT_LIMIT = 500;

/** Conversation ids are UUIDs; anything outside this set never touches the filesystem. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Read granularity. Entries are far smaller (text ≤ 4000 chars), so one chunk holds whole lines. */
const CHUNK_BYTES = 64 * 1024;
/** A "line" longer than this is not something this module wrote; the scan gives up. */
const MAX_LINE_BYTES = 1024 * 1024;
/** Idle per-conversation writer states kept warm (each costs one tail read to rebuild). */
const MAX_CACHED_STATES = 256;

interface ConversationLogState {
  /** Last seq on disk; null = not read from the file yet (or unknown after a failed write). */
  lastSeq: number | null;
  /** The file ends mid-line (torn write); the next line must start on a fresh one. */
  needsLeadingNewline: boolean;
  /** Serialized write chain for this file — appends never interleave. */
  queue: Promise<void>;
  /** Appends queued and not yet settled; a state is only evicted at 0. */
  pending: number;
}

const states = new Map<string, ConversationLogState>();
let dirReady: Promise<void> | null = null;
let _onAppended: ((conversationId: string, entry: WorkLogEntry) => void) | null = null;

class WorkLogScanError extends Error {}

function workLogDir(): string {
  return path.join(DATA_DIR, 'worklogs');
}

function workLogPath(conversationId: string): string | null {
  if (typeof conversationId !== 'string' || !SAFE_ID.test(conversationId)) return null;
  return path.join(workLogDir(), `${conversationId}.jsonl`);
}

function ensureDir(): Promise<void> {
  if (!dirReady) {
    dirReady = fs.promises
      .mkdir(workLogDir(), { recursive: true })
      .then(() => undefined)
      .catch((err) => {
        dirReady = null; // retry on the next append
        throw err;
      });
  }
  return dirReady;
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function parseEntry(line: Buffer): WorkLogEntry | null {
  try {
    const value = JSON.parse(line.toString('utf-8')) as Partial<WorkLogEntry> | null;
    if (!value || typeof value.seq !== 'number' || !Number.isFinite(value.seq)) return null;
    return value as WorkLogEntry;
  } catch {
    return null; // torn or corrupt line
  }
}

// ── Chunked line scanning ──

async function readExactly(fh: fs.promises.FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  // Files only grow, and every read stays below the size taken from stat().
  if (bytesRead !== length) throw new WorkLogScanError('work log shrank while being read');
  return buf;
}

/**
 * Feed lines to `onLine` from the end of the file towards the start; stop when
 * it returns false. The last segment counts as a line even without a trailing
 * newline (a fully written entry whose `\n` was lost is still an entry).
 */
async function scanBackward(
  fh: fs.promises.FileHandle,
  size: number,
  onLine: (line: Buffer) => boolean,
): Promise<void> {
  let pos = size;
  let carry: Buffer = Buffer.alloc(0); // start of a line that began before `pos`
  while (pos > 0) {
    const n = Math.min(CHUNK_BYTES, pos);
    pos -= n;
    const buf = Buffer.concat([await readExactly(fh, pos, n), carry]);
    let end = buf.length;
    let idx: number;
    while (end > 0 && (idx = buf.lastIndexOf(0x0a, end - 1)) !== -1) {
      const line = buf.subarray(idx + 1, end);
      if (line.length > 0 && !onLine(line)) return;
      end = idx;
    }
    carry = buf.subarray(0, end);
    if (carry.length > MAX_LINE_BYTES) throw new WorkLogScanError('work log line exceeds the scan limit');
  }
  if (carry.length > 0) onLine(carry);
}

/** Feed lines to `onLine` from byte offset `from` (a line start) forwards; stop when it returns false. */
async function scanForward(
  fh: fs.promises.FileHandle,
  size: number,
  from: number,
  onLine: (line: Buffer) => boolean,
): Promise<void> {
  let pos = from;
  let carry: Buffer = Buffer.alloc(0);
  while (pos < size) {
    const n = Math.min(CHUNK_BYTES, size - pos);
    const chunk = await readExactly(fh, pos, n);
    pos += n;
    const buf = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
    let start = 0;
    let idx: number;
    while ((idx = buf.indexOf(0x0a, start)) !== -1) {
      const line = buf.subarray(start, idx);
      start = idx + 1;
      if (line.length > 0 && !onLine(line)) return;
    }
    carry = buf.subarray(start);
    if (carry.length > MAX_LINE_BYTES) throw new WorkLogScanError('work log line exceeds the scan limit');
  }
  if (carry.length > 0) onLine(carry);
}

/** First parseable entry that starts after byte `at`, read from one chunk. */
async function probeAfter(
  fh: fs.promises.FileHandle,
  size: number,
  at: number,
): Promise<{ start: number; seq: number } | null> {
  const n = Math.min(CHUNK_BYTES, size - at);
  if (n <= 0) return null;
  const buf = await readExactly(fh, at, n);
  let start = buf.indexOf(0x0a);
  while (start !== -1) {
    const next = buf.indexOf(0x0a, start + 1);
    const lineEnd = next !== -1 ? next : at + n >= size ? buf.length : -1;
    if (lineEnd === -1) return null; // line runs past this chunk
    const entry = parseEntry(buf.subarray(start + 1, lineEnd));
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
 */
async function findPageStart(fh: fs.promises.FileHandle, size: number, afterSeq: number): Promise<number> {
  let lo = 0;
  let hi = size;
  while (hi - lo > CHUNK_BYTES) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const probe = await probeAfter(fh, size, mid);
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

/**
 * Read the writer's starting point from the file's tail: the seq of the last
 * parseable line and whether the file ends mid-line. Only ENOENT means "no
 * log yet"; any other failure throws so the caller never guesses a seq.
 */
async function readSeed(filePath: string): Promise<{ lastSeq: number; needsLeadingNewline: boolean }> {
  const opened = await openForRead(filePath);
  if (!opened) return { lastSeq: 0, needsLeadingNewline: false };
  const { fh, size } = opened;
  try {
    if (size === 0) return { lastSeq: 0, needsLeadingNewline: false };
    const lastByte = await readExactly(fh, size - 1, 1);
    let lastSeq = 0;
    await scanBackward(fh, size, (line) => {
      const entry = parseEntry(line);
      if (!entry) return true; // torn/corrupt — keep looking further back
      lastSeq = entry.seq;
      return false;
    });
    return { lastSeq, needsLeadingNewline: lastByte[0] !== 0x0a };
  } finally {
    await fh.close().catch(() => {});
  }
}

function clampText(text: string): string {
  if (text.length <= WORK_LOG_TEXT_MAX) return text;
  let end = WORK_LOG_TEXT_MAX - 1; // leave room for the ellipsis
  const lastKept = text.charCodeAt(end - 1);
  if (lastKept >= 0xd800 && lastKept <= 0xdbff) end -= 1; // never split a surrogate pair
  return `${text.slice(0, end)}…`;
}

/** Get (or create) a conversation's writer state, keeping the map an LRU of bounded size. */
function touchState(conversationId: string): ConversationLogState {
  let state = states.get(conversationId);
  if (state) {
    states.delete(conversationId);
  } else {
    state = { lastSeq: null, needsLeadingNewline: false, queue: Promise.resolve(), pending: 0 };
  }
  states.set(conversationId, state);
  if (states.size > MAX_CACHED_STATES) {
    for (const [id, s] of states) {
      if (states.size <= MAX_CACHED_STATES) break;
      // Idle states hold nothing the file does not; busy ones must keep their queue.
      if (s.pending === 0 && id !== conversationId) states.delete(id);
    }
  }
  return state;
}

/**
 * Register the single in-process listener fired after every persisted append
 * (the dashboard WS broadcast). Mirrors recorder's `setOnTurnRecordedCallback`.
 */
export function setOnWorkLogAppendedCallback(fn: ((conversationId: string, entry: WorkLogEntry) => void) | null): void {
  _onAppended = fn;
}

type EntryFields = Omit<WorkLogEntry, 'seq'>;

async function writeEntry(
  conversationId: string,
  filePath: string,
  state: ConversationLogState,
  fields: EntryFields,
): Promise<WorkLogEntry> {
  if (state.lastSeq === null) {
    try {
      const seed = await readSeed(filePath);
      state.lastSeq = seed.lastSeq;
      state.needsLeadingNewline = seed.needsLeadingNewline;
    } catch (error) {
      // State stays unseeded, so the next append reads the tail again.
      logger.warn('Work log seed failed; entry dropped', { conversationId, error });
      throw error;
    }
  }

  const entry: WorkLogEntry = { seq: state.lastSeq + 1, ...fields };
  const line = `${state.needsLeadingNewline ? '\n' : ''}${JSON.stringify(entry)}\n`;
  try {
    await ensureDir();
    await fs.promises.appendFile(filePath, line, 'utf-8');
  } catch (error) {
    // The file may now hold nothing, part, or all of the line. Forget the seed
    // (the newline flag is left as it was) so the next append re-reads the tail
    // instead of guessing — that gets both seq and newline right in every case.
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
 * stored entry once it is on disk (the listener has fired by then); rejects —
 * already logged — when the id is unsafe, the seed read fails, or the write fails.
 */
export function appendWorkLog(conversationId: string, input: WorkLogInput): Promise<WorkLogEntry> {
  const filePath = workLogPath(conversationId);
  if (!filePath) {
    logger.warn('Rejected work log entry for an unsafe conversationId', { conversationId });
    return Promise.reject(new Error('Invalid work log conversationId'));
  }

  const fields: EntryFields = {
    ts: typeof input.ts === 'number' && Number.isFinite(input.ts) ? input.ts : Date.now(),
    kind: input.kind,
    text: clampText(String(input.text ?? '')),
  };
  if (input.tool !== undefined) fields.tool = input.tool;
  if (input.ok !== undefined) fields.ok = input.ok;
  if (input.turnId !== undefined) fields.turnId = input.turnId;

  const state = touchState(conversationId);
  state.pending += 1;
  const result = state.queue
    .then(() => writeEntry(conversationId, filePath, state, fields))
    .finally(() => {
      state.pending -= 1;
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

/**
 * Without `afterSeq`: the latest `limit` entries (`hasMore` = older exist).
 * With `afterSeq`: the first `limit` entries with `seq > afterSeq`, for forward
 * paging (`hasMore` = newer exist past this page). Waits for this process's
 * pending writes to the same file first. Unknown or unsafe ids read as empty.
 */
export async function readWorkLog(
  conversationId: string,
  options: { afterSeq?: number; limit?: number } = {},
): Promise<WorkLogPage> {
  const empty: WorkLogPage = { entries: [], hasMore: false };
  const filePath = workLogPath(conversationId);
  if (!filePath) return empty;
  const limit = options.limit ?? WORK_LOG_DEFAULT_LIMIT;
  if (!(limit > 0)) return empty;
  const { afterSeq } = options;

  await states.get(conversationId)?.queue;

  const opened = await openForRead(filePath);
  if (!opened) return empty;
  const { fh, size } = opened;
  try {
    // Newest first. Without afterSeq this is the answer; with it, the common
    // "reconnect near the tail" case ends here too.
    const newest: WorkLogEntry[] = [];
    const scan = { reachedAfterSeq: false };
    await scanBackward(fh, size, (line) => {
      const entry = parseEntry(line);
      if (!entry) return true;
      if (afterSeq !== undefined && entry.seq <= afterSeq) {
        scan.reachedAfterSeq = true;
        return false;
      }
      newest.push(entry);
      return newest.length <= limit; // one extra tells us whether more exist
    });
    // Collecting stops at limit + 1, so with afterSeq a finished scan holds the
    // whole page and hasMore is false; without it hasMore means "older exist".
    if (afterSeq === undefined || scan.reachedAfterSeq || newest.length <= limit) {
      return { entries: newest.slice(0, limit).reverse(), hasMore: newest.length > limit };
    }

    // More than `limit` entries follow afterSeq: page forward from its position.
    const start = await findPageStart(fh, size, afterSeq);
    const page: WorkLogEntry[] = [];
    await scanForward(fh, size, start, (line) => {
      const entry = parseEntry(line);
      if (!entry || entry.seq <= afterSeq) return true;
      page.push(entry);
      return page.length <= limit;
    });
    return { entries: page.slice(0, limit), hasMore: page.length > limit };
  } finally {
    await fh.close().catch(() => {});
  }
}
