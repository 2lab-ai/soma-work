/**
 * The channel each user last gave a command in (SSOT 2026-10-23 T5 —
 * "유저가 마지막에 명령을 내린 채널을 디폴트로 선택").
 *
 * Recorded by `SlackHandler.handleMessage` on every real (non-synthetic)
 * message in a channel; DMs do not count — the dashboard composer starts tasks
 * in channels only. Session activity is not a substitute: goal loops, cron and
 * auto-resume refresh it without the user saying anything.
 *
 * One small JSON file in DATA_DIR, written with `atomicWriteJson` (debounced,
 * flushed on demand). An unreadable file is reported and the store starts
 * empty — this is a convenience default, never an authorization input.
 */

import * as path from 'node:path';
import { atomicWriteJson, readJsonWithBackup } from '@soma/common/atomic-json';
import { DATA_DIR } from './env-paths';
import { Logger } from './logger';

const logger = new Logger('LastCommandChannelStore');
const FLUSH_DELAY_MS = 2_000;

interface Entry {
  channelId: string;
  at: number;
}

interface FileShape {
  version: 1;
  users: Record<string, Entry>;
}

function validate(raw: unknown): FileShape {
  const file = raw as FileShape;
  if (!file || typeof file !== 'object' || file.version !== 1 || !file.users || typeof file.users !== 'object') {
    throw new Error('not a last-command-channels file');
  }
  for (const entry of Object.values(file.users)) {
    if (!entry || typeof entry.channelId !== 'string' || typeof entry.at !== 'number') {
      throw new Error('malformed entry');
    }
  }
  return file;
}

export class LastCommandChannelStore {
  private users = new Map<string, Entry>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now,
  ) {
    try {
      const file = readJsonWithBackup(filePath, validate, { warn: (msg) => logger.warn(msg) });
      if (file) for (const [userId, entry] of Object.entries(file.users)) this.users.set(userId, entry);
    } catch (error) {
      logger.warn('Last command channels unreadable — starting empty', { filePath, error: String(error) });
    }
  }

  /** Remember `channelId` as the user's last command channel (DMs and empty ids are ignored). */
  record(userId: string, channelId: string): void {
    if (!userId || !channelId || channelId.startsWith('D')) return;
    if (this.users.get(userId)?.channelId === channelId) {
      this.users.set(userId, { channelId, at: this.now() });
      return;
    }
    this.users.set(userId, { channelId, at: this.now() });
    this.schedule();
  }

  get(userId: string): string | null {
    return this.users.get(userId)?.channelId ?? null;
  }

  /** Write now (also used at shutdown and by tests). */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    try {
      atomicWriteJson(this.filePath, { version: 1, users: Object.fromEntries(this.users) } satisfies FileShape);
    } catch (error) {
      logger.warn('Failed to save last command channels', { filePath: this.filePath, error: String(error) });
    }
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, FLUSH_DELAY_MS);
    this.timer.unref?.();
  }
}

let instance: LastCommandChannelStore | undefined;

export function getLastCommandChannelStore(): LastCommandChannelStore {
  instance ??= new LastCommandChannelStore(path.join(DATA_DIR, 'last-command-channels.json'));
  return instance;
}

/** Tests: point the singleton at a scratch file. */
export function __resetLastCommandChannelStoreForTests(filePath: string): void {
  instance = new LastCommandChannelStore(filePath);
}
