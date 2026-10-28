// Append-only audit ledger (.prd/16-devops-tools-architecture.md §5, §6): one JSON object per line,
// timestamped by the ledger, fsynced before `append` resolves. Rows describe what happened, never the
// keys used to do it. A line torn by a crash or a failed write stays in the file as evidence, on a line
// of its own: before the first append of a process and after any failed one, a file that does not end
// in a newline gets one first.

import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { SerialQueue, syncDir } from './state.js';

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const MAX_DEPTH = 32;

/** Cheap guard against logging a key value by accident; matched case-insensitively at the top level. */
const FORBIDDEN_KEYS = ['token', 'secret', 'value'];

const OPEN_FLAGS = fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW;
const NEWLINE = Buffer.from('\n');

/**
 * Per ledger file, per process — shared by every Ledger object on that file, so they append whole lines
 * in turn. `checkTail`: the file may end mid-line (first use, or an append failed). `syncParent`: this
 * process created the file and the directory entry is not fsynced yet.
 */
interface LedgerFile {
  queue: SerialQueue;
  checkTail: boolean;
  syncParent: boolean;
}

const files = new Map<string, LedgerFile>();

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Names the first field that has no exact JSON form (JSON.stringify would drop or rewrite it). */
function jsonProblem(value: unknown, at: string, depth: number): string | null {
  if (depth > MAX_DEPTH) return `${at} is nested too deeply (or cyclic)`;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? null : `${at} is not a finite number`;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const problem = jsonProblem(value[i], `${at}[${i}]`, depth + 1);
      if (problem !== null) return problem;
    }
    return null;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      const problem = jsonProblem(entry, `${at}.${key}`, depth + 1);
      if (problem !== null) return problem;
    }
    return null;
  }
  return `${at} is ${value === undefined ? 'undefined' : `a ${typeof value === 'object' ? 'non-plain object' : typeof value}`}`;
}

function encodeRow(row: Record<string, unknown>): string {
  if (!isPlainObject(row)) throw new TypeError('ledger row must be a plain object');
  if (typeof row.event !== 'string' || row.event.length === 0) {
    throw new TypeError('ledger row needs a non-empty string event');
  }
  for (const key of Object.keys(row)) {
    if (FORBIDDEN_KEYS.includes(key.toLowerCase())) {
      throw new TypeError(`ledger row must not carry a top-level ${JSON.stringify(key)} key`);
    }
    if (key === 'ts') throw new TypeError('ledger row must not set ts; the ledger stamps it');
  }
  const problem = jsonProblem(row, 'row', 0);
  if (problem !== null) throw new TypeError(`ledger row is not plain JSON: ${problem}`);
  return `${JSON.stringify({ ts: new Date().toISOString(), ...row })}\n`;
}

async function openLedger(file: string): Promise<{ handle: fs.FileHandle; created: boolean }> {
  try {
    return { handle: await fs.open(file, OPEN_FLAGS), created: false };
  } catch (err) {
    if (errorCode(err) !== 'ENOENT') throw err;
  }
  try {
    return {
      handle: await fs.open(file, OPEN_FLAGS | fsConstants.O_CREAT | fsConstants.O_EXCL, FILE_MODE),
      created: true,
    };
  } catch (err) {
    // Created by someone else between the two opens.
    if (errorCode(err) !== 'EEXIST') throw err;
    return { handle: await fs.open(file, OPEN_FLAGS), created: false };
  }
}

async function writeAll(handle: fs.FileHandle, data: Buffer): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await handle.write(data, offset, data.length - offset);
    offset += bytesWritten;
  }
}

/** A non-empty file whose last byte is not a newline ends in a torn line; close it off first. */
async function closeTornTail(handle: fs.FileHandle, size: number): Promise<void> {
  if (size === 0) return;
  const last = Buffer.alloc(1);
  await handle.read(last, 0, 1, size - 1);
  if (last[0] === NEWLINE[0]) return;
  await writeAll(handle, NEWLINE);
  await handle.sync();
}

async function appendLine(file: string, state: LedgerFile, line: string): Promise<void> {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: DIR_MODE });
    const { handle, created } = await openLedger(file);
    if (created) state.syncParent = true;
    try {
      if (state.syncParent) {
        await syncDir(path.dirname(file));
        state.syncParent = false;
      }
      const stat = await handle.stat();
      if ((stat.mode & 0o777) !== FILE_MODE) await handle.chmod(FILE_MODE);
      if (state.checkTail) await closeTornTail(handle, stat.size);
      await writeAll(handle, Buffer.from(line, 'utf8'));
      await handle.sync();
    } finally {
      await handle.close();
    }
    state.checkTail = false;
  } catch (err) {
    state.checkTail = true;
    throw err;
  }
}

export class Ledger {
  private readonly file: string;
  private readonly state: LedgerFile;

  constructor(file: string) {
    this.file = path.resolve(file);
    let state = files.get(this.file);
    if (state === undefined) {
      state = { queue: new SerialQueue(), checkTail: true, syncParent: false };
      files.set(this.file, state);
    }
    this.state = state;
  }

  /** Adds `ts` (ISO 8601 UTC) and appends the row as one line. The row is encoded at call time. */
  append(row: { event: string } & Record<string, unknown>): Promise<void> {
    let line: string;
    try {
      line = encodeRow(row);
    } catch (err) {
      return Promise.reject(err);
    }
    return this.state.queue.run(() => appendLine(this.file, this.state, line));
  }
}
