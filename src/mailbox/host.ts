/**
 * Production wiring of the mailbox poller: the HTTP client for the local mailbox server and the file that remembers
 * which Slack thread each mail conversation lives in.
 */
import * as path from 'node:path';
import { atomicWriteJson, readJsonWithBackup } from '@soma/common/atomic-json';
import { Logger } from '../logger';
import { type MailboxConfig, readClientSettings } from './config';
import { type MailboxClient, MailboxPoller, type MailboxPollerDeps, type ThreadLink, type ThreadMap } from './poller';

const logger = new Logger('MailboxHost');
const MAX_THREADS = 1000;

/** Talks to the mailbox server named in the CLI settings file, re-read on every call. */
export function createMailboxClient(clientFile: string, fetchImpl: typeof fetch = fetch): MailboxClient {
  const call = async (
    method: string,
    route: (address: string) => string,
    body: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ) => {
    const s = readClientSettings(clientFile);
    // A server that accepts the call and never answers must not stall the loop: every call has a deadline.
    const deadline = AbortSignal.timeout(timeoutMs);
    const res = await fetchImpl(s.url + route(encodeURIComponent(s.address)), {
      method,
      headers: { authorization: `Bearer ${s.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`mailbox server answered ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  };
  return {
    async inbox(waitSeconds, signal) {
      const json = await call(
        'GET',
        (a) => `/v1/mailboxes/${a}/inbox?unread=true&limit=100&wait=${waitSeconds}`,
        undefined,
        (waitSeconds + 15) * 1000,
        signal,
      );
      return { address: String(json.address ?? ''), messages: Array.isArray(json.messages) ? json.messages : [] };
    },
    async ack(ids) {
      await call('POST', (a) => `/v1/mailboxes/${a}/ack`, { ids }, 15_000);
    },
  };
}

/** mail thread id → Slack thread, kept in DATA_DIR so a restart keeps conversations in their threads. */
export function createThreadMap(dataDir: string): ThreadMap {
  const file = path.join(dataDir, 'mailbox-threads.json');
  type Entry = ThreadLink & { at: string };
  let entries: Record<string, Entry> = {};
  try {
    const loaded = readJsonWithBackup<Record<string, Entry>>(file, (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
      return raw as Record<string, Entry>;
    });
    if (loaded) entries = loaded;
  } catch (error) {
    logger.warn('Could not read the mailbox thread map; starting empty', { error: (error as Error)?.message });
  }
  return {
    get: (thread) => {
      const e = entries[thread];
      return e ? { channel: e.channel, threadTs: e.threadTs } : undefined;
    },
    set: (thread, link) => {
      entries[thread] = { ...link, at: new Date().toISOString() };
      const keys = Object.keys(entries);
      if (keys.length > MAX_THREADS) {
        for (const k of keys
          .sort((x, y) => entries[x].at.localeCompare(entries[y].at))
          .slice(0, keys.length - MAX_THREADS))
          delete entries[k];
      }
      atomicWriteJson(file, entries);
    },
  };
}

export interface MailboxHostDeps {
  config: MailboxConfig;
  dataDir: string;
  openThread: MailboxPollerDeps['openThread'];
  openDm: (userId: string) => Promise<string>;
  inject: MailboxPollerDeps['inject'];
  notify: MailboxPollerDeps['notify'];
  sessionState: MailboxPollerDeps['sessionState'];
}

export function createMailboxPoller(deps: MailboxHostDeps): MailboxPoller {
  let dm: string | undefined;
  return new MailboxPoller({
    client: createMailboxClient(deps.config.clientFile),
    owner: deps.config.owner,
    resolveChannel: async () => {
      if (deps.config.channel) return deps.config.channel;
      dm ??= await deps.openDm(deps.config.owner);
      return dm;
    },
    openThread: deps.openThread,
    inject: deps.inject,
    notify: deps.notify,
    sessionState: deps.sessionState,
    threads: createThreadMap(deps.dataDir),
    allowFrom: deps.config.allowFrom,
    cli: deps.config.cli,
    intervalMs: deps.config.intervalMs,
  });
}
