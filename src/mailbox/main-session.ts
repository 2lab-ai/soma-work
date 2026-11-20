/**
 * The instance's main session (대표 세션): the one Slack thread that takes mail sent to the instance without a session
 * tag, and the session an admin talks to by default. Kept in `DATA_DIR/mailbox-main-session.json`, read on every call
 * so the poller and the dashboard routes always agree. When none is set (or it can no longer take a turn), the poller
 * opens a new thread and records it here.
 */
import * as path from 'node:path';
import { atomicWriteJson, readJsonWithBackup } from '@soma/common/atomic-json';
import { Logger } from '../logger';
import { type SessionTarget, sessionFromTag, sessionMailTag } from './session-address';

const logger = new Logger('MailboxMainSession');

export interface MainSessionRecord extends SessionTarget {
  setAt: string;
  /** Who chose it: a Slack user id, or `poller` when the poller opened it. */
  setBy: string;
}

export interface MainSessionStore {
  get(): MainSessionRecord | undefined;
  set(target: SessionTarget, setBy: string): MainSessionRecord;
  clear(): void;
}

function valid(raw: unknown): MainSessionRecord {
  const r = raw as Partial<MainSessionRecord> | null;
  if (!r || typeof r !== 'object' || typeof r.channel !== 'string' || typeof r.threadTs !== 'string')
    throw new Error('not a main-session record');
  if (!sessionMailTag(r.channel, r.threadTs)) throw new Error('main-session record names no Slack thread');
  return {
    channel: r.channel,
    threadTs: r.threadTs,
    setAt: typeof r.setAt === 'string' ? r.setAt : '',
    setBy: typeof r.setBy === 'string' ? r.setBy : '',
  };
}

export function createMainSessionStore(dataDir: string): MainSessionStore {
  const file = path.join(dataDir, 'mailbox-main-session.json');
  return {
    get() {
      try {
        const r = readJsonWithBackup<MainSessionRecord | { cleared: true }>(file, (raw) =>
          (raw as { cleared?: boolean })?.cleared ? { cleared: true } : valid(raw),
        );
        return r && !('cleared' in r) ? r : undefined;
      } catch (error) {
        logger.warn('Could not read the main session; treating it as unset', { error: (error as Error)?.message });
        return undefined;
      }
    },
    set(target, setBy) {
      if (!sessionMailTag(target.channel, target.threadTs)) throw new Error('the main session must be a Slack thread');
      const record: MainSessionRecord = { ...target, setAt: new Date().toISOString(), setBy };
      atomicWriteJson(file, record);
      return record;
    },
    clear() {
      atomicWriteJson(file, { cleared: true });
    },
  };
}

/** A session key from the dashboard (`<channel>-<threadTs>`) as a target, or undefined. */
export function targetFromSessionKey(key: string): SessionTarget | undefined {
  return sessionFromTag(key.toLowerCase());
}
