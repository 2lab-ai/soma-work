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

/** How many write acks a receipt keeps. */
export const HOST_RECEIPT_MAX_ACKS = 20;

/** The ack ledger after `write`: the previous acks plus this one, the most recent {@link HOST_RECEIPT_MAX_ACKS}. */
export function withAck(
  acks: Record<string, HostWriteReceipt> | undefined,
  write: HostWriteReceipt | undefined,
): Record<string, HostWriteReceipt> | undefined {
  const all = { ...(acks ?? {}) };
  if (write?.receiptId) all[write.receiptId] = write;
  const kept = Object.entries(all)
    .sort(([, a], [, b]) => (b.at ?? 0) - (a.at ?? 0))
    .slice(0, HOST_RECEIPT_MAX_ACKS);
  return kept.length ? Object.fromEntries(kept) : undefined;
}

/** The receipt file of a session: one per session key, a hash so any key is a safe file name. */
export function hostReceiptPath(dataDir: string, sessionKey: string): string {
  const name = createHash('sha256').update(sessionKey).digest('hex').slice(0, 24);
  return path.join(dataDir, HOST_RECEIPT_DIR, `${name}.json`);
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
  if (!s || !Array.isArray(s.issues) || !Array.isArray(s.prs) || !Array.isArray(s.docs)) return undefined;
  return r as HostReceipt;
}
