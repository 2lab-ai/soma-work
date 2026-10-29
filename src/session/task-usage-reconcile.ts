/**
 * Final per-call usage for the task ledger (SSOT 2026-10-29 T5, live follow-up).
 *
 * A task's tokens are credited per API call as the call lands
 * (`notifyLiveUsage` → `creditTaskUsage`). For a Claude call that frame is the
 * SDK's assistant frame, which carries the call's `message_start` usage: input
 * and cache counts are final, output is the handful of tokens counted at the
 * start. Measured on dev host work-m64, 2026-10-29: two calls of 326 output tokens each
 * were credited 24 each. The CLI's transcript has every call's final usage:
 *
 *   <config>/projects/<cwd>/<sdkSessionId>.jsonl          (main agent)
 *   <config>/projects/<cwd>/<sdkSessionId>/subagents/…    (subagents — read by agent-spend)
 *
 * One API call is one `message.id`; the CLI writes a line per content block
 * and the last line of a call carries its final usage. The reader keeps, per
 * session, how far it has read, and returns the calls whose lines it read
 * since; {@link reconcileTaskCalls} re-credits each call the ledger was
 * credited with live (same tasks, signed difference). Calls the ledger never
 * saw live are left alone.
 *
 * File access: the session id must be a UUID (`findTranscriptPath`) and the
 * transcript a regular file, not a symlink. A session first read in this
 * process starts {@link DEFAULT_TAIL_BYTES} before the end — calls credited
 * live in this process are all recent. Runtime state only.
 */
import fs from 'node:fs';
import { findTranscriptPath, resolveClaudeConfigDir } from '@soma/slack/pipeline/transcript-sanitizer';
import { recreditTaskUsage, type TaskLedger } from './task-ledger';

/** Final usage of one API call, as its transcript line says. */
export interface TranscriptCall {
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

export interface MainCallReaderOptions {
  configDir?: string;
  /** Bytes read per chunk (default 8 MiB). */
  chunkBytes?: number;
  /** Where the first read of a session starts, counted back from the end (default 32 MiB). */
  tailBytes?: number;
  /** Sessions whose read position is remembered (default 256; the oldest is forgotten first). */
  maxSessions?: number;
  now?: () => number;
}

export interface MainCallReader {
  /**
   * The session's latest main-agent calls ({@link CALLS_KEPT}, newest last) with
   * their final usage. Every read returns them all, not only the lines new
   * since the last read (review): a line read before its call's live credit
   * landed (catching up after a restart) is matched on a later read.
   */
  read(sdkSessionId: string, opts?: { force?: boolean }): Promise<Map<string, TranscriptCall>>;
}

/** Calls kept per session — as many as the ledger remembers live credits for. */
export const CALLS_KEPT = 512;

const SYNTHETIC_MODEL = '<synthetic>';
const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;
const DEFAULT_TAIL_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_SESSIONS = 256;
const MISSING_RETRY_MS = 60_000;

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** The calls on complete transcript lines (the last line of a call wins). */
export function collectTranscriptCalls(text: string, into: Map<string, TranscriptCall>, mainOnly: boolean): void {
  for (const line of text.split('\n')) {
    if (!line.includes('"assistant"')) continue;
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j?.type !== 'assistant') continue;
    // A subagent's call is credited under its own key (`s:`), from its own transcript.
    if (mainOnly && j.isSidechain === true) continue;
    const m = j.message as Record<string, unknown> | undefined;
    const u = m?.usage as Record<string, unknown> | undefined;
    if (!m || !u || typeof u !== 'object') continue;
    const model = typeof m.model === 'string' ? m.model : undefined;
    if (model === SYNTHETIC_MODEL) continue;
    const id = typeof m.id === 'string' && m.id ? m.id : undefined;
    if (!id) continue;
    into.set(id, {
      model,
      inputTokens: count(u.input_tokens),
      outputTokens: count(u.output_tokens),
      cacheReadTokens: count(u.cache_read_input_tokens),
      cacheCreateTokens: count(u.cache_creation_input_tokens),
    });
  }
}

interface ReadState {
  /** The latest calls (newest last), at most {@link CALLS_KEPT}. */
  calls: Map<string, TranscriptCall>;
  file?: string;
  /** When a missing transcript may be searched for again. */
  retryAt?: number;
  offset: number;
  carry: Buffer;
  busy: Promise<unknown>;
}

