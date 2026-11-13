/** env-access WU3 (#1211): the environment tools' audit ledger. A write whose intent cannot be recorded does not run. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditError, appendAudit } from './env-audit.js';

let dir: string;

beforeEach(() => {
  dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'env-audit-')), 'env-audit');
});

afterEach(() => {
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

describe('appendAudit', () => {
  it('appends one JSON line per record, 0600, in a 0700 directory', () => {
    const at = new Date('2026-11-13T00:00:00Z');
    appendAudit(
      dir,
      { server: 'dev2', envUser: 'env:acme-dev2', tool: 'gh_pr', action: 'approve', phase: 'intent' },
      at,
    );
    appendAudit(dir, { server: 'dev2', tool: 'gh_pr', action: 'approve', phase: 'done', detail: { pr: 7 } }, at);
    const file = path.join(dir, 'env-audit.jsonl');
    const lines = fs
      .readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toEqual([
      {
        ts: at.toISOString(),
        server: 'dev2',
        envUser: 'env:acme-dev2',
        tool: 'gh_pr',
        action: 'approve',
        phase: 'intent',
      },
      { ts: at.toISOString(), server: 'dev2', tool: 'gh_pr', action: 'approve', phase: 'done', detail: { pr: 7 } },
    ]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('refuses when no directory is configured', () => {
    expect(() => appendAudit(undefined, { server: 's', tool: 't', action: 'a', phase: 'intent' })).toThrow(AuditError);
  });

  // trinity R1 (astra): a torn line from an earlier failed append must not swallow the next record.
  it('starts a new line when the ledger does not end with one', () => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'env-audit.jsonl'), '{"torn', { mode: 0o600 });
    appendAudit(dir, { server: 's', tool: 't', action: 'a', phase: 'intent' });
    const lines = fs.readFileSync(path.join(dir, 'env-audit.jsonl'), 'utf8').split('\n');
    expect(lines[0]).toBe('{"torn');
    expect(JSON.parse(lines[1])).toMatchObject({ server: 's', phase: 'intent' });
  });

  it('says only that the ledger failed, so the caller can tell before from after', () => {
    expect(() => appendAudit(undefined, { server: 's', tool: 't', action: 'a', phase: 'done' })).toThrow(
      /^the audit ledger is not configured \(SOMA_AUDIT_DIR\)$/,
    );
  });

  it('refuses to follow a link in place of the ledger file', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(path.join(path.dirname(dir), 'elsewhere'), path.join(dir, 'env-audit.jsonl'));
    expect(() => appendAudit(dir, { server: 's', tool: 't', action: 'a', phase: 'intent' })).toThrow(
      /could not be written/,
    );
  });
});
