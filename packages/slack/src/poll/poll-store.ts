import { atomicWriteJson, readJsonWithBackup } from '@soma/common/atomic-json';
import { Logger } from '@soma/common/logger';
import type { PollRecord, PollStoreFile } from './poll-types';

/**
 * Persistent poll records (`DATA_DIR/polls.json`).
 *
 * Synchronous read-modify-write over an in-memory map, persisted with
 * `atomicWriteJson` (tmp → fsync → rename, `.bak` fallback on load). There is
 * a single host process; concurrency is handled by the caller's `PollLane`,
 * and every mutation here completes without yielding.
 */
export class PollStore {
  private polls = new Map<string, PollRecord>();
  private logger = new Logger('PollStore');

  constructor(private readonly filePath: string) {}

  load(): void {
    const data = readJsonWithBackup<PollStoreFile>(this.filePath, validateFile, {
      warn: (message, detail) => this.logger.warn(message, detail),
    });
    this.polls.clear();
    if (!data) return;
    for (const [id, raw] of Object.entries(data.polls)) {
      if (isPollRecord(raw) && raw.id === id) {
        this.polls.set(id, raw);
      } else {
        this.logger.warn('Ignoring malformed poll record', { id });
      }
    }
  }

  get(id: string): PollRecord | undefined {
    const p = this.polls.get(id);
    return p ? clone(p) : undefined;
  }

  all(): PollRecord[] {
    return [...this.polls.values()].map(clone);
  }

  findOpenInThread(channel: string, threadTs: string): PollRecord | undefined {
    for (const p of this.polls.values()) {
      if (p.status === 'open' && p.channel === channel && p.threadTs === threadTs) return clone(p);
    }
    return undefined;
  }

  findByInvocation(invocationId: string): PollRecord | undefined {
    for (const p of this.polls.values()) {
      if (p.invocationId === invocationId) return clone(p);
    }
    return undefined;
  }

  insert(record: PollRecord): void {
    if (this.polls.has(record.id)) throw new Error(`Poll already exists: ${record.id}`);
    this.polls.set(record.id, clone(record));
    try {
      this.persist();
    } catch (error) {
      this.polls.delete(record.id);
      throw error;
    }
  }

  /** Mutate a stored record in place and persist. Throws for unknown ids. */
  update(id: string, mutate: (record: PollRecord) => void): PollRecord {
    const current = this.polls.get(id);
    if (!current) throw new Error(`Unknown poll: ${id}`);
    const next = clone(current);
    mutate(next);
    this.polls.set(id, next);
    try {
      this.persist();
    } catch (error) {
      this.polls.set(id, current);
      throw error;
    }
    return clone(next);
  }

  private persist(): void {
    const file: PollStoreFile = { version: 1, polls: Object.fromEntries(this.polls) };
    atomicWriteJson(this.filePath, file, { warn: (message, detail) => this.logger.warn(message, detail) });
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function validateFile(raw: unknown): PollStoreFile {
  if (!raw || typeof raw !== 'object') throw new Error('poll store must be an object');
  const obj = raw as { version?: unknown; polls?: unknown };
  if (obj.version !== 1) throw new Error(`unsupported poll store version: ${String(obj.version)}`);
  if (!obj.polls || typeof obj.polls !== 'object') throw new Error('poll store has no polls map');
  return obj as PollStoreFile;
}

function isPollRecord(raw: unknown): raw is PollRecord {
  if (!raw || typeof raw !== 'object') return false;
  const p = raw as Record<string, unknown>;
  return (
    typeof p.id === 'string' &&
    typeof p.channel === 'string' &&
    typeof p.threadTs === 'string' &&
    typeof p.messageTs === 'string' &&
    typeof p.creatorId === 'string' &&
    typeof p.title === 'string' &&
    Array.isArray(p.options) &&
    p.options.every((o) => typeof o === 'string') &&
    !!p.votes &&
    typeof p.votes === 'object' &&
    !!p.voteActionTs &&
    typeof p.voteActionTs === 'object' &&
    typeof p.closesAt === 'number' &&
    (p.status === 'open' || p.status === 'closed' || p.status === 'canceled') &&
    typeof p.createdAt === 'number'
  );
}
