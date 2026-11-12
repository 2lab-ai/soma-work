/**
 * The environment tools' audit ledger (env-access WU3, #1211): one JSON line per write an environment user makes
 * on a person's behalf — a PR approval, a merge, a login. Appended before the write runs and again with its
 * outcome. A write whose intent cannot be recorded does not run.
 *
 * The directory is `<DATA_DIR>/env-audit`, which no model session writes. Files are 0600, opened with O_APPEND and
 * O_NOFOLLOW, and synced before the write proceeds.
 */

import fs from 'node:fs';
import path from 'node:path';

const FILE = 'env-audit.jsonl';

export interface AuditRecord {
  /** The server-tools environment (config key), e.g. `dev2`. */
  server: string;
  /** Its environment user, e.g. `env:acme-dev2`, when configured. */
  envUser?: string;
  /** The person the session runs for, as the bot passed it (`SOMA_REQUESTER`). */
  requester?: string;
  tool: string;
  action: string;
  /** `intent` before the write, then `done` or `failed`. */
  phase: 'intent' | 'done' | 'failed';
  detail?: Record<string, unknown>;
}

export class AuditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditError';
  }
}

/** Append one record, with a timestamp. Throws `AuditError` when it cannot be written and synced. */
export function appendAudit(dir: string | undefined, record: AuditRecord, now: Date = new Date()): void {
  if (!dir) throw new AuditError('the audit ledger is not configured (SOMA_AUDIT_DIR); no write was made');
  const line = `${JSON.stringify({ ts: now.toISOString(), ...record })}\n`;
  let fd: number | undefined;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fd = fs.openSync(
      path.join(dir, FILE),
      fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } catch (err) {
    throw new AuditError(
      `the audit ledger could not be written (${(err as NodeJS.ErrnoException).code ?? 'error'}); no write was made`,
    );
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
