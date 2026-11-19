/**
 * Phone environments and the request files between server-tools and the daemon
 * (.prd/31-phone-calls-architecture.md §4.1–4.2). Both processes read the same `phone` section of a server-tools
 * environment and the same request shape, so the rules live here once.
 *
 * Pure apart from small synchronous file writes; no work at module load (MCP servers import it).
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── numbers ─────────────────────────────────────────────────

/**
 * A Korean phone number as digits: `+82 10-1234-5678` → `01012345678`. Accepts landline, mobile, 070 and
 * 8-digit representative numbers (15xx-xxxx). Anything else is `null`.
 */
export function normalizePhoneNumber(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let d = input.replace(/[\s().-]/g, '');
  if (d.startsWith('+82')) d = `0${d.slice(3).replace(/^0/, '')}`;
  if (!/^\d+$/.test(d)) return null;
  return /^(0\d{8,10}|1\d{7})$/.test(d) ? d : null;
}

// ── environment config ─────────────────────────────────────

export interface PhoneVoiceSettings {
  url: string;
  voice: string;
  model: string;
  language: string;
  /** Speech rate, 0.5–2 (1.5 = 1.5x faster, same pitch). Unset = as the voice service speaks. */
  speed?: number;
}

export const MIN_VOICE_SPEED = 0.5;
export const MAX_VOICE_SPEED = 2;

export interface PhoneEnvConfig {
  provider: 'koreaaitel';
  /** Resolved secret value in the processes that resolve secrets; the `{"$secret"}` reference elsewhere. */
  apiKey: unknown;
  accountId: string;
  number: string;
  /** Slack user who owns the number: inbound calls are reported to them. */
  owner?: string;
  voice: PhoneVoiceSettings;
  /** Model or alias for the call agent; unset = the requester's aux `sonnet` tier. */
  model?: string;
  outbound: { systemPrompt?: string; maxMinutes: number; allowTo?: string[] };
  inbound: { enabled: boolean; systemPrompt?: string; scenario?: string; greeting: string };
}

export const DEFAULT_INBOUND_GREETING = '안녕하세요, 소마입니다. 무엇을 도와드릴까요?';
export const DEFAULT_MAX_MINUTES = 5;
export const MAX_MAX_MINUTES = 30;

export class PhoneConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhoneConfigError';
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/**
 * The `phone` section of server `name`, checked and with defaults filled in. Throws {@link PhoneConfigError} with
 * a message that names fields, never values (the section holds a key).
 */
export function parsePhoneSection(name: string, raw: unknown): PhoneEnvConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PhoneConfigError(`server ${name}: phone must be an object`);
  }
  const p = raw as Record<string, unknown>;
  const provider = p.provider ?? 'koreaaitel';
  if (provider !== 'koreaaitel') throw new PhoneConfigError(`server ${name}: phone.provider must be "koreaaitel"`);
  const accountId = str(p.accountId);
  if (!accountId || !/^AC[A-Za-z0-9]{4,64}$/.test(accountId)) {
    throw new PhoneConfigError(`server ${name}: phone.accountId must be the account id (AC…)`);
  }
  const number = normalizePhoneNumber(p.number);
  if (!number) throw new PhoneConfigError(`server ${name}: phone.number must be the account's phone number`);
  if (p.apiKey === undefined || p.apiKey === null || p.apiKey === '') {
    throw new PhoneConfigError(`server ${name}: phone.apiKey is required`);
  }
  const voiceRaw = (p.voice ?? {}) as Record<string, unknown>;
  const url = str(voiceRaw.url);
  if (!url || !/^https?:\/\/[^\s/]+/.test(url))
    throw new PhoneConfigError(`server ${name}: phone.voice.url must be an http(s) URL`);
  const speed = voiceRaw.speed;
  if (
    speed !== undefined &&
    !(typeof speed === 'number' && Number.isFinite(speed) && speed >= MIN_VOICE_SPEED && speed <= MAX_VOICE_SPEED)
  ) {
    throw new PhoneConfigError(`server ${name}: phone.voice.speed must be ${MIN_VOICE_SPEED}–${MAX_VOICE_SPEED}`);
  }
  const out = (p.outbound ?? {}) as Record<string, unknown>;
  const maxRaw = out.maxMinutes;
  const maxMinutes =
    maxRaw === undefined ? DEFAULT_MAX_MINUTES : typeof maxRaw === 'number' && Number.isFinite(maxRaw) ? maxRaw : NaN;
  if (!(maxMinutes >= 1 && maxMinutes <= MAX_MAX_MINUTES)) {
    throw new PhoneConfigError(`server ${name}: phone.outbound.maxMinutes must be 1–${MAX_MAX_MINUTES}`);
  }
  let allowTo: string[] | undefined;
  if (out.allowTo !== undefined) {
    if (!Array.isArray(out.allowTo))
      throw new PhoneConfigError(`server ${name}: phone.outbound.allowTo must be a list`);
    const numbers = out.allowTo.map((n) => normalizePhoneNumber(n));
    if (numbers.some((n) => n === null)) {
      throw new PhoneConfigError(`server ${name}: phone.outbound.allowTo holds a value that is not a phone number`);
    }
    allowTo = numbers as string[];
  }
  const inb = (p.inbound ?? {}) as Record<string, unknown>;
  const owner = str(p.owner);
  if (owner && !/^[UW][A-Z0-9]+$/.test(owner))
    throw new PhoneConfigError(`server ${name}: phone.owner must be a Slack user id`);
  return {
    provider: 'koreaaitel',
    apiKey: p.apiKey,
    accountId,
    number,
    ...(owner ? { owner } : {}),
    voice: {
      url,
      voice: str(voiceRaw.voice) ?? 'cwon',
      model: str(voiceRaw.model) ?? 'drama-3',
      language: str(voiceRaw.language) ?? 'ko',
      ...(typeof speed === 'number' && speed !== 1 ? { speed } : {}),
    },
    ...(str(p.model) ? { model: str(p.model) } : {}),
    outbound: {
      ...(str(out.systemPrompt) ? { systemPrompt: str(out.systemPrompt) } : {}),
      maxMinutes,
      ...(allowTo ? { allowTo } : {}),
    },
    inbound: {
      enabled: inb.enabled !== false,
      ...(str(inb.systemPrompt) ? { systemPrompt: str(inb.systemPrompt) } : {}),
      ...(str(inb.scenario) ? { scenario: str(inb.scenario) } : {}),
      greeting: str(inb.greeting) ?? DEFAULT_INBOUND_GREETING,
    },
  };
}

