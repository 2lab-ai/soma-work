/**
 * `phone_call` · `phone_calls` — an environment's phone line (.prd/30-phone-calls-spec.md §3.1, .prd/31 §1).
 *
 * The line itself lives in the daemon: the platform keeps one connection per number, and this stdio server lives
 * only as long as one session. So `phone_call` writes a request file into `<phone dir>/requests/` (a directory no
 * model can write) and waits for the daemon's answer file; `phone_calls` reads the daemon's call records.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_MAX_MINUTES,
  newRequestId,
  normalizePhoneNumber,
  type PhoneCallRequest,
  type PhoneCallRequestResult,
  type PhoneEnvConfig,
  parsePhoneSection,
  phoneCallsDir,
  phoneRequestsDir,
  writeJsonFileAtomic,
} from '@soma/common/phone';

export class PhoneToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhoneToolError';
  }
}

const RESULT_WAIT_MS = 20_000;
const POLL_MS = 200;
const MAX_WAIT_S = 300;

export interface PhoneContext {
  channel?: string;
  threadTs?: string;
  conversationId?: string;
}

/** `SOMA_PHONE_CONTEXT` as the bot set it — where the call's card goes. Anything malformed is ignored. */
export function phoneContextFromEnv(raw: string | undefined): PhoneContext {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const s = (x: unknown) => (typeof x === 'string' && x.length <= 128 ? x : undefined);
    return {
      ...(s(v.channel) ? { channel: s(v.channel) } : {}),
      ...(s(v.threadTs) ? { threadTs: s(v.threadTs) } : {}),
      ...(s(v.conversationId) ? { conversationId: s(v.conversationId) } : {}),
    };
  } catch {
    return {};
  }
}

export function envPhone(server: string, section: unknown): PhoneEnvConfig {
  if (section === undefined) throw new PhoneToolError(`Server ${server} has no phone section`);
  try {
    return parsePhoneSection(server, section);
  } catch (err) {
    throw new PhoneToolError((err as Error).message);
  }
}

export type PhoneCallArgs = Pick<PhoneCallRequest, 'to' | 'title' | 'purpose' | 'scenario' | 'maxMinutes'>;

/** The tool's arguments, checked against the environment's own limits. */
export function phoneCallArgs(cfg: PhoneEnvConfig, args: Record<string, unknown>): PhoneCallArgs {
  const to = normalizePhoneNumber(args.to);
  if (!to) throw new PhoneToolError('to must be a Korean phone number (e.g. 010-1234-5678)');
  if (cfg.outbound.allowTo && !cfg.outbound.allowTo.includes(to)) {
    throw new PhoneToolError(`not dialed: ${to} is not in this environment's outbound.allowTo`);
  }
  const purpose = typeof args.purpose === 'string' ? args.purpose.trim() : '';
  if (!purpose)
    throw new PhoneToolError('purpose is required: what the call is for, in the words the agent should follow');
  if (purpose.length > 4000) throw new PhoneToolError('purpose is longer than 4000 characters');
  const scenario = typeof args.scenario === 'string' && args.scenario.trim() ? args.scenario.trim() : undefined;
  if (scenario && scenario.length > 8000) throw new PhoneToolError('scenario is longer than 8000 characters');
  const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim().slice(0, 120) : '';
  const rawMax = args.max_minutes;
  const max = typeof rawMax === 'number' && Number.isFinite(rawMax) ? rawMax : DEFAULT_MAX_MINUTES;
  return {
    to,
    title,
    purpose,
    ...(scenario ? { scenario } : {}),
    maxMinutes: Math.max(1, Math.min(Math.floor(max), cfg.outbound.maxMinutes)),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Hand the call to the daemon and wait for its answer. Throws {@link PhoneToolError} when the daemon refused or did
 * not answer (the request is then withdrawn, so a late daemon does not dial a call nobody waits for).
 */
export async function requestCall(
  phoneDir: string,
  request: Omit<PhoneCallRequest, 'rid' | 'createdAt'>,
  waitMs = RESULT_WAIT_MS,
): Promise<{ rid: string; callId: string }> {
  const rid = newRequestId();
  const dir = phoneRequestsDir(phoneDir);
  const file = path.join(dir, `${rid}.json`);
  const resultFile = path.join(dir, `${rid}.result.json`);
  writeJsonFileAtomic(file, { ...request, rid, createdAt: Date.now() });
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(resultFile)) {
      let result: PhoneCallRequestResult;
      try {
        result = JSON.parse(fs.readFileSync(resultFile, 'utf-8')) as PhoneCallRequestResult;
      } catch {
        await sleep(POLL_MS);
        continue;
      }
      try {
        fs.rmSync(resultFile, { force: true });
      } catch {
        // Tidying only: a placed call must never turn into a failure (a retry would dial again).
      }
      if (!result.ok || !result.callId)
        throw new PhoneToolError(`not dialed: ${result.error ?? 'the phone service refused'}`);
      return { rid, callId: result.callId };
    }
    await sleep(POLL_MS);
  }
  // Withdraw: if the daemon has not claimed it yet, it never will.
  try {
    fs.rmSync(file);
    throw new PhoneToolError('not dialed: the phone service is not running (no answer in 20 s)');
  } catch (err) {
    if (err instanceof PhoneToolError) throw err;
    throw new PhoneToolError(
      'the phone service took the request but did not answer in time — check phone_calls before calling again',
    );
  }
}

