/**
 * Every Slack session of this instance has a mail address: the instance's mailbox address plus a session tag,
 * `<agent>:<host>:<instance>/<tag>`. The tag is the session key in lower case — `<channel>-<threadTs>` — so it maps
 * back to its thread without a lookup table (Slack channel ids are upper-case letters and digits). The tag `main`
 * names the instance's main session (mail without a tag lands there too).
 *
 * The host sets `MAILBOX_ADDRESS` in each turn's agent environment, so `mailbox send` from a session carries that
 * session's address and an answer comes back to the same session.
 */

export const MAIN_SESSION_TAG = 'main';

const CHANNEL = /^[CDG][A-Z0-9]{2,}$/;
const THREAD_TS = /^\d{1,12}\.\d{1,9}$/;

export interface SessionTarget {
  channel: string;
  threadTs: string;
}

/** The tag of a Slack session, or undefined for a session with no thread (a dashboard-only task). */
export function sessionMailTag(channel: string | undefined, threadTs: string | undefined): string | undefined {
  if (!channel || !threadTs || !CHANNEL.test(channel) || !THREAD_TS.test(threadTs)) return undefined;
  return `${channel.toLowerCase()}-${threadTs}`;
}

/** The session a tag names, or undefined when it is not a session tag (`main`, anything malformed). */
export function sessionFromTag(tag: string): SessionTarget | undefined {
  const dash = tag.indexOf('-');
  if (dash < 0) return undefined;
  const channel = tag.slice(0, dash).toUpperCase();
  const threadTs = tag.slice(dash + 1);
  if (!CHANNEL.test(channel) || !THREAD_TS.test(threadTs)) return undefined;
  return { channel, threadTs };
}

/** The tag of a recipient address (`…/tag`), or undefined. */
export function tagOf(address: string): string | undefined {
  const slash = address.indexOf('/');
  return slash < 0 ? undefined : address.slice(slash + 1);
}

interface MailboxIdentity {
  /** This instance's mailbox address, no tag. */
  address: string;
  /** The Slack user whose sessions are mail addresses (config.json mailbox.owner). Nobody else's are. */
  owner: string;
  /** The mailbox CLI settings file when it is not the CLI's default (the CLI must read the same one). */
  clientFile?: string;
}

let identity: MailboxIdentity | null = null;

/** Set once the mailbox poller starts (src/index.ts); null switches the per-session environment off. */
export function setMailboxIdentity(next: MailboxIdentity | null): void {
  identity = next;
}

export function getMailboxIdentity(): MailboxIdentity | null {
  return identity;
}

/** The session's own mail address, when this instance reads mail and the session has a thread. */
export function sessionMailAddress(channel: string | undefined, threadTs: string | undefined): string | undefined {
  const tag = sessionMailTag(channel, threadTs);
  return identity && tag ? `${identity.address}/${tag}` : undefined;
}

/**
 * Agent environment for one turn: the session's address (and the CLI settings file) so its mail is from it. Only a
 * session of the mailbox owner gets one — mail to a session runs a turn as that session's owner, so no other user's
 * (or environment user's) session is an address another agent could write to.
 */
export function mailboxEnvFor(
  slack: { channel?: string; threadTs?: string } | undefined,
  sessionOwner: string | undefined,
): Record<string, string> {
  if (!identity || !sessionOwner || sessionOwner !== identity.owner) return {};
  const address = sessionMailAddress(slack?.channel, slack?.threadTs);
  if (!address) return {};
  return { MAILBOX_ADDRESS: address, ...(identity?.clientFile ? { MAILBOX_CONFIG: identity.clientFile } : {}) };
}
