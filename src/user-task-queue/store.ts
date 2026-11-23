/**
 * Where the per-user task queue and the per-user limits live on disk: two small JSON files in `DATA_DIR`, written
 * atomically with a `.bak` of the last good copy (`rules/config.md` 3–4). A file that cannot be read is never taken
 * for an empty one: the queue then runs in memory and says so in the log, and nothing overwrites the file.
 */
import * as path from 'node:path';
import { atomicWriteJson, readJsonWithBackup } from '@soma/common/atomic-json';
import { Logger } from '../logger';
import { parseLedger, type UserTaskLedger } from './ledger';
import { UNLIMITED } from './user-task-queue';

export const USER_TASK_QUEUE_FILE = 'user-task-queue.json';
export const USER_TASK_LIMITS_FILE = 'user-task-limits.json';

/** The knob's range: 1..MAX_TASK_LIMIT, or no limit. */
export const MAX_TASK_LIMIT = 10;

const logger = new Logger('UserTaskQueueStore');
const warn = (message: string, detail?: unknown) => logger.warn(message, detail);

export function createUserTaskQueueStore(dataDir: string): {
  load(): UserTaskLedger | undefined;
  save(ledger: UserTaskLedger): void;
} {
  const file = path.join(dataDir, USER_TASK_QUEUE_FILE);
  let writable = true;
  return {
    load: () => {
      try {
        return readJsonWithBackup(file, parseLedger, { warn });
      } catch (error) {
        writable = false;
        logger.error('User task queue unreadable — running in memory, file left untouched', {
          error: (error as Error)?.message ?? String(error),
        });
        return undefined;
      }
    },
    save: (ledger) => {
      if (!writable) return;
      atomicWriteJson(file, ledger, { warn });
    },
  };
}

/** One person's limit as an admin set it: a number of tasks, or no limit. */
export type TaskLimitSetting = number | 'unlimited';

interface LimitsFile {
  version: 1;
  limits: Record<string, TaskLimitSetting>;
}

function parseLimits(raw: unknown): LimitsFile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
  const { version, limits } = raw as { version?: unknown; limits?: unknown };
  if (version !== 1) throw new Error(`unknown version ${String(version)}`);
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) throw new Error('limits is not an object');
  const clean: Record<string, TaskLimitSetting> = {};
  for (const [user, value] of Object.entries(limits as Record<string, unknown>)) {
    const parsed = parseTaskLimitSetting(value);
    if (parsed !== undefined) clean[user] = parsed;
  }
  return { version: 1, limits: clean };
}

/** A limit as sent by the knob: an integer 1..MAX_TASK_LIMIT or `'unlimited'`; anything else is `undefined`. */
export function parseTaskLimitSetting(value: unknown): TaskLimitSetting | undefined {
  if (value === 'unlimited') return 'unlimited';
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_TASK_LIMIT) return value;
  return undefined;
}

/**
 * The limits an admin set per person (the dashboard knob). A person with no setting gets the default: 1 task, no
 * limit for an admin.
 */
export class UserTaskLimits {
  private data: LimitsFile = { version: 1, limits: {} };
  private writable = true;
  private readonly file: string;

  constructor(
    dataDir: string,
    private readonly isAdmin: (userId: string) => boolean,
    private readonly defaultLimit = 1,
  ) {
    this.file = path.join(dataDir, USER_TASK_LIMITS_FILE);
    try {
      this.data = readJsonWithBackup(this.file, parseLimits, { warn }) ?? this.data;
    } catch (error) {
      this.writable = false;
      logger.error('User task limits unreadable — defaults apply, file left untouched', {
        error: (error as Error)?.message ?? String(error),
      });
    }
  }

  /** What the person may run at once (`UNLIMITED` = no limit). */
  limitFor(userId: string): number {
    const set = this.data.limits[userId];
    if (set === 'unlimited') return UNLIMITED;
    if (typeof set === 'number') return set;
    return this.defaultFor(userId);
  }

  /** The limit the person gets with no setting. */
  defaultFor(userId: string): number {
    return this.isAdmin(userId) ? UNLIMITED : this.defaultLimit;
  }

  /** The admin's setting for the person, if any. */
  settingFor(userId: string): TaskLimitSetting | undefined {
    return this.data.limits[userId];
  }

  all(): Record<string, TaskLimitSetting> {
    return { ...this.data.limits };
  }

  /** Set (or with `undefined`, clear back to the default) one person's limit. */
  set(userId: string, setting: TaskLimitSetting | undefined): void {
    if (!this.writable) throw new Error('user task limits file is unreadable — not overwriting it');
    const limits = { ...this.data.limits };
    if (setting === undefined) delete limits[userId];
    else limits[userId] = setting;
    const next: LimitsFile = { version: 1, limits };
    atomicWriteJson(this.file, next, { warn });
    this.data = next;
  }
}
