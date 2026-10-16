/**
 * Work log — the verbose, per-conversation stream of what the model is doing
 * (instructions, narration, tool calls, results, notices, errors). Slack only
 * shows the minimal surface; the standalone dashboard shows this log.
 *
 * Storage: `${DATA_DIR}/worklogs/<conversationId>.jsonl`, append-only, one
 * entry per line. `seq` is monotonic per conversation and survives restarts
 * (seeded from the file on first use in this process).
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

/** Max characters kept per entry `text` (spec §3.3). */
export const WORK_LOG_TEXT_MAX = 4000;
/** Default (and API maximum) number of entries returned by a read. */
export const WORK_LOG_DEFAULT_LIMIT = 500;

/** Conversation ids are UUIDs; anything outside this set never touches the filesystem. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

interface ConversationLogState {
  /** Last seq handed out. */
  lastSeq: number;
  /** Serialized write chain for this file — appends never interleave. */
  queue: Promise<void>;
  /** The file ended mid-line (torn write); the next append starts a fresh line. */
  needsLeadingNewline: boolean;
}

const states = new Map<string, ConversationLogState>();
let dirReady: Promise<void> | null = null;
let _onAppended: ((conversationId: string, entry: WorkLogEntry) => void) | null = null;

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

/**
 * Seed the per-conversation state from the file left by an earlier process.
 * The next seq must exceed every seq already on disk: take the larger of the
 * last parseable entry's seq and the non-empty line count (seqs start at 1 and
 * are dense, so the count covers a torn last line too).
 */
function seedState(filePath: string): ConversationLogState {
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('Could not read existing work log; seq restarts at 1', { filePath, error: err });
    }
  }
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  let lastSeq = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const seq = (JSON.parse(lines[i]) as Partial<WorkLogEntry>).seq;
      if (typeof seq === 'number' && Number.isFinite(seq)) {
        lastSeq = Math.max(lastSeq, seq);
        break;
      }
    } catch {
      // torn or corrupt line — keep scanning back
    }
  }
  return {
    lastSeq,
    queue: Promise.resolve(),
    needsLeadingNewline: content.length > 0 && !content.endsWith('\n'),
  };
}

function clampText(text: string): string {
  if (text.length <= WORK_LOG_TEXT_MAX) return text;
  let end = WORK_LOG_TEXT_MAX - 1; // leave room for the ellipsis
  const lastKept = text.charCodeAt(end - 1);
  if (lastKept >= 0xd800 && lastKept <= 0xdbff) end -= 1; // never split a surrogate pair
  return `${text.slice(0, end)}…`;
}

/**
 * Register the single in-process listener fired after every append (the
 * dashboard WS broadcast). Mirrors recorder's `setOnTurnRecordedCallback`.
 */
export function setOnWorkLogAppendedCallback(fn: ((conversationId: string, entry: WorkLogEntry) => void) | null): void {
  _onAppended = fn;
}

/**
 * Append one entry. Assigns `seq` and `ts` synchronously and returns the stored
 * entry; the disk write is queued behind earlier writes for the same file.
 * Throws when `conversationId` is not a safe filename.
 */
export function appendWorkLog(conversationId: string, input: WorkLogInput): WorkLogEntry {
  const filePath = workLogPath(conversationId);
  if (!filePath) throw new Error('Invalid work log conversationId');

  let state = states.get(conversationId);
  if (!state) {
    state = seedState(filePath);
    states.set(conversationId, state);
  }

  state.lastSeq += 1;
  const entry: WorkLogEntry = {
    seq: state.lastSeq,
    ts: typeof input.ts === 'number' && Number.isFinite(input.ts) ? input.ts : Date.now(),
    kind: input.kind,
    text: clampText(String(input.text ?? '')),
  };
  if (input.tool !== undefined) entry.tool = input.tool;
  if (input.ok !== undefined) entry.ok = input.ok;
  if (input.turnId !== undefined) entry.turnId = input.turnId;

  const line = `${state.needsLeadingNewline ? '\n' : ''}${JSON.stringify(entry)}\n`;
  state.needsLeadingNewline = false;
  state.queue = state.queue
    .then(() => ensureDir())
    .then(() => fs.promises.appendFile(filePath, line, 'utf-8'))
    .catch((error) => {
      logger.error('Failed to persist work log entry', { conversationId, seq: entry.seq, error });
    });

  if (_onAppended) {
    try {
      _onAppended(conversationId, entry);
    } catch (error) {
      logger.warn('Work log listener failed', { conversationId, error });
    }
  }
  return entry;
}

/** Resolve once every queued write in this process has settled (tests, shutdown). */
export async function flushWorkLog(): Promise<void> {
  await Promise.all(Array.from(states.values(), (s) => s.queue));
}

/**
 * Read entries with `seq > afterSeq`, returning the last `limit` of them in seq
 * order. Waits for this process's pending writes to the same file first, so a
 * read right after an append sees it. Unknown or unsafe ids read as empty.
 */
export async function readWorkLog(
  conversationId: string,
  options: { afterSeq?: number; limit?: number } = {},
): Promise<WorkLogEntry[]> {
  const filePath = workLogPath(conversationId);
  if (!filePath) return [];
  const limit = options.limit ?? WORK_LOG_DEFAULT_LIMIT;
  if (!(limit > 0)) return [];
  const afterSeq = options.afterSeq ?? 0;

  await states.get(conversationId)?.queue;

  let content: string;
  try {
    content = await fs.promises.readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const entries: WorkLogEntry[] = [];
  let skipped = 0;
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as WorkLogEntry;
      if (typeof entry.seq === 'number' && entry.seq > afterSeq) entries.push(entry);
    } catch {
      skipped += 1;
    }
  }
  if (skipped > 0) logger.warn('Skipped corrupt work log lines', { conversationId, skipped });
  return entries.slice(-limit);
}
