/**
 * How much CPU one task of each person may use — the cap the throttler holds a task's process tree to
 * (`cpu-throttler.ts`). 100% (one core) by default, no cap for an admin, as the task queue's "one task at a time" is.
 * An admin sets a person's cap in the settings page's 작업 큐 tab (`user-task-limits-routes.ts`).
 *
 * Stored in `DATA_DIR/user-cpu-limits.json`, written atomically with a `.bak` of the last good copy
 * (`rules/config.md` 3–4). A file that cannot be read is never taken for an empty one: defaults apply and nothing
 * overwrites it.
 */
import * as path from 'node:path';
import { atomicWriteJson, readJsonWithBackup } from '@soma/common/atomic-json';
import { Logger } from '../logger';

export const USER_CPU_LIMITS_FILE = 'user-cpu-limits.json';
/** A person's cap with no setting (percent of one core). */
export const DEFAULT_CPU_CAP = 100;
/** What the settings page offers (percent of one core); 'unlimited' is the last choice. */
export const CPU_CAP_CHOICES: readonly number[] = [50, 100, 200, 400, 800];
const MIN_CAP = 25;
const MAX_CAP = 6400;

const logger = new Logger('UserCpuLimits');
const warn = (message: string, detail?: unknown) => logger.warn(message, detail);

/** One person's cap as an admin set it: a percent of one core, or no cap. */
export type CpuCapSetting = number | 'unlimited';

interface CpuLimitsFile {
  version: 1;
  limits: Record<string, CpuCapSetting>;
}

/** A cap as sent by the page: an integer percent (25–6400) or `'unlimited'`; anything else is `undefined`. */
export function parseCpuCapSetting(value: unknown): CpuCapSetting | undefined {
  if (value === 'unlimited') return 'unlimited';
  if (typeof value === 'number' && Number.isInteger(value) && value >= MIN_CAP && value <= MAX_CAP) return value;
  return undefined;
}

function parseFile(raw: unknown): CpuLimitsFile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
  const { version, limits } = raw as { version?: unknown; limits?: unknown };
  if (version !== 1) throw new Error(`unknown version ${String(version)}`);
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) throw new Error('limits is not an object');
  const clean: Record<string, CpuCapSetting> = {};
  for (const [user, value] of Object.entries(limits as Record<string, unknown>)) {
    const parsed = parseCpuCapSetting(value);
    if (parsed !== undefined) clean[user] = parsed;
  }
  return { version: 1, limits: clean };
}

export class UserCpuLimits {
  private data: CpuLimitsFile = { version: 1, limits: {} };
  private writable = true;
  private readonly file: string;

  constructor(
    dataDir: string,
    private readonly isAdmin: (userId: string) => boolean,
    private readonly defaultCap = DEFAULT_CPU_CAP,
  ) {
    this.file = path.join(dataDir, USER_CPU_LIMITS_FILE);
    try {
      this.data = readJsonWithBackup(this.file, parseFile, { warn }) ?? this.data;
    } catch (error) {
      this.writable = false;
      logger.error('User CPU limits unreadable — defaults apply, file left untouched', {
        error: (error as Error)?.message ?? String(error),
      });
    }
  }

  /** The cap on one of the person's tasks (percent of one core; `null` = no cap). */
  capFor(userId: string): number | null {
    const set = this.data.limits[userId];
    if (set === 'unlimited') return null;
    if (typeof set === 'number') return set;
    return this.defaultFor(userId);
  }

  /** The cap the person gets with no setting (`null` = none: an admin). */
  defaultFor(userId: string): number | null {
    return this.isAdmin(userId) ? null : this.defaultCap;
  }

  settingFor(userId: string): CpuCapSetting | undefined {
    return this.data.limits[userId];
  }

  /** Set (or with `undefined`, clear back to the default) one person's cap. */
  set(userId: string, setting: CpuCapSetting | undefined): void {
    if (!this.writable) throw new Error('user CPU limits file is unreadable — not overwriting it');
    const limits = { ...this.data.limits };
    if (setting === undefined) delete limits[userId];
    else limits[userId] = setting;
    const next: CpuLimitsFile = { version: 1, limits };
    atomicWriteJson(this.file, next, { warn });
    this.data = next;
  }
}

let active: UserCpuLimits | undefined;

/** The daemon's limits (set once at boot); the settings routes and the monitor read the same instance. */
export function setActiveCpuLimits(next: UserCpuLimits | undefined): void {
  active = next;
}

export function getActiveCpuLimits(): UserCpuLimits | undefined {
  return active;
}
