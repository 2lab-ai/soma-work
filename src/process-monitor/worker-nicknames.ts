/**
 * What each work worker (a node of the process monitor — ADR 0003) is called on the dashboard. A worker keeps its
 * node id (the host name by default): that is what the monitor, the scheduler and every API name it by. The nickname
 * is only the name people read — the task card's node badge and the 프로세스 tab — so a long host name like
 * `studio-build-01` can read `b01`. An admin sets it in the settings page's 작업 워커 tab (`workers-routes.ts`).
 *
 * Stored in `DATA_DIR/worker-nicknames.json`, written atomically with a `.bak` of the last good copy
 * (`rules/config.md` 3–4). A file that cannot be read is never taken for an empty one: node ids show and nothing
 * overwrites it.
 */
import * as path from 'node:path';
import { atomicWriteJson, readJsonWithBackup } from '@soma/common/atomic-json';
import { Logger } from '../logger';

export const WORKER_NICKNAMES_FILE = 'worker-nicknames.json';
/** The longest nickname, in characters: the card badge shows about 12. */
export const MAX_WORKER_NICKNAME = 24;
/**
 * What never belongs in a name on a badge: C0 and C1 control characters, the two line separators, and the invisible
 * ones — zero-width characters, direction marks and overrides, word joiners, the byte-order mark — which would draw
 * a blank badge or turn its text around.
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;

const logger = new Logger('WorkerNicknames');
const warn = (message: string, detail?: unknown) => logger.warn(message, detail);

interface WorkerNicknamesFile {
  version: 1;
  nicknames: Record<string, string>;
}

/**
 * A nickname as sent by the page: trimmed, 1–{@link MAX_WORKER_NICKNAME} characters, no control characters.
 * Anything else is `undefined`.
 */
export function parseWorkerNickname(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.trim();
  const length = [...name].length;
  if (length < 1 || length > MAX_WORKER_NICKNAME) return undefined;
  if (CONTROL_CHARS.test(name)) return undefined;
  return name;
}

function parseFile(raw: unknown): WorkerNicknamesFile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
  const { version, nicknames } = raw as { version?: unknown; nicknames?: unknown };
  if (version !== 1) throw new Error(`unknown version ${String(version)}`);
  if (!nicknames || typeof nicknames !== 'object' || Array.isArray(nicknames)) {
    throw new Error('nicknames is not an object');
  }
  const clean: Record<string, string> = {};
  for (const [nodeId, value] of Object.entries(nicknames as Record<string, unknown>)) {
    const parsed = parseWorkerNickname(value);
    if (nodeId && parsed !== undefined) clean[nodeId] = parsed;
  }
  return { version: 1, nicknames: clean };
}

export class WorkerNicknames {
  private data: WorkerNicknamesFile = { version: 1, nicknames: {} };
  private writable = true;
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, WORKER_NICKNAMES_FILE);
    try {
      this.data = readJsonWithBackup(this.file, parseFile, { warn }) ?? this.data;
    } catch (error) {
      this.writable = false;
      logger.error('Worker nicknames unreadable — node ids show, file left untouched', {
        error: (error as Error)?.message ?? String(error),
      });
    }
  }

  /** The worker's nickname, or `undefined` when it has none (its node id shows). */
  nicknameOf(nodeId: string): string | undefined {
    // A plain object: `constructor`, `__proto__` … read as Object.prototype's members, never as a string.
    const nickname = this.data.nicknames[nodeId];
    return typeof nickname === 'string' ? nickname : undefined;
  }

  /** Set (or with `undefined`, clear back to the node id) one worker's nickname. */
  set(nodeId: string, nickname: string | undefined): void {
    if (!this.writable) throw new Error('worker nicknames file is unreadable — not overwriting it');
    const nicknames = { ...this.data.nicknames };
    if (nickname === undefined) delete nicknames[nodeId];
    else nicknames[nodeId] = nickname;
    const next: WorkerNicknamesFile = { version: 1, nicknames };
    atomicWriteJson(this.file, next, { warn });
    this.data = next;
  }
}

let active: WorkerNicknames | undefined;

/** The daemon's nicknames (set once at boot); the settings routes and the dashboard's card read the same instance. */
export function setActiveWorkerNicknames(next: WorkerNicknames | undefined): void {
  active = next;
}

export function getActiveWorkerNicknames(): WorkerNicknames | undefined {
  return active;
}

/** The name people read for a worker: its nickname, else its node id. */
export function workerNameOf(nodeId: string): string {
  return active?.nicknameOf(nodeId) ?? nodeId;
}
