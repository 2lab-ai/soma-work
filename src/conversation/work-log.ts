/**
 * Work log — the verbose, per-conversation stream of what the model is doing
 * (instructions, narration, tool calls, results, notices, errors). Slack only
 * shows the minimal surface; the standalone dashboard shows this log.
 *
 * Storage: `${DATA_DIR}/worklogs/<conversationId>.jsonl`, append-only, one
 * entry per line, written in `seq` order.
 *
 * Durability: an entry is published — `appendWorkLog` resolves and the
 * dashboard broadcast fires — only after its line is fdatasync'd and every
 * directory whose entries this module changed (mkdir, log create, sidecar
 * rename, quarantine rename) has been fsync'd since. Those directory
 * obligations live in module state until a sync succeeds, so a failed one is
 * retried before the next publish instead of being forgotten. Cost: one
 * fdatasync per entry, plus a directory fsync only after such a change. Entries
 * are per tool event / narration segment, a low rate, and the write is off the
 * turn's path (the stream executor does not await it).
 *
 * seq: monotonic per conversation and never reused once published. The ONLY
 * proof of an upper bound is the durable reservation: the sidecar `<id>.seq`
 * reserves seqs in blocks and is written and synced before any seq in its
 * block is used, so every seq ever used is ≤ the live reservation. The log's
 * tail is never a bound — its bytes can be damaged or truncated after they
 * were published — so a seed never derives the cursor from it:
 *   - a fresh seed (first append in a process, or after eviction) resumes at
 *     the live reservation, leaving a hole of up to one block;
 *   - within a process the cursor only moves forward: a failed append burns
 *     its seq, and only the trailing-newline state is re-read.
 * The tail is still read, for the trailing newline and to decide quarantine:
 * at a seed whose reservation comes from the live copy, a tail unreadable
 * within the scan budget is moved to `<id>.jsonl.corrupt-<ms>` and a fresh log
 * continues above the reservation.
 * Trade-off: quarantine moves the WHOLE old log, including entries published
 * before the damage, so the API no longer serves them (they stay on disk in
 * the `.corrupt-` file for an operator). It only happens when nothing in the
 * last 8 MB parses — i.e. after external damage — and in exchange every later
 * read and seed stays bounded instead of re-scanning the junk.
 * Every reservation write leaves `.bak` at most one block behind live; the
 * first one of a conversation writes both copies, so even a young conversation
 * whose live copy is damaged can recover. If the live copy is lost, `.bak` (the
 * previous reservation) is trusted only together with a readable entry, and
 * both copies are rewritten before anything is published. Anything else has no
 * provable bound and fails closed (appends rejected, one error log) — see
 * readSeed.
 *
 * Gaps — two kinds, different for a client:
 *   - landed but unpublished: the line reached disk but its append failed
 *     afterwards (e.g. fdatasync or the directory sync threw), so it was never
 *     broadcast. It is a normal entry for readers — backfill it with
 *     `readWorkLog({ afterSeq })`.
 *   - holes: seqs skipped on purpose — every fresh seed (resumes at the
 *     reservation), a failed append that never landed, a quarantine, a backup
 *     recovery. No entry will ever have those seqs; a client must not wait for
 *     them.
 *
 * Reads: every scan has a byte budget (WORK_LOG_SCAN_BUDGET_BYTES). The latest
 * window and the seed scan back from the end; `afterSeq` pages first try a
 * short backward scan (the reconnect case), else binary-search byte offsets
 * (lines are in seq order) and read forward. `hasMore` follows what the read
 * could prove, not merely whether it hit the budget (see WorkLogPage.hasMore).
 * When junk sits between `afterSeq` and the tail, the entries the backward scan
 * found are returned as soon as they provably start the page — the oldest one
 * is `afterSeq + 1`, or the forward scan reaches them — so paging moves past
 * the junk. Otherwise a junk region wider than the remaining budget between the
 * two keeps that page empty (`hasMore: true`) rather than risk skipping entries
 * inside it; the latest window (no `afterSeq`) still shows new entries.
 *
 * Line contract: a line longer than WORK_LOG_MAX_LINE_BYTES is never an entry —
 * readers skip it whatever its chunk alignment, and the writer refuses to
 * produce one (`text` ≤ 4000 chars, `tool`/`turnId` ≤ 200 chars, `raw` cut to
 * fit — see below).
 *
 * Raw: an entry may carry `raw`, the full content behind its one-line `text`
 * (a tool call's whole input, a tool result's output, or the uncut text when
 * `text` was over its cap). It is stored in the same line, cut to
 * WORK_LOG_RAW_MAX_BYTES UTF-8 bytes and then further until the line fits the
 * line limit, so raw can never cost an entry. `rawBytes` is the byte length of
 * the ORIGINAL; `rawTruncated: true` marks a cut. `raw` itself is served only by
 * readWorkLogRaw — list pages, the appended callback (the dashboard broadcast)
 * and appendWorkLog's result carry `rawBytes`/`rawTruncated` instead. Lines
 * with a large raw are longer than a read chunk, so a list read fits fewer of
 * them into its byte budget.
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
  /** Full content behind `text` (tool input / result); stored, served only by readWorkLogRaw. */
  raw?: string;
}
/** An entry as pages and the broadcast carry it: `raw` is replaced by its size. */
export interface WorkLogEntry extends Omit<WorkLogInput, 'raw'> {
  seq: number;
  ts: number;
  /** UTF-8 byte length of the original raw; present iff the entry has one. */
  rawBytes?: number;
  /** The stored raw is cut short of the original. */
  rawTruncated?: true;
}
/** An entry as stored on disk. */
type StoredWorkLogEntry = WorkLogEntry & { raw?: string };

/** readWorkLogRaw's answer. */
export interface WorkLogRaw {
  seq: number;
  raw: string;
  rawBytes: number;
  rawTruncated: boolean;
}