export function createMainCallReader(opts: MainCallReaderOptions = {}): MainCallReader {
  const now = opts.now ?? Date.now;
  const chunkBytes = Math.max(1, opts.chunkBytes ?? DEFAULT_CHUNK_BYTES);
  const tailBytes = Math.max(0, opts.tailBytes ?? DEFAULT_TAIL_BYTES);
  const maxSessions = Math.max(1, opts.maxSessions ?? DEFAULT_MAX_SESSIONS);
  const states = new Map<string, ReadState>();

  function keep(state: ReadState, fresh: Map<string, TranscriptCall>): void {
    for (const [id, c] of fresh) {
      state.calls.delete(id); // re-insert: newest last
      state.calls.set(id, c);
    }
    while (state.calls.size > CALLS_KEPT) state.calls.delete(state.calls.keys().next().value as string);
  }

  /** Reads what was appended since the last read into `state.calls` (kept chunk by chunk). */
  async function readNew(sid: string, state: ReadState, force: boolean): Promise<void> {
    if (!state.file) {
      // A turn end looks again even within the retry window (review: a short
      // first turn would otherwise end before the transcript was looked for again).
      if (!force && state.retryAt !== undefined && now() < state.retryAt) return;
      const found = findTranscriptPath(sid, opts.configDir ?? resolveClaudeConfigDir());
      if (!found) {
        state.retryAt = now() + MISSING_RETRY_MS;
        return;
      }
      state.file = found;
      state.retryAt = undefined;
    }
    let st: fs.Stats;
    try {
      st = await fs.promises.lstat(state.file);
    } catch {
      state.file = undefined;
      return;
    }
    if (!st.isFile() || st.isSymbolicLink()) return;
    if (st.size < state.offset) {
      // Rewritten: start over (from the tail, as a first read).
      state.offset = -1;
      state.carry = Buffer.alloc(0);
      state.calls.clear();
    }
    let skipPartial = false;
    if (state.offset < 0) {
      state.offset = Math.max(0, st.size - tailBytes);
      skipPartial = state.offset > 0;
    }
    if (st.size === state.offset) return;
    const fh = await fs.promises.open(state.file, 'r');
    try {
      while (state.offset < st.size) {
        const length = Math.min(st.size - state.offset, chunkBytes);
        const buf = Buffer.alloc(length);
        const { bytesRead } = await fh.read(buf, 0, length, state.offset);
        if (bytesRead === 0) break;
        let bytes = Buffer.concat([state.carry, buf.subarray(0, bytesRead)]);
        state.offset += bytesRead;
        if (skipPartial) {
          // Started mid-file: the first line is a fragment.
          const nl = bytes.indexOf(0x0a);
          if (nl < 0) {
            state.carry = Buffer.alloc(0);
            continue;
          }
          bytes = bytes.subarray(nl + 1);
          skipPartial = false;
        }
        const cut = bytes.lastIndexOf(0x0a);
        state.carry = cut >= 0 ? Buffer.from(bytes.subarray(cut + 1)) : Buffer.from(bytes);
        if (cut >= 0) {
          // Kept as each chunk is read (review): a failure on a later chunk
          // never loses the calls of the bytes the cursor already moved past.
          const got = new Map<string, TranscriptCall>();
          collectTranscriptCalls(bytes.subarray(0, cut).toString('utf8'), got, true);
          keep(state, got);
        }
      }
    } finally {
      await fh.close();
    }
  }

  return {
    read(sid: string, readOpts?: { force?: boolean }): Promise<Map<string, TranscriptCall>> {
      const force = readOpts?.force === true;
      let state = states.get(sid);
      if (state) {
        states.delete(sid); // re-insert: most recently used last
      } else {
        state = { calls: new Map(), offset: -1, carry: Buffer.alloc(0), busy: Promise.resolve() };
      }
      states.set(sid, state);
      while (states.size > maxSessions) {
        const oldest = states.keys().next().value as string;
        states.delete(oldest);
      }
      const s = state;
      // One read at a time per session: two would hand out the same lines twice.
      const step = async () => {
        await readNew(sid, s, force);
        return new Map(s.calls);
      };
      const run = s.busy.then(step, step);
      s.busy = run.catch(() => undefined);
      return run;
    },
  };
}

/**
 * Re-credit every call in `calls` the ledger was credited with live under
 * `prefix + id` (`m:` main agent, `s:` subagent) with its final usage, priced
 * by `price` (`creditedModel` = the model its live credit was priced at).
 * A call with no prompt side in the transcript is skipped (unreported, not
 * zero). Returns whether any task's numbers changed.
 */
export function reconcileTaskCalls(
  ledger: TaskLedger | undefined,
  calls: ReadonlyMap<string, TranscriptCall>,
  prefix: 'm:' | 's:',
  price: (call: TranscriptCall, creditedModel: string | undefined) => number,
): boolean {
  if (!ledger || calls.size === 0) return false;
  let changed = false;
  for (const [id, call] of calls) {
    if (recreditTaskUsage(ledger, `${prefix}${id}`, call, (m) => price(call, m))) changed = true;
  }
  return changed;
}
