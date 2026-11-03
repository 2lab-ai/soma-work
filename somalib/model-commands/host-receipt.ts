import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SessionResourceSnapshot } from './session-types';

/**
 * #846 — what the host applied for a session, written after each model-command write it handles and read back by the
 * model-command server (`GET_SESSION` → `host`). The server's own copy answers before the host has applied anything;
 * this file is the host's word: the links and sequence it holds, the task card's TL;DR and NEEDS YOU reason, and how
 * it handled the model's last `UPDATE_SESSION`.
 */
export interface HostReceipt {
  /** The host's link sequence — what the next `expectedSequence` must match. */
  sequence: number;
  /** The host's resource snapshot (links, active, instructions). */
  session: SessionResourceSnapshot;
  title?: string;
  /** The task card's TL;DR as the host holds it. */
  tldr?: string[];
  /** The reason the card waits in NEEDS YOU (the ⚠️ line), when it does. */
  followUp?: string;
  /** The model's last `UPDATE_SESSION` as the host handled it (whichever turn or server sent it). */
  lastWrite?: HostWriteReceipt;
  /**
   * How the host handled each recent write, by `receiptId` (the most recent {@link HOST_RECEIPT_MAX_ACKS}). Each
   * model-command server checks its own write here — never the single `lastWrite`, which another server's write or a
   * superseded turn's late callback can replace.
   */
  acks?: Record<string, HostWriteReceipt>;
  /** When the host wrote this (epoch ms). */
  at: number;
}

export interface HostWriteReceipt {
  /** The server's `receiptId` for that write. */
  receiptId?: string;
  /** False when the host could not apply it (the card did not change). */
  ok: boolean;
  /** Why not, when `ok` is false (e.g. `SEQUENCE_MISMATCH`). */
  reason?: string;
  /** The write's TL;DR reached the card. */
  tldrApplied?: boolean;
  /**
   * The write's instruction operations: waiting for the user's y/n in Slack, or refused (a dashboard task has no
   * thread to ask in). `ok` covers the resource operations only.
   */
  instructions?: 'pending_confirmation' | 'refused';
  at: number;
}

export const HOST_RECEIPT_DIR = 'model-command-receipts';

/**
 * #881 A — the longest GET_SESSION `waitForAckMs`. The host applies a write about 20 s after the model got its result
 * when its stream is busy; 30 s covers that and still answers well inside an MCP call's time.
 */
export const GET_SESSION_MAX_WAIT_MS = 30_000;

/** How many write acks a receipt keeps. */
export const HOST_RECEIPT_MAX_ACKS = 20;

/** The ack ledger after `write`: the previous acks plus this one, the most recent {@link HOST_RECEIPT_MAX_ACKS}. */
export function withAck(
  acks: Record<string, HostWriteReceipt> | undefined,
  write: HostWriteReceipt | undefined,
): Record<string, HostWriteReceipt> | undefined {
  const all: Record<string, HostWriteReceipt> = {};
  for (const [id, ack] of Object.entries(acks ?? {})) if (isAck(ack)) all[id] = ack;
  if (write?.receiptId) all[write.receiptId] = write;
  const kept = Object.entries(all)
    .sort(([, a], [, b]) => (b.at ?? 0) - (a.at ?? 0))
    .slice(0, HOST_RECEIPT_MAX_ACKS);
  return kept.length ? Object.fromEntries(kept) : undefined;
}

/**
 * #881 B1 — when the model-command server issued a write: its `receiptId` is `r_<Date.now() base 36>_…`. The host
 * applies a write late (~20 s when busy), so this — not the apply time — is when the model made it.
 */
export function receiptIssuedAt(receiptId: unknown): number | undefined {
  if (typeof receiptId !== 'string') return undefined;
  const m = /^r_([0-9a-z]+)_/.exec(receiptId);
  if (!m) return undefined;
  const t = Number.parseInt(m[1], 36);
  return Number.isFinite(t) && t > 0 ? t : undefined;
}

/** The receipt file of a session: one per session key, a hash so any key is a safe file name. */
export function hostReceiptPath(dataDir: string, sessionKey: string): string {
  const name = createHash('sha256').update(sessionKey).digest('hex').slice(0, 24);
  return path.join(dataDir, HOST_RECEIPT_DIR, `${name}.json`);
}

/** One write ack as the host writes it — anything else in a ledger is dropped, never trusted. */
function isAck(v: unknown): v is HostWriteReceipt {
  if (!v || typeof v !== 'object') return false;
  const a = v as Partial<HostWriteReceipt>;
  return typeof a.ok === 'boolean' && typeof a.at === 'number' && Number.isFinite(a.at);
}

/** The receipt in `file`, or undefined when it is missing, unreadable or not a receipt — never a guess. */
export function readHostReceipt(file: string): HostReceipt | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Partial<HostReceipt>;
  if (typeof r.sequence !== 'number' || typeof r.at !== 'number') return undefined;
  const s = r.session as Partial<SessionResourceSnapshot> | undefined;
  // Every link is checked: GET_SESSION resyncs onto this snapshot, and one bad element would throw there.
  if (!s || !isLinkList(s.issues) || !isLinkList(s.prs) || !isLinkList(s.docs)) return undefined;
  const { acks: rawAcks, lastWrite, tldr, followUp, title } = r;
  const acks: Record<string, HostWriteReceipt> = {};
  if (rawAcks && typeof rawAcks === 'object' && !Array.isArray(rawAcks)) {
    for (const [id, ack] of Object.entries(rawAcks)) if (isAck(ack)) acks[id] = ack;
  }
  // Only the fields the host writes reach the model, each as the host's word: anything else in the file is dropped,
  // and a malformed optional field is dropped rather than passed on (#881 C1).
  const active = (s.active ?? {}) as Record<string, unknown>;
  const activeLinks: SessionResourceSnapshot['active'] = {};
  for (const kind of ['issue', 'pr', 'doc'] as const) {
    if (isLink(active[kind])) activeLinks[kind] = active[kind] as SessionResourceSnapshot['active'][typeof kind];
  }
  return {
    sequence: r.sequence,
    at: r.at,
    session: {
      issues: s.issues as SessionResourceSnapshot['issues'],
      prs: s.prs as SessionResourceSnapshot['prs'],
      docs: s.docs as SessionResourceSnapshot['docs'],
      active: activeLinks,
      instructions: Array.isArray(s.instructions)
        ? s.instructions.filter(
            (i) => !!i && typeof i === 'object' && typeof (i as { text?: unknown }).text === 'string',
          )
        : [],
      sequence: typeof s.sequence === 'number' && Number.isFinite(s.sequence) ? s.sequence : r.sequence,
    },
    ...(typeof title === 'string' ? { title } : {}),
    ...(Array.isArray(tldr) && tldr.every((l) => typeof l === 'string') ? { tldr } : {}),
    ...(typeof followUp === 'string' ? { followUp } : {}),
    ...(isAck(lastWrite) ? { lastWrite } : {}),
    ...(Object.keys(acks).length ? { acks } : {}),
  };
}

/** A snapshot link as the host writes it: an object with a string `url`. */
function isLink(v: unknown): boolean {
  return !!v && typeof v === 'object' && typeof (v as { url?: unknown }).url === 'string';
}

/** A snapshot link list as the host writes it: objects with a string `url`. */
function isLinkList(v: unknown): boolean {
  return Array.isArray(v) && v.every(isLink);
}