export interface WorkLogPage {
  entries: WorkLogEntry[];
  /**
   * Without `afterSeq`: older entries exist before the returned (latest)
   * window — or the backward scan stopped at its byte budget, so there may be.
   * With `afterSeq`: more entries than `limit` follow afterSeq — or the read
   * stopped at its budget before it could prove the page complete, so there
   * may be (the page can then be short or empty). It is false whenever the
   * page is provably every entry after afterSeq, even if a scan hit its budget
   * on the way (the backward scan reached afterSeq, the start of the file, or
   * an entry with seq afterSeq + 1).
   */
  hasMore: boolean;
}

/** Max characters kept per entry `text` (spec §3.3). */
export const WORK_LOG_TEXT_MAX = 4000;
/** Max characters kept for `tool` and `turnId`. */
export const WORK_LOG_FIELD_MAX = 200;
/** Max UTF-8 bytes kept per entry `raw` (before the line-fit cut). */
export const WORK_LOG_RAW_MAX_BYTES = 256 * 1024;
/** Default (and API maximum) number of entries returned by a read. */
export const WORK_LOG_DEFAULT_LIMIT = 500;
/** Read granularity. */
export const WORK_LOG_READ_CHUNK_BYTES = 64 * 1024;
/** A line longer than this (excluding its `\n`) is never an entry. */
export const WORK_LOG_MAX_LINE_BYTES = 1024 * 1024;
/** An entry carrying raw is cut to this many JSON bytes before `seq` is added (room for it and a newline). */
const RAW_LINE_FIT_BYTES = WORK_LOG_MAX_LINE_BYTES - 4096;
/** Most bytes any single read or seed scan may read. */
export const WORK_LOG_SCAN_BUDGET_BYTES = 8 * 1024 * 1024;
/** seqs reserved per sidecar write. */
export const WORK_LOG_SEQ_RESERVE_BLOCK = 1000;
/** The block every reservation path reads; always WORK_LOG_SEQ_RESERVE_BLOCK outside tests. */
let reserveBlock = WORK_LOG_SEQ_RESERVE_BLOCK;
/** Idle per-conversation writer states kept warm (each costs one tail read to rebuild). */
export const WORK_LOG_MAX_CACHED_STATES = 256;
/** Share of the budget an `afterSeq` read spends on the backward reconnect fast path. */
const FAST_PATH_BUDGET_BYTES = WORK_LOG_SCAN_BUDGET_BYTES / 4;

/** Conversation ids are UUIDs; anything outside this set never touches the filesystem. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const EMPTY = Buffer.alloc(0);

interface ConversationLogState {
  /** Last seq used (published or attempted); null = not seeded yet. Only ever moves forward. */
  lastSeq: number | null;
  /** Highest seq the durable sidecar allows without another reservation. */
  reservedSeq: number;
  /** The file ends mid-line (torn write); the next line must start on a fresh one. */
  needsLeadingNewline: boolean;
  /** A write failed: whether the file now ends mid-line is unknown until re-read. */
  tailUnknown: boolean;
  /** The next write may create the file, which puts a sync obligation on its directory. */
  fileMayBeNew: boolean;
  /**
   * Set while the conversation has no provable seq upper bound: the file
   * fingerprint at that verdict. Appends are refused without re-scanning until
   * the files change.
   */
  unboundedAt: string | null;
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
/**
 * Directories whose entries changed and have not been fsync'd since, each with
 * the counter value of its latest change. A sync clears an obligation only if
 * no newer change arrived while it ran.
 */
const dirSyncDue = new Map<string, number>();
let dirChangeCounter = 0;
/** Conversations whose fail-closed verdict was already logged at error level (once each). */
const unboundedLogged = new Set<string>();
const MAX_UNBOUNDED_LOGGED = 1024;
let _onAppended: ((conversationId: string, entry: WorkLogEntry) => void) | null = null;

class WorkLogScanError extends Error {}

/**
 * No seq upper bound can be proven for a conversation: its reservation is
 * backup-only or absent and its log has no readable entry. Publishing any seq
 * could reuse one a client already holds, so appends are refused (fail closed).
 */
export class WorkLogUnboundedError extends Error {
  constructor(readonly detail: Record<string, unknown>) {
    super('Work log has no provable seq upper bound; refusing to publish');
    this.name = 'WorkLogUnboundedError';
  }
}

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

/** Record that an entry in `dir` was created or renamed; call after the change happened. */
function noteDirChanged(dir: string): void {
  dirChangeCounter += 1;
  dirSyncDue.set(path.resolve(dir), dirChangeCounter);
}

/**
 * fsync every directory with an outstanding obligation. Throws on the first
 * failure and keeps that obligation (and any not yet reached) for the next call.
 */
async function syncDueDirs(): Promise<void> {
  for (const [dir, mark] of Array.from(dirSyncDue)) {
    await syncDir(dir);
    if (dirSyncDue.get(dir) === mark) dirSyncDue.delete(dir);
  }
}

function ensureDir(): Promise<void> {
  if (!dirReady) {
    const dir = path.resolve(workLogDir());
    dirReady = fs.promises
      .mkdir(dir, { recursive: true })
      .then((created) => {
        if (!created) return;
        // Every directory mkdir created is a new entry in its parent. The
        // obligations outlive this promise, so a failed sync is retried even
        // though the next mkdir finds everything in place.
        const top = path.resolve(created);
        for (let p = dir; ; p = path.dirname(p)) {
          noteDirChanged(path.dirname(p));
          if (p === top || p === path.dirname(p)) break;
        }
      })
      .catch((err) => {
        dirReady = null; // retry on the next append
        throw err;
      });
  }
  return dirReady;
}

function parseEntry(line: Buffer): StoredWorkLogEntry | null {
  // Shape check first, so a long run of junk lines costs no JSON.parse throws.
  if (line[0] !== 0x7b) return null; // '{'
  let last = line.length - 1;
  while (last > 0 && (line[last] === 0x0d || line[last] === 0x20 || line[last] === 0x09)) last--; // CRLF / padding
  if (line[last] !== 0x7d) return null; // '}'
  try {
    const value = JSON.parse(line.toString('utf-8')) as Partial<StoredWorkLogEntry> | null;
    if (!value || typeof value.seq !== 'number' || !Number.isFinite(value.seq)) return null;
    return value as StoredWorkLogEntry;
  } catch {
    return null; // torn or corrupt line
  }
}

