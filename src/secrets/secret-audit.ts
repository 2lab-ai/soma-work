/**
 * The secret store's audit ledger (secret-access WU1, #1337, `.prd/33-secret-access-architecture.md` §2.1): one
 * JSON line per change an admin makes — who, when, what, which name. `DATA_DIR/secret-audit.jsonl`, 0600, opened
 * with O_APPEND and O_NOFOLLOW, synced. No model reads or writes it (`approvalRecordPaths`).
 *
 * Never a value, its length or a hash of it: the record type has no such field, and the writer copies only the
 * fields it knows, so a caller's mistake cannot put one on disk.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { DATA_DIR } from '../env-paths';

export const SECRET_AUDIT_FILE = 'secret-audit.jsonl';

/** How much of the ledger the 비밀 tab reads back for "last changed by" — the newest end. */
const READ_TAIL_BYTES = 1024 * 1024;

export type SecretAuditAction =
  | 'secret.create'
  | 'secret.overwrite'
  | 'secret.delete'
  /** An admin's answer to a secret-use card (secret-access WU2): this thread, never, or from now on. */
  | 'use.once'
  | 'use.deny'
  | 'use.always'
  /** A "who may use it" change on the 비밀 tab. */
  | 'grant.add'
  | 'grant.remove';

export interface SecretAuditRecord {
  /** The admin's Slack id. */
  actor: string;
  action: SecretAuditAction;
  /** The secret's name. */
  name: string;
  /** Whose tools the answer or grant is about. */
  userId?: string;
  /** The server-tools tool and server a secret-use card was about. */
  tool?: string;
  server?: string;
}

const FIELDS = ['actor', 'action', 'name', 'userId', 'tool', 'server'] as const;

/** Append one record. Throws when it cannot be written and synced — the caller decides what that means. */
export function appendSecretAudit(record: SecretAuditRecord, dataDir: string = DATA_DIR, now: Date = new Date()): void {
  const line: Record<string, string> = { at: now.toISOString() };
  for (const key of FIELDS) {
    const value = record[key];
    if (typeof value === 'string') line[key] = value;
  }
  let buf = Buffer.from(`${JSON.stringify(line)}\n`);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const fd = fs.openSync(
    path.join(dataDir, SECRET_AUDIT_FILE),
    fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const size = fs.fstatSync(fd).size;
    if (size > 0) {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) buf = Buffer.concat([Buffer.from('\n'), buf]);
    }
    for (let off = 0; off < buf.length; ) off += fs.writeSync(fd, buf, off, buf.length - off);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export interface SecretChange {
  at: string;
  actor: string;
  action: SecretAuditAction;
}

/** The newest change of each secret name in the ledger (empty when there is none). */
export function lastSecretChanges(dataDir: string = DATA_DIR): Map<string, SecretChange> {
  const out = new Map<string, SecretChange>();
  let text: string;
  try {
    const file = path.join(dataDir, SECRET_AUDIT_FILE);
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const length = Math.min(size, READ_TAIL_BYTES);
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, size - length);
      text = buf.toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    let row: Partial<SecretChange & { name: string }>;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // a torn line, or the cut at the start of the tail
    }
    if (typeof row.name !== 'string' || typeof row.at !== 'string' || typeof row.actor !== 'string') continue;
    if (typeof row.action !== 'string' || !row.action.startsWith('secret.')) continue;
    out.set(row.name, { at: row.at, actor: row.actor, action: row.action as SecretAuditAction });
  }
  return out;
}