interface CallRecordLike {
  id: string;
  env: string;
  status: string;
  endedStatus?: string;
  createdAt: number;
  durationSec?: number;
  requester?: string;
  transcript?: Array<{ role: string; text: string; at: number; interrupted?: boolean }>;
  work?: unknown[];
  [key: string]: unknown;
}

function parseRecord(file: string): CallRecordLike | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf-8')) as CallRecordLike;
    return v && typeof v === 'object' && typeof v.id === 'string' && typeof v.env === 'string' ? v : null;
  } catch {
    return null;
  }
}

/**
 * One call record, as the daemon's store reads it: the live file, else its last good copy (`.bak`, kept by the
 * store's atomic writes) with a warning — a torn file must not make a call vanish from `phone_calls`.
 */
function readRecord(phoneDir: string, id: string): CallRecordLike | null {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
  const file = path.join(phoneCallsDir(phoneDir), `${id}.json`);
  const live = parseRecord(file);
  if (live || !fs.existsSync(file)) return live;
  const backup = parseRecord(`${file}.bak`);
  process.stderr.write(
    `[server-tools] phone call record ${id} is unreadable — ${backup ? 'read from its .bak' : 'and so is its .bak'}\n`,
  );
  return backup;
}

/** One call as the model reads it: no work log (it is for people), the transcript as lines. */
export function callView(r: CallRecordLike): Record<string, unknown> {
  const { work: _work, transcript, ...rest } = r;
  return {
    ...rest,
    transcript: (transcript ?? []).map(
      (l) => `${l.role === 'peer' ? '상대' : '에이전트'}: ${l.text}${l.interrupted ? ' (끊김)' : ''}`,
    ),
  };
}

/** The env's recent calls (newest first), or one call — waiting up to `waitSeconds` for it to end. */
export async function readCalls(
  phoneDir: string,
  server: string,
  args: Record<string, unknown>,
  requester: string | undefined,
  isAdmin: boolean,
): Promise<unknown> {
  // A call's words are its requester's: a session with no requester reads nothing (fail closed).
  if (!requester && !isAdmin)
    throw new PhoneToolError('phone_calls: the session has no requester, so no call is visible');
  const visible = (r: CallRecordLike) => r.env === server && (isAdmin || r.requester === requester);
  if (typeof args.call_id === 'string' && args.call_id) {
    const id = args.call_id;
    const wait = typeof args.wait_seconds === 'number' ? Math.max(0, Math.min(args.wait_seconds, MAX_WAIT_S)) : 0;
    const deadline = Date.now() + wait * 1000;
    let rec = readRecord(phoneDir, id);
    while (rec && visible(rec) && rec.status !== 'ended' && Date.now() < deadline) {
      await sleep(1000);
      rec = readRecord(phoneDir, id) ?? rec;
    }
    if (!rec || !visible(rec)) throw new PhoneToolError(`Server ${server} has no call ${id}`);
    return callView(rec);
  }
  let names: string[] = [];
  try {
    names = fs.readdirSync(phoneCallsDir(phoneDir)).filter((n) => n.endsWith('.json'));
  } catch (err) {
    // No directory yet = no calls yet. Anything else must not look like "no call was placed".
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { calls: [] };
    throw new PhoneToolError(`phone_calls: the call records are unreadable (${(err as NodeJS.ErrnoException).code})`);
  }
  const calls = names
    .map((n) => readRecord(phoneDir, n.slice(0, -5)))
    .filter((r): r is CallRecordLike => !!r && visible(r))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 20)
    .map((r) => {
      const { work: _w, transcript, ...rest } = r;
      return { ...rest, lines: transcript?.length ?? 0 };
    });
  return { calls };
}