// ── request files ───────────────────────────────────────────

export interface PhoneCallRequest {
  rid: string;
  env: string;
  to: string;
  title: string;
  purpose: string;
  scenario?: string;
  maxMinutes: number;
  requester: string;
  context?: { channel?: string; threadTs?: string; conversationId?: string };
  createdAt: number;
}

export interface PhoneCallRequestResult {
  ok: boolean;
  callId?: string;
  error?: string;
  /** Placed, but the call cannot be served (the voice host is busy): it only says a notice and hangs up. */
  notice?: string;
}

const RID_RE = /^[a-z0-9]{8,40}$/;

export function phoneRequestsDir(phoneDir: string): string {
  return path.join(phoneDir, 'requests');
}

export function phoneCallsDir(phoneDir: string): string {
  return path.join(phoneDir, 'calls');
}

export function newRequestId(): string {
  return `${Date.now().toString(36)}${randomBytes(6).toString('hex')}`;
}

export function isRequestId(rid: unknown): rid is string {
  return typeof rid === 'string' && RID_RE.test(rid);
}

/** temp write → rename: a reader never sees half a file. */
export function writeJsonFileAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** A request read from disk, checked field by field — the file is the only thing the daemon trusts. */
export function parsePhoneRequest(raw: unknown): PhoneCallRequest | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') return null;
  const to = normalizePhoneNumber(r.to);
  if (!isRequestId(r.rid) || typeof r.env !== 'string' || !to) return null;
  if (typeof r.requester !== 'string' || !/^[UW][A-Z0-9]+$|^env:[a-z0-9-]+$/.test(r.requester)) return null;
  const maxMinutes = typeof r.maxMinutes === 'number' ? r.maxMinutes : DEFAULT_MAX_MINUTES;
  const ctx = (r.context ?? {}) as Record<string, unknown>;
  const s = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);
  return {
    rid: r.rid,
    env: r.env,
    to,
    title: s(r.title, 120) ?? '',
    purpose: s(r.purpose, 4000) ?? '',
    ...(s(r.scenario, 8000) ? { scenario: s(r.scenario, 8000) } : {}),
    maxMinutes: Math.min(Math.max(1, maxMinutes), MAX_MAX_MINUTES),
    requester: r.requester,
    context: {
      ...(s(ctx.channel, 64) ? { channel: s(ctx.channel, 64) } : {}),
      ...(s(ctx.threadTs, 64) ? { threadTs: s(ctx.threadTs, 64) } : {}),
      ...(s(ctx.conversationId, 128) ? { conversationId: s(ctx.conversationId, 128) } : {}),
    },
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
  };
}
