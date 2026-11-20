/**
 * Production wiring of the mailbox poller: the HTTP client for the local mailbox server, the main session store, and
 * the instance's mail identity (the per-session `MAILBOX_ADDRESS` agent shells get).
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_CLIENT_FILE, type MailboxConfig, readClientSettings } from './config';
import { createMainSessionStore } from './main-session';
import { type MailboxClient, MailboxPoller, type MailboxPollerDeps } from './poller';
import { setMailboxIdentity } from './session-address';

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

export interface MailboxHostDeps {
  config: MailboxConfig;
  dataDir: string;
  openThread: MailboxPollerDeps['openThread'];
  openDm: (userId: string) => Promise<string>;
  inject: MailboxPollerDeps['inject'];
  notify: MailboxPollerDeps['notify'];
  sessionState: MailboxPollerDeps['sessionState'];
  sessionOwner: MailboxPollerDeps['sessionOwner'];
}

export function createMailboxPoller(deps: MailboxHostDeps): MailboxPoller {
  let dm: string | undefined;
  const defaultClient = path.join(os.homedir(), DEFAULT_CLIENT_FILE.slice(2));
  const mainStore = createMainSessionStore(deps.dataDir);
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
    sessionOwner: deps.sessionOwner,
    // The address agent shells send as: this instance's mailbox + the session tag (src/mailbox/session-address.ts).
    // Set from the server's answer, so a client file fixed after startup still brings mail (the poll loop retries).
    onAddress: (address) =>
      setMailboxIdentity({
        address,
        owner: deps.config.owner,
        ...(deps.config.clientFile !== defaultClient ? { clientFile: deps.config.clientFile } : {}),
      }),
    mainSession: {
      get: () => mainStore.get(),
      set: (link) => {
        mainStore.set(link, 'poller');
      },
    },
    allowFrom: deps.config.allowFrom,
    cli: deps.config.cli,
    intervalMs: deps.config.intervalMs,
  });
}
