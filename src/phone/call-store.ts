/**
 * Phone call records: one JSON file per call under `<phone dir>/calls/` (.prd/31-phone-calls-architecture.md §4.3).
 *
 * The daemon is the only writer. Every change goes through {@link PhoneCallStore.update}, which persists the record
 * with `atomicWriteJson` (a `.bak` of the last good generation) and tells the subscribers — the dashboard pushes
 * the card, server-tools reads the file. Writes are coalesced: a burst of updates during speech (a transcript line,
 * then its synthesis timing) costs one write per 250 ms per call, and the last state always lands.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteJson, readJsonWithBackup } from '@soma/common/atomic-json';
import { Logger } from '../logger';

const logger = new Logger('PhoneCallStore');

export type PhoneCallDirection = 'outbound' | 'inbound';
export type PhoneCallStatus = 'dialing' | 'active' | 'ended';

export interface PhoneTranscriptLine {
  role: 'agent' | 'peer';
  text: string;
  at: number;
  /** The agent was cut off by the other party while saying this. */
  interrupted?: boolean;
}

export type PhoneWorkEvent =
  | { kind: 'instruction'; at: number; text: string }
  | { kind: 'stt'; at: number; text: string; ms: number; audioMs: number }
  | { kind: 'reply'; at: number; text: string; model?: string; firstTokenMs?: number; ms: number }
  | { kind: 'tool'; at: number; name: string; input: unknown; result?: string }
  | { kind: 'tts'; at: number; text: string; firstByteMs: number; audioMs: number }
  | { kind: 'event'; at: number; text: string }
  | { kind: 'error'; at: number; stage: string; message: string };

export interface PhoneCallRecord {
  id: string;
  env: string;
  direction: PhoneCallDirection;
  ourNumber: string;
  peerNumber: string;
  title: string;
  purpose?: string;
  scenario?: string;
  status: PhoneCallStatus;
  /** `completed` only when the call was answered; else no-answer / busy / rejected / canceled / failed. */
  endedStatus?: string;
  createdAt: number;
  answeredAt?: number;
  endedAt?: number;
  durationSec?: number;
  /** Who asked for the call (Slack user id) — or the environment owner for an inbound call. */
  requester?: string;
  conversationId?: string;
  channel?: string;
  threadTs?: string;
  model?: string;
  voice?: string;
  transcript: PhoneTranscriptLine[];
  work: PhoneWorkEvent[];
  summary?: string;
}

/** What a card needs: everything but the full transcript and the work log. */
export interface PhoneCallSummary extends Omit<PhoneCallRecord, 'transcript' | 'work'> {
  /** The last few lines, for the card's face. */
  tail: PhoneTranscriptLine[];
  lines: number;
}

export const WORK_EVENT_CAP = 500;
export const TRANSCRIPT_CAP = 400;
const TAIL_LINES = 4;
const WRITE_DELAY_MS = 250;
const CALL_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function isCallId(id: unknown): id is string {
  return typeof id === 'string' && CALL_ID_RE.test(id);
}

export function summarizeCall(record: PhoneCallRecord): PhoneCallSummary {
  const { transcript, work: _work, ...rest } = record;
  return { ...rest, tail: transcript.slice(-TAIL_LINES), lines: transcript.length };
}

function validRecord(raw: unknown): raw is PhoneCallRecord {
  const r = raw as PhoneCallRecord | null;
  return (
    !!r &&
    typeof r === 'object' &&
    isCallId(r.id) &&
    typeof r.env === 'string' &&
    Array.isArray(r.transcript) &&
    Array.isArray(r.work)
  );
}

export class PhoneCallStore {
  private readonly dir: string;
  private readonly records = new Map<string, PhoneCallRecord>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly listeners = new Set<(record: PhoneCallRecord) => void>();

  constructor(phoneDir: string) {
    this.dir = path.join(phoneDir, 'calls');
  }

  fileOf(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  onChange(listener: (record: PhoneCallRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A new record (written at once). A second create of the same id replaces the first. */
  create(record: PhoneCallRecord): PhoneCallRecord {
    if (!isCallId(record.id)) throw new Error('phone call id is not a safe file name');
    this.records.set(record.id, record);
    this.flush(record.id);
    this.emit(record);
    return record;
  }

  /** Mutate the record, then persist (coalesced) and notify. Unknown ids are loaded from disk first. */
  update(id: string, mutate: (record: PhoneCallRecord) => void): PhoneCallRecord | undefined {
    const record = this.get(id);
    if (!record) return undefined;
    mutate(record);
    if (record.work.length > WORK_EVENT_CAP) record.work.splice(0, record.work.length - WORK_EVENT_CAP);
    if (record.transcript.length > TRANSCRIPT_CAP)
      record.transcript.splice(0, record.transcript.length - TRANSCRIPT_CAP);
    this.schedule(id, record.status === 'ended');
    this.emit(record);
    return record;
  }

  get(id: string): PhoneCallRecord | undefined {
    if (!isCallId(id)) return undefined;
    const cached = this.records.get(id);
    if (cached) return cached;
    const file = this.fileOf(id);
    if (!fs.existsSync(file)) return undefined;
    try {
      const loaded = readJsonWithBackup(file, (raw) => {
        if (!validRecord(raw)) throw new Error('not a phone call record');
        return raw;
      });
      if (loaded) {
        this.records.set(id, loaded);
        return loaded;
      }
    } catch (err) {
      logger.warn('phone call record unreadable', { id, error: (err as Error).message });
    }
    return undefined;
  }

  /** Every record on disk (newest first), optionally only one conversation's. */
  list(filter: { conversationId?: string; env?: string } = {}, limit = 50): PhoneCallRecord[] {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.json') && !n.endsWith('.bak'));
    } catch {
      return [];
    }
    const out: PhoneCallRecord[] = [];
    for (const name of names) {
      const record = this.get(name.slice(0, -'.json'.length));
      if (!record) continue;
      if (filter.conversationId && record.conversationId !== filter.conversationId) continue;
      if (filter.env && record.env !== filter.env) continue;
      out.push(record);
    }
    return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  /** Write every pending record now (shutdown). */
  flushAll(): void {
    for (const id of [...this.timers.keys()]) this.flush(id);
  }

  private schedule(id: string, now: boolean): void {
    if (now) {
      this.flush(id);
      return;
    }
    if (this.timers.has(id)) return;
    const timer = setTimeout(() => this.flush(id), WRITE_DELAY_MS);
    timer.unref?.();
    this.timers.set(id, timer);
  }

  private flush(id: string): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    const record = this.records.get(id);
    if (!record) return;
    try {
      atomicWriteJson(this.fileOf(id), record, { validatePrevious: validRecord });
    } catch (err) {
      logger.error('phone call record not saved', { id, error: (err as Error).message });
    }
  }

  private emit(record: PhoneCallRecord): void {
    for (const listener of this.listeners) {
      try {
        listener(record);
      } catch (err) {
        logger.warn('phone call listener failed', { error: (err as Error).message });
      }
    }
  }
}
