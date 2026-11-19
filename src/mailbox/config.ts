/**
 * The `mailbox` section of config.json — this instance reads its own agent-mailbox inbox (2lab-ai/agent-mailbox).
 *
 * ```json
 * "mailbox": {
 *   "client": "~/.config/agent-mailbox/client.json",   // the mailbox CLI's settings: url, token, address
 *   "owner": "U0123ABC",                                // the Slack user whose sessions handle mail
 *   "channel": "C0123ABC",                              // optional — where mail threads open; default the owner's DM
 *   "intervalSeconds": 15,                              // optional — pause while mail waits on a busy session
 *   "allowFrom": ["soma-work:*:*"],                     // optional — sender patterns; default everyone
 *   "cli": "/usr/local/bin/mailbox"                     // optional — how turns call the CLI; default `mailbox`
 * }
 * ```
 *
 * The token stays in the mailbox CLI's own file (one copy); it is read again on every poll, so a reinstall that
 * rotates it needs no restart. Absent section = no poller.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface MailboxConfig {
  clientFile: string;
  owner: string;
  channel?: string;
  intervalMs: number;
  /** A mail for a thread whose session stays busy this long opens a new thread instead. */
  busyMaxWaitMs: number;
  allowFrom: string[];
  /** The mailbox CLI as the turn text names it. */
  cli: string;
}

export interface MailboxClientSettings {
  url: string;
  token: string;
  address: string;
}

const ADDRESS = /^[a-z0-9][a-z0-9._-]{0,62}:[a-z0-9][a-z0-9._-]{0,62}:[a-z0-9][a-z0-9._-]{0,62}$/;
const PATTERN = /^(\*|[a-z0-9][a-z0-9._-]{0,62}):(\*|[a-z0-9][a-z0-9._-]{0,62}):(\*|[a-z0-9][a-z0-9._-]{0,62})$/;

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

export type ParsedMailboxConfig = { ok: true; config: MailboxConfig } | { ok: false; error: string } | undefined;

/** `undefined` when the section is absent; an error result when it is present but unusable. */
export function parseMailboxConfig(raw: unknown): ParsedMailboxConfig {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'mailbox must be a JSON object' };
  const r = raw as Record<string, unknown>;
  if (r.enabled === false) return undefined;
  const owner = typeof r.owner === 'string' ? r.owner.trim() : '';
  if (!/^[UW][A-Z0-9]{2,}$/.test(owner)) return { ok: false, error: 'mailbox.owner must be a Slack user id' };
  const channel = typeof r.channel === 'string' && r.channel.trim() ? r.channel.trim() : undefined;
  if (channel && !/^[CDG][A-Z0-9]{2,}$/.test(channel))
    return { ok: false, error: 'mailbox.channel must be a Slack channel id' };
  const clientFile = expandHome(
    typeof r.client === 'string' && r.client.trim() ? r.client.trim() : '~/.config/agent-mailbox/client.json',
  );
  const seconds = Number(r.intervalSeconds ?? 15);
  if (!Number.isFinite(seconds) || seconds < 2 || seconds > 3600)
    return { ok: false, error: 'mailbox.intervalSeconds must be 2..3600' };
  const allowFrom = Array.isArray(r.allowFrom) ? r.allowFrom.map((p) => String(p).trim().toLowerCase()) : ['*:*:*'];
  const bad = allowFrom.find((p) => !PATTERN.test(p));
  if (bad !== undefined) return { ok: false, error: `mailbox.allowFrom has a bad pattern "${bad}"` };
  const cli = typeof r.cli === 'string' && r.cli.trim() ? r.cli.trim() : 'mailbox';
  if (!/^[\w./~-]+$/.test(cli)) return { ok: false, error: 'mailbox.cli must be a command name or path' };
  return {
    ok: true,
    config: {
      cli,
      clientFile,
      owner,
      ...(channel ? { channel } : {}),
      intervalMs: seconds * 1000,
      busyMaxWaitMs: 10 * 60_000,
      allowFrom,
    },
  };
}

/** Read the mailbox CLI's settings file. Throws with a message that names the file, never its contents. */
export function readClientSettings(
  file: string,
  read: (f: string) => string = (f) => fs.readFileSync(f, 'utf8'),
): MailboxClientSettings {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(read(file));
  } catch (error) {
    throw new Error(`cannot read mailbox client settings ${file}: ${(error as Error).message.split('\n')[0]}`);
  }
  const url = typeof parsed.url === 'string' ? parsed.url.replace(/\/+$/, '') : '';
  const token = typeof parsed.token === 'string' ? parsed.token : '';
  const address = typeof parsed.address === 'string' ? parsed.address.trim().toLowerCase() : '';
  if (!/^https?:\/\//.test(url)) throw new Error(`${file}: url must be http(s)`);
  if (!token) throw new Error(`${file}: token is missing`);
  if (!ADDRESS.test(address)) throw new Error(`${file}: address must be <agent>:<host>:<instance>`);
  return { url, token, address };
}

export function matchesAddressPattern(address: string, pattern: string): boolean {
  const a = address.split(':');
  const p = pattern.split(':');
  return a.length === 3 && p.length === 3 && p.every((seg, i) => seg === '*' || seg === a[i]);
}