/** The entry as pages and the broadcast carry it: without `raw` (its size stays). */
function publicEntry(entry: StoredWorkLogEntry): WorkLogEntry {
  if (!('raw' in entry)) return entry;
  const { raw: _raw, ...rest } = entry;
  return rest;
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
 *
 * `cover.offset` is set to the lowest offset from which every line up to the
 * end of the file has been examined (passed to `onLine`, or known to be an
 * over-limit non-entry).
 */
async function scanBackward(
  fh: fs.promises.FileHandle,
  size: number,
  budget: Budget,
  onLine: (line: Buffer) => boolean,
  cover: { offset: number } = { offset: size },
): Promise<ScanEnd> {
  let pos = size;
  let carry: Buffer = EMPTY; // end part of a line that began before `pos`
  let dropping = false; // the line ending at the next newline found is over the limit
  while (pos > 0) {
    const n = Math.min(WORK_LOG_READ_CHUNK_BYTES, pos, budget.left);
    if (n <= 0) {
      cover.offset = dropping ? pos : pos + carry.length;
      return 'budget';
    }
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
        if (len > 0 && len <= WORK_LOG_MAX_LINE_BYTES && !onLine(buf.subarray(idx + 1, end))) {
          cover.offset = pos + idx + 1; // buf starts at file offset `pos`
          return 'stopped';
        }
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
  cover.offset = 0;
  return 'done';
}

/**
 * Feed lines to `onLine` from byte offset `from` (a line start) forwards; same
 * rules as scanBackward. `cover.offset` is set to the highest offset up to which
 * every line from `from` on has been examined.
 */
async function scanForward(
  fh: fs.promises.FileHandle,
  size: number,
  from: number,
  budget: Budget,
  onLine: (line: Buffer) => boolean,
  cover: { offset: number } = { offset: from },
): Promise<ScanEnd> {
  let pos = from;
  let carry: Buffer = EMPTY; // start part of a line that continues past `pos`
  let dropping = false; // the bytes up to the next newline belong to an over-limit line
  while (pos < size) {
    const n = Math.min(WORK_LOG_READ_CHUNK_BYTES, size - pos, budget.left);
    if (n <= 0) {
      cover.offset = dropping ? pos : pos - carry.length;
      return 'budget';
    }
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
        if (len > 0 && len <= WORK_LOG_MAX_LINE_BYTES && !onLine(buf.subarray(start, idx))) {
          cover.offset = pos - buf.length + idx; // buf ends at file offset `pos`
          return 'stopped';
        }
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
  cover.offset = size;
  return 'done';
}

/** Enough bytes to hold `{"seq":<16 digits>,` — the start of every line the writer produces. */
const SEQ_PREFIX_BYTES = 32;
const SEQ_PREFIX = /^\{"seq":(\d{1,16}),/;

/** The seq a line's first bytes name, when they have the writer's `{"seq":N,` shape. */
function seqFromPrefix(head: Buffer): number | null {
  const match = SEQ_PREFIX.exec(head.subarray(0, SEQ_PREFIX_BYTES).toString('latin1'));
  if (!match) return null;
  const seq = Number(match[1]);
  return Number.isSafeInteger(seq) ? seq : null;
}

/**
 * The first entry that starts after byte `at`, with its seq. One chunk is read
 * and its complete lines parsed. Entries carrying a large `raw` are longer than
 * a chunk, so: when `at` falls in such a line the read goes on to its end (at
 * most the line limit; past that the line is not an entry and the probe
 * misses), and a line that runs past what was read is placed by its first
 * bytes — the writer always starts a line with `{"seq":N,` — instead of being
 * read whole. That is positional evidence only: lines are in seq order
 * whatever their state (whole, torn, over the limit), and the reader parses
 * every line it returns.
 */
async function probeAfter(
  fh: fs.promises.FileHandle,
  size: number,
  at: number,
  budget: Budget,
): Promise<{ start: number; seq: number } | null | 'budget'> {
  if (at >= size) return null;
  if (budget.left <= 0) return 'budget';
  let pos = at; // next byte to read
  const read = async (max: number): Promise<Buffer | null> => {
    const n = Math.min(max, size - pos, budget.left);
    if (n <= 0) return null;
    budget.left -= n;
    const chunk = await readExactly(fh, pos, n);
    pos += n;
    return chunk;
  };

  // Skip the rest of the line `at` falls in.
  let rest: Buffer | null = null; // what was read after that line's newline
  while (rest === null) {
    if (pos - at > WORK_LOG_MAX_LINE_BYTES) return null;
    const chunk = await read(WORK_LOG_READ_CHUNK_BYTES);
    if (!chunk) return null; // end of file (no line starts after `at`) or out of budget
    const nl = chunk.indexOf(0x0a);
    if (nl !== -1) rest = chunk.subarray(nl + 1);
  }
  const restStart = pos - rest.length;

  let from = 0;
  for (let nl = rest.indexOf(0x0a); nl !== -1; nl = rest.indexOf(0x0a, from)) {
    const entry = nl > from ? parseEntry(rest.subarray(from, nl)) : null;
    if (entry) return { start: restStart + from, seq: entry.seq };
    from = nl + 1;
  }

  // The line at `from` runs past what was read (or is the file's last line).
  let tail = rest.subarray(from);
  if (pos < size && tail.length < SEQ_PREFIX_BYTES) {
    const more = await read(SEQ_PREFIX_BYTES - tail.length);
    if (more) tail = Buffer.concat([tail, more]);
  }
  const nl = tail.indexOf(0x0a);
  if (nl !== -1 || pos >= size) {
    // It ended after all: a whole line.
    const whole = nl !== -1 ? tail.subarray(0, nl) : tail;
    const entry = whole.length > 0 ? parseEntry(whole) : null;
    return entry ? { start: restStart + from, seq: entry.seq } : null;
  }
  const seq = seqFromPrefix(tail);
  return seq === null ? null : { start: restStart + from, seq };
}

/**
 * Byte offset of a line start such that every line before it has
 * `seq <= afterSeq`. Lines are in seq order, so this is a binary search on byte
 * offsets. Only `lo` moves on evidence (a line ≤ afterSeq: parsed, or placed by
 * its `{"seq":N,` prefix — see probeAfter); a missed or unparseable probe only
 * lowers `hi`, which costs scanning, never correctness. Out of budget, the
 * current `lo` is still a valid (if early) start.
 *
 * The search spends at most half of `budget`: probes read through long lines,
 * and the forward read from `lo` must keep room for the lines between it and
 * the page (two at the line limit, in the worst case).
 */
async function findPageStart(
  fh: fs.promises.FileHandle,
  size: number,
  afterSeq: number,
  budget: Budget,
): Promise<number> {
  const search: Budget = { left: Math.floor(budget.left / 2) };
  const granted = search.left;
  let lo = 0;
  let hi = size;
  while (hi - lo > WORK_LOG_READ_CHUNK_BYTES) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const probe = await probeAfter(fh, size, mid, search);
    if (probe === 'budget') break;
    if (probe && probe.seq <= afterSeq) lo = probe.start;
    else hi = mid;
  }
  budget.left -= granted - search.left;
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
 * Where a reservation came from. Only `live` is a proven upper bound: every
 * live value is written durably before any seq it covers is used. `backup` is
 * the PREVIOUS live value (atomicWriteJson promotes a valid live copy before
 * writing a new one, and writeReservation re-writes when it could not), so it
 * may be up to one block behind what was used.
 */
type ReservationSource = 'live' | 'backup';
interface Reservation {
  seq: number;
  source: ReservationSource;
}

function readReservation(sidecarPath: string): Reservation | null {
  // Shared state-store loader (rules/config.md §4): `.bak` fallback with a WARN,
  // and a throw — never a silent 0 — when both copies are unusable. It calls
  // `warn` in exactly one place, when it serves the `.bak` instead of the live
  // file (packages/common/src/atomic-json.ts, readJsonWithBackup), which is how
  // the provenance is told apart without changing the shared loader.
  let servedFromBackup = false;
  let value: number | undefined;
  try {
    value = readJsonWithBackup(
      sidecarPath,
      (raw) => {
        const seq = (raw as { reservedSeq?: unknown } | null)?.reservedSeq;
        if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) {
          throw new Error('reservedSeq must be a non-negative integer');
        }
        return seq;
      },
      {
        warn: (message, detail) => {
          servedFromBackup = true;
          logger.warn(message, detail);
        },
      },
    );
  } catch (error) {
    // Both copies unusable. Only when that is their CONTENT (every existing copy
    // was read and is invalid JSON or the wrong schema: the loader's
    // ATOMIC_JSON_UNUSABLE) does no bound exist until an operator repairs them:
    // the fail-closed verdict (one error log, cached by file fingerprint).
    // Anything else — a failed READ (ATOMIC_JSON_UNREADABLE), or an error the
    // loader did not classify — may be transient, so it stays a plain seed
    // error, retried on the next append. The code, not the message, decides:
    // the message embeds parser output, which can quote file content.
    if ((error as { code?: unknown } | null)?.code !== 'ATOMIC_JSON_UNUSABLE') throw error;
    throw new WorkLogUnboundedError({ sidecarPath, sidecar: (error as Error).message });
  }
  if (value === undefined) return null;
  return { seq: value, source: servedFromBackup ? 'backup' : 'live' };
}

/**
 * The step invariant every reservation write must keep: the new live value is
 * never below the one it replaces and at most one block above it. `.bak` holds
 * the replaced live value when that copy was valid; atomicWriteJson keeps the
 * OLD `.bak` when the live copy is missing or invalid at write time, and
 * writeReservation then writes once more so `.bak` is promoted anyway. Together
 * that keeps `.bak` at most one block behind live — the premise of the backup
 * recovery in readSeed. A violating write is refused (error log + throw) before
 * anything is written.
 */
function assertReservationStep(sidecarPath: string, previous: number, next: number): void {
  if (next >= previous && next - previous <= reserveBlock) return;
  logger.error('Work log reservation step refused: it would leave .bak more than one block behind', {
    sidecarPath,
    previous,
    next,
    block: reserveBlock,
  });
  throw new Error(`Work log reservation step ${previous} -> ${next} breaks the one-block invariant`);
}

async function writeReservation(sidecarPath: string, previous: number, reservedSeq: number): Promise<void> {
  assertReservationStep(sidecarPath, previous, reservedSeq);
  // atomicWriteJson promotes the old live copy to `.bak` only if it is valid:
  // it returns silently for a missing live copy and warns ("keeping existing
  // backup") for an invalid one (promotePreviousToBackup). Either way the stale
  // `.bak` would survive under the new reservation, so write once more — the
  // second write promotes the first — as rewriteBothReservations does.
  // "Valid" here means exactly `previous`, the value this writer last made
  // durable: anything else in the live copy (a stale reservation, the wrong
  // schema) was not written by this step's predecessor, and promoting it would
  // put `.bak` an unknown distance behind live.
  let liveWasMissing = false;
  try {
    await fs.promises.stat(sidecarPath);
  } catch (error) {
    if (!isEnoent(error)) throw error;
    liveWasMissing = true;
  }
  let promotionSkipped = false;
  const warn = (message: string, detail?: unknown) => {
    promotionSkipped = true;
    logger.warn(message, detail);
  };
  // Shared atomic writer (temp → fsync → rename); it leaves the directory
  // unsynced, and the rename must survive power loss for the reservation to
  // bound every seq used after it — so sync it now, not just before a publish.
  atomicWriteJson(
    sidecarPath,
    { reservedSeq },
    {
      validatePrevious: (raw) => (raw as { reservedSeq?: unknown } | null)?.reservedSeq === previous,
      warn,
    },
  );
  if (liveWasMissing || promotionSkipped) {
    atomicWriteJson(sidecarPath, { reservedSeq }, { warn: (message, detail) => logger.warn(message, detail) });
  }
  noteDirChanged(path.dirname(sidecarPath));
  await syncDueDirs();
}

/**
 * Test hook: shrink the reservation block so block-boundary scenarios need tens
 * of fdatasyncs instead of thousands. Call with no argument to restore the
 * production value.
 */
export function _setWorkLogReserveBlockForTests(block: number = WORK_LOG_SEQ_RESERVE_BLOCK): void {
  if (!Number.isSafeInteger(block) || block < 1) throw new Error('reserve block must be a positive integer');
  reserveBlock = block;
}

/** Test hook for the step invariant's refusal (no caller can reach it through the public API). */
export function _writeWorkLogReservationForTests(sidecarPath: string, previous: number, next: number): Promise<void> {
  return writeReservation(sidecarPath, previous, next);
}

/**
 * Make BOTH sidecar copies hold `floor` durably. Restores the invariant that
 * `.bak` is at most one block behind the live reservation after the live copy
 * was lost: atomicWriteJson only promotes a VALID live copy to `.bak`
 * (promotePreviousToBackup), so with an invalid or missing live copy one write
 * would leave the stale `.bak` in place under a new reservation. Writing twice
 * — the first makes the live copy valid, the second promotes it — needs no
 * change to packages/common. `previous` is the `.bak` value being superseded.
 */
async function rewriteBothReservations(sidecarPath: string, previous: number, floor: number): Promise<void> {
  assertReservationStep(sidecarPath, previous, floor);
  const warn = (message: string, detail?: unknown) => logger.warn(message, detail);
  atomicWriteJson(sidecarPath, { reservedSeq: floor }, { warn });
  atomicWriteJson(sidecarPath, { reservedSeq: floor }, { warn });
  noteDirChanged(path.dirname(sidecarPath));
  await syncDueDirs();
}

async function appendDurably(filePath: string, line: string, mayCreate: boolean): Promise<void> {
  const fh = await fs.promises.open(filePath, 'a');
  if (mayCreate) noteDirChanged(path.dirname(filePath)); // the open may just have created it
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
 * Read the writer's starting point and prove an upper bound on every seq ever
 * used for the conversation. Only ENOENT means "no log yet"; any other failure
 * throws so the caller never guesses a seq.
 *
 * The floor rests only on the reservation; the tail is read for the trailing
 * newline and the quarantine decision, never for the floor.
 *
 *   reservation  log                        next seq after
 *   live R       anything readable, ≤ R      R  (a hole of up to one block per fresh seed)
 *   live R       unreadable within budget    R, after quarantining the log
 *   live R       an entry T > R              refuse — the reservation is contradicted
 *   backup B     entry T ≤ B + block         B + block, after rewriting both copies to it
 *   backup B     entry T > B + block         refuse — no one-block step from B covers T
 *   none         missing or empty            0  (a conversation that never wrote)
 *   backup B     no readable entry           refuse — WorkLogUnboundedError
 *   none         non-empty                   refuse — a reservation always precedes the first
 *                                            append, so this only follows an operator deletion
 *
 * `backup B` is the previous reservation. Every reservation write raises live by
 * at most one block (assertReservationStep), so the lost live copy was at most
 * B + block, which therefore covers everything it reserved. It is not trusted
 * alone with no readable entry: the repeated-corruption case (live lost twice)
 * can leave `.bak` further behind.
 */
async function readSeed(conversationId: string, logPath: string, sidecarPath: string): Promise<Seed> {
  const reservation = readReservation(sidecarPath);

  const opened = await openForRead(logPath);
  let size = 0;
  let tailSeq: number | null = null;
  let end: ScanEnd = 'done';
  let lastByteIsNewline = true;
  if (opened) {
    const { fh } = opened;
    size = opened.size;
    try {
      if (size > 0) {
        lastByteIsNewline = (await readExactly(fh, size - 1, 1))[0] === 0x0a;
        const tail: { seq: number | null } = { seq: null };
        end = await scanBackward(fh, size, { left: WORK_LOG_SCAN_BUDGET_BYTES }, (line) => {
          const entry = parseEntry(line);
          if (!entry) return true; // torn/corrupt — keep looking further back
          tail.seq = entry.seq;
          return false;
        });
        tailSeq = tail.seq;
      }
    } finally {
      await fh.close().catch(() => {});
    }
  }
  const needsLeadingNewline = !lastByteIsNewline;

  if (reservation?.source === 'live' && !(tailSeq !== null && tailSeq > reservation.seq)) {
    const live = reservation.seq;
    if (tailSeq !== null || end !== 'budget') {
      return { lastSeq: live, reservedSeq: live, needsLeadingNewline, fileMayBeNew: !opened };
    }

    // The tail is unreadable within budget. The live reservation already bounds
    // every seq used, durably, so the log can be set aside and the fresh one
    // continue right above it. Rewriting the same floor first promotes it to
    // `.bak` too, so both copies hold it before the old evidence moves.
    await writeReservation(sidecarPath, live, live);
    const quarantined = `${logPath}.corrupt-${Date.now()}`;
    await fs.promises.rename(logPath, quarantined);
    noteDirChanged(path.dirname(logPath));
    await syncDueDirs();
    logger.warn('Work log tail unreadable within the scan budget; quarantined and continuing above it', {
      conversationId,
      quarantined,
      size,
      resumeAfterSeq: live,
    });
    return { lastSeq: live, reservedSeq: live, needsLeadingNewline: false, fileMayBeNew: true };
  }

  if (reservation?.source === 'backup' && tailSeq !== null && tailSeq <= reservation.seq + reserveBlock) {
    // The live copy is gone; `.bak` is the previous reservation, at most one block
    // behind it. Publish nothing until both copies durably hold a bound again.
    const bound = reservation.seq + reserveBlock;
    await rewriteBothReservations(sidecarPath, reservation.seq, bound);
    logger.warn('Work log reservation recovered from its backup; both copies rewritten', {
      conversationId,
      tailSeq,
      backupReservation: reservation.seq,
      resumeAfterSeq: bound,
    });
    return { lastSeq: bound, reservedSeq: bound, needsLeadingNewline, fileMayBeNew: false };
  }

  if (reservation === null && size === 0) {
    return { lastSeq: 0, reservedSeq: 0, needsLeadingNewline: false, fileMayBeNew: !opened };
  }

  throw new WorkLogUnboundedError({
    logPath,
    logSize: opened ? size : null,
    log: !opened
      ? 'missing'
      : size === 0
        ? 'empty'
        : tailSeq !== null
          ? `last readable entry ${tailSeq}`
          : end === 'budget'
            ? 'unreadable within the scan budget'
            : 'no parseable entry',
    sidecarPath,
    reservationSource: reservation?.source ?? 'none',
    reservation: reservation?.seq ?? null,
  });
}

/** Read whether the log currently ends mid-line (after a failed write left it unknown). */
async function endsMidLine(logPath: string): Promise<boolean> {
  const opened = await openForRead(logPath);
  if (!opened) return false;
  try {
    return opened.size > 0 && (await readExactly(opened.fh, opened.size - 1, 1))[0] !== 0x0a;
  } finally {
    await opened.fh.close().catch(() => {});
  }
}

/**
 * Identity + size + times of a conversation's files: unchanged = the fail-closed
 * verdict still holds. ino and ctime catch a same-size replacement whose mtime
 * was preserved (ctime cannot be set from user space).
 */
async function fileFingerprint(files: {
  log: string;
  sidecar: string;
}): Promise<{ key: string; sizes: Record<string, number | null> }> {
  const sizes: Record<string, number | null> = {};
  const parts: string[] = [];
  for (const file of [files.log, files.sidecar, `${files.sidecar}.bak`]) {
    try {
      const st = await fs.promises.stat(file);
      sizes[path.basename(file)] = st.size;
      parts.push(`${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`);
    } catch (error) {
      if (!isEnoent(error)) throw error;
      sizes[path.basename(file)] = null;
      parts.push('-');
    }
  }
  return { key: parts.join('|'), sizes };
}

function clampChars(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1; // leave room for the ellipsis
  const lastKept = text.charCodeAt(end - 1);
  if (lastKept >= 0xd800 && lastKept <= 0xdbff) end -= 1; // never split a surrogate pair
  return `${text.slice(0, end)}…`;
}

/**
 * Longest prefix of `text` that is at most `maxBytes` in UTF-8 and at most
 * `maxJsonBytes` once JSON.stringify escapes it (quotes excluded), never ending
 * inside a surrogate pair. UTF-8 sizes match Buffer.byteLength (a lone surrogate
 * encodes as the 3-byte U+FFFD); JSON sizes match JSON.stringify (`"` `\` and
 * \b \f \n \r \t take 2 bytes, other control characters and lone surrogates 6).
 */
function rawPrefix(text: string, maxBytes: number, maxJsonBytes: number): string {
  let bytes = 0;
  let jsonBytes = 0;
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    let size: number;
    let json: number;
    let units = 1;
    if (c < 0x20) {
      size = 1;
      json = c === 0x08 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d ? 2 : 6;
    } else if (c < 0x80) {
      size = 1;
      json = c === 0x22 || c === 0x5c ? 2 : 1;
    } else if (c < 0x800) {
      size = 2;
      json = 2;
    } else if (c < 0xd800 || c > 0xdfff) {
      size = 3;
      json = 3;
    } else if (c <= 0xdbff && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      size = 4;
      json = 4;
      units = 2;
    } else {
      size = 3; // lone surrogate
      json = 6;
    }
    if (bytes + size > maxBytes || jsonBytes + json > maxJsonBytes) break;
    bytes += size;
    jsonBytes += json;
    i += units;
  }
  return i === text.length ? text : text.slice(0, i);
}

/**
 * Add `raw` to an entry's fields, cut to WORK_LOG_RAW_MAX_BYTES and — JSON
 * escaping can grow a string up to 6× (control characters) — to what still
 * fits the line in RAW_LINE_FIT_BYTES, so raw never drops an entry. The cut is
 * computed exactly from the other fields' size; the loop only guards it.
 */
function withRaw(fields: EntryFields, raw: string): EntryFields {
  const rawBytes = Buffer.byteLength(raw, 'utf-8');
  // raw last, so the start of a stored line stays readable.
  const build = (kept: string): EntryFields => ({
    ...fields,
    rawBytes,
    ...(kept.length < raw.length ? { rawTruncated: true as const } : {}),
    raw: kept,
  });
  const room = RAW_LINE_FIT_BYTES - Buffer.byteLength(JSON.stringify(build('')), 'utf-8');
  let kept = rawPrefix(raw, WORK_LOG_RAW_MAX_BYTES, Math.max(0, room));
  for (;;) {
    const out = build(kept);
    const over = Buffer.byteLength(JSON.stringify(out), 'utf-8') - RAW_LINE_FIT_BYTES;
    if (over <= 0 || kept.length === 0) return out;
    // Every character takes at least as many JSON bytes as UTF-8 bytes, so
    // this cut always fits.
    kept = rawPrefix(kept, Math.max(0, Buffer.byteLength(kept, 'utf-8') - over), Number.POSITIVE_INFINITY);
  }
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
      tailUnknown: false,
      fileMayBeNew: true,
      unboundedAt: null,
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

type EntryFields = Omit<StoredWorkLogEntry, 'seq'>;

async function writeEntry(
  conversationId: string,
  files: { log: string; sidecar: string },
  state: ConversationLogState,
  fields: EntryFields,
): Promise<WorkLogEntry> {
  if (state.lastSeq === null) {
    // Taken before the seed reads anything, so a change made during it is seen next time.
    const fingerprint = await fileFingerprint(files);
    if (state.unboundedAt !== null && state.unboundedAt === fingerprint.key) {
      // Same files as at the fail-closed verdict: refuse without re-scanning.
      throw new WorkLogUnboundedError({ conversationId, unchangedSinceVerdict: true });
    }
    try {
      const seed = await readSeed(conversationId, files.log, files.sidecar);
      state.lastSeq = seed.lastSeq;
      state.reservedSeq = seed.reservedSeq;
      state.needsLeadingNewline = seed.needsLeadingNewline;
      state.fileMayBeNew = seed.fileMayBeNew;
      state.unboundedAt = null;
      unboundedLogged.delete(conversationId);
    } catch (error) {
      // State stays unseeded, so the next append reads the tail again.
      if (error instanceof WorkLogUnboundedError) {
        state.unboundedAt = fingerprint.key;
        if (!unboundedLogged.has(conversationId)) {
          if (unboundedLogged.size >= MAX_UNBOUNDED_LOGGED) {
            const oldest = unboundedLogged.values().next().value;
            if (oldest !== undefined) unboundedLogged.delete(oldest);
          }
          unboundedLogged.add(conversationId);
          logger.error('Work log refuses to publish: no provable seq upper bound for this conversation', {
            conversationId,
            ...error.detail,
            fileSizes: fingerprint.sizes,
          });
        }
      } else {
        logger.warn('Work log seed failed; entry dropped', { conversationId, error });
      }
      throw error;
    }
  }

  if (state.tailUnknown) {
    // An earlier write failed and may have left part of its line behind.
    try {
      state.needsLeadingNewline = await endsMidLine(files.log);
      state.tailUnknown = false;
    } catch (error) {
      logger.warn('Work log tail check failed; entry dropped', { conversationId, error });
      throw error;
    }
  }

  const entry: StoredWorkLogEntry = { seq: state.lastSeq + 1, ...fields };
  const json = JSON.stringify(entry);
  // Unreachable through the field caps and the raw line fit (withRaw leaves
  // 4 KiB for `seq`); a backstop so the writer can never produce a line every
  // reader would skip.
  if (Buffer.byteLength(json, 'utf-8') > WORK_LOG_MAX_LINE_BYTES) {
    logger.warn('Work log entry dropped: over the line size limit', { conversationId, seq: entry.seq });
    throw new Error('Work log entry exceeds the line size limit');
  }
  const line = `${state.needsLeadingNewline ? '\n' : ''}${json}\n`;
  let reachedLog = false;
  try {
    await ensureDir();
    // Reserve in one-block steps from the previous live value, each durable
    // before the next, so live never jumps more than a block past what `.bak`
    // will hold (see assertReservationStep). With seqs burned only inside a
    // reservation this is a single step; the loop keeps any larger gap in steps.
    while (entry.seq > state.reservedSeq) {
      const next = state.reservedSeq + reserveBlock;
      await writeReservation(files.sidecar, state.reservedSeq, next);
      state.reservedSeq = next;
    }
    reachedLog = true;
    await appendDurably(files.log, line, state.fileMayBeNew);
    // A possible create is now an obligation in dirSyncDue, which outlives this state.
    state.fileMayBeNew = false;
    // Before publishing: every outstanding directory obligation, including any
    // left by an earlier failed attempt of this or another conversation.
    await syncDueDirs();
  } catch (error) {
    if (reachedLog) {
      // The file may now hold nothing, part, or all of the line. Burn the seq —
      // it may be on disk (readable, never broadcast), so it is never reissued —
      // and re-read only whether the file ends mid-line before the next write.
      // It is inside the durable reservation, so nothing is re-derived from disk.
      state.lastSeq = entry.seq;
      state.tailUnknown = true;
    }
    // Otherwise the failure came before the log was touched (directory or
    // reservation write): the seq was never used, and burning it would let the
    // next reservation outrun the one-block step. The next append retries it.
    logger.error('Failed to persist work log entry', { conversationId, seq: entry.seq, error });
    throw error;
  }
  state.lastSeq = entry.seq;
  state.needsLeadingNewline = false;

  const published = publicEntry(entry);
  if (_onAppended) {
    try {
      _onAppended(conversationId, published);
    } catch (error) {
      logger.warn('Work log listener failed', { conversationId, error });
    }
  }
  return published;
}

/**
 * Append one entry. `ts` defaults to the call time; `seq` is assigned when the
 * entry reaches the front of this conversation's write queue. Resolves with the
 * stored entry — as pages carry it, `raw` replaced by `rawBytes` — once it is
 * durable (the listener has fired by then); rejects — already logged — when
 * the id is unsafe, the seed read fails, the entry is over the line limit, or
 * the write fails. A `text` over WORK_LOG_TEXT_MAX with no `raw` keeps its
 * full form as `raw`.
 */
export function appendWorkLog(conversationId: string, input: WorkLogInput): Promise<WorkLogEntry> {
  const files = workLogPaths(conversationId);
  if (!files) {
    logger.warn('Rejected work log entry for an unsafe conversationId', { conversationId });
    return Promise.reject(new Error('Invalid work log conversationId'));
  }

  const text = String(input.text ?? '');
  let fields: EntryFields = {
    ts: typeof input.ts === 'number' && Number.isFinite(input.ts) ? input.ts : Date.now(),
    kind: input.kind,
    text: clampChars(text, WORK_LOG_TEXT_MAX),
  };
  if (input.tool !== undefined) fields.tool = clampChars(String(input.tool), WORK_LOG_FIELD_MAX);
  if (input.ok !== undefined) fields.ok = input.ok;
  if (input.turnId !== undefined) fields.turnId = clampChars(String(input.turnId), WORK_LOG_FIELD_MAX);
  const raw = input.raw != null ? String(input.raw) : text.length > WORK_LOG_TEXT_MAX ? text : undefined;
  if (raw !== undefined) fields = withRaw(fields, raw);

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
 * paging (`hasMore` = newer exist past this page). `hasMore` is exactly
 * WorkLogPage.hasMore: a budget stop only sets it when completeness is not
 * proven. Waits for this process's pending writes to the same file first.
 * Unknown or unsafe ids read as empty.
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
        if (entry) newest.push(publicEntry(entry));
        return newest.length <= limit; // one extra tells us whether more exist
      });
      if (end === 'budget') warnBudget(conversationId, 'latest', newest.length);
      return { entries: newest.slice(0, limit).reverse(), hasMore: newest.length > limit || end === 'budget' };
    }

    // Reconnect fast path: a short backward scan usually reaches afterSeq.
    const fast: Budget = { left: FAST_PATH_BUDGET_BYTES };
    const fastCover = { offset: size };
    const newest: WorkLogEntry[] = [];
    const scan = { reachedAfterSeq: false };
    const fastEnd = await scanBackward(
      fh,
      size,
      fast,
      (line) => {
        const entry = parseEntry(line);
        if (!entry) return true;
        if (entry.seq <= afterSeq) {
          scan.reachedAfterSeq = true;
          return false;
        }
        newest.push(publicEntry(entry));
        return newest.length <= limit;
      },
      fastCover,
    );
    budget.left -= FAST_PATH_BUDGET_BYTES - fast.left;
    if (scan.reachedAfterSeq || fastEnd === 'done') {
      // Every entry after afterSeq was collected.
      const all = newest.reverse();
      return { entries: all.slice(0, limit), hasMore: all.length > limit };
    }
    if (newest.length > 0 && newest[newest.length - 1].seq === afterSeq + 1) {
      // The oldest entry collected is afterSeq + 1. Lines are in strictly
      // increasing seq order, so everything in front of it is ≤ afterSeq: the
      // collection is the start of the page whatever lies unexamined beyond it
      // (e.g. junk wider than the budget right after afterSeq).
      const all = newest.reverse();
      return { entries: all.slice(0, limit), hasMore: all.length > limit };
    }

    // More than `limit` entries follow afterSeq (or the tail is junk): page
    // forward from its position.
    const start = await findPageStart(fh, size, afterSeq, budget);
    const page: WorkLogEntry[] = [];
    const forwardCover = { offset: start };
    const end = await scanForward(
      fh,
      size,
      start,
      budget,
      (line) => {
        const entry = parseEntry(line);
        if (!entry || entry.seq <= afterSeq) return true;
        page.push(publicEntry(entry));
        return page.length <= limit;
      },
      forwardCover,
    );
    if (page.length === 0 && newest.length > 0 && forwardCover.offset >= fastCover.offset) {
      // A junk region sits between afterSeq and the tail. The forward scan
      // examined everything from the page start up to where the fast path's
      // examined region begins and found no entry after afterSeq, so the fast
      // path's collection is every such entry: return it instead of discarding
      // it, so paging makes progress past the junk.
      const all = newest.reverse();
      return { entries: all.slice(0, limit), hasMore: all.length > limit };
    }
    // If the two scanned regions do not meet, an unexamined region (wider than
    // the budget) lies between them; returning the fast path's entries could
    // skip entries in it, so the page stays empty with hasMore (documented).
    if (end === 'budget') warnBudget(conversationId, 'afterSeq', page.length);
    return { entries: page.slice(0, limit), hasMore: page.length > limit || end === 'budget' };
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * The stored entry with exactly this seq, within one scan budget: a short
 * backward scan first (the entry clicked is usually recent), else a binary
 * search for its position and a forward read. Lines are in seq order, so either
 * scan stops as soon as it passes the seq. Null when the entry is absent or
 * the budget ran out before it was found.
 */
async function findEntry(fh: fs.promises.FileHandle, size: number, seq: number): Promise<StoredWorkLogEntry | null> {
  const budget: Budget = { left: WORK_LOG_SCAN_BUDGET_BYTES };
  const fast: Budget = { left: FAST_PATH_BUDGET_BYTES };
  const found: { entry: StoredWorkLogEntry | null; passed: boolean } = { entry: null, passed: false };
  const fastEnd = await scanBackward(fh, size, fast, (line) => {
    const entry = parseEntry(line);
    if (!entry || entry.seq > seq) return true;
    if (entry.seq === seq) found.entry = entry;
    else found.passed = true;
    return false;
  });
  budget.left -= FAST_PATH_BUDGET_BYTES - fast.left;
  if (found.entry || found.passed || fastEnd === 'done') return found.entry;

  const start = await findPageStart(fh, size, seq - 1, budget);
  await scanForward(fh, size, start, budget, (line) => {
    const entry = parseEntry(line);
    if (!entry || entry.seq < seq) return true;
    if (entry.seq === seq) found.entry = entry;
    return false;
  });
  return found.entry;
}

/**
 * The raw content of one entry, for the dashboard's on-demand view. Null when
 * the entry is absent, carries no raw (every entry written before raw
 * existed), or the id/seq is unusable. Waits for this process's pending writes
 * to the same file first, like readWorkLog.
 */
export async function readWorkLogRaw(conversationId: string, seq: number): Promise<WorkLogRaw | null> {
  const files = workLogPaths(conversationId);
  if (!files || !Number.isSafeInteger(seq) || seq < 1) return null;

  await states.get(conversationId)?.queue;

  const opened = await openForRead(files.log);
  if (!opened) return null;
  const { fh, size } = opened;
  try {
    const entry = await findEntry(fh, size, seq);
    if (!entry || typeof entry.raw !== 'string') return null;
    return {
      seq,
      raw: entry.raw,
      rawBytes: typeof entry.rawBytes === 'number' ? entry.rawBytes : Buffer.byteLength(entry.raw, 'utf-8'),
      rawTruncated: entry.rawTruncated === true,
    };
  } finally {
    await fh.close().catch(() => {});
  }
}
