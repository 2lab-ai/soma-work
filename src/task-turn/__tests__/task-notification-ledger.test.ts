/**
 * E2 ④ — the notification ledger (.prd/18 D7, §6.1): delivery state for the
 * notices a task owes its instruction thread, in one file of its own, written
 * atomically. No Slack call here.
 *
 *   L1 register is idempotent by id; a second register of the same id writes nothing.
 *   L2 the state machine: pending → unknown (claimed before the post) → posted(ts);
 *      unknown → pending (a retryable failure) | failed (retries spent);
 *      pending/unknown/failed → resolved | superseded. Anything else is refused.
 *   L3 a key is posted once: a posted entry is never claimed again.
 *   L4 a failed write leaves memory and disk as they were, and throws.
 *   L5 a restart reads the file back; the scan returns what is not posted,
 *      resolved or superseded — a task's link first, then by creation.
 *   L6 a corrupt live file falls back to its backup; no file is an empty ledger.
 */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LedgerTransitionError,
  TaskNotificationLedger,
  type TaskNotificationLedgerEntry,
} from '../task-notification-ledger';

let dir: string;
let file: string;

const TARGET = { channel: 'C123', threadTs: '1700000000.000100' };
function reg(
  ledger: TaskNotificationLedger,
  id: string,
  kind: TaskNotificationLedgerEntry['kind'] = 'result',
  taskId = 'task-a',
) {
  return ledger.register({ id, taskId, kind, ...TARGET, intent: { outcome: 'completed', reason: 'done' } });
}

function failNextWrite(): () => void {
  const real = fs.renameSync;
  (fs as any).renameSync = () => {
    throw new Error('disk full');
  };
  syncBuiltinESMExports();
  return () => {
    (fs as any).renameSync = real;
    syncBuiltinESMExports();
  };
}

describe('TaskNotificationLedger (E2 ④)', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
    file = path.join(dir, 'task-notification-ledger.json');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('L1 — register is idempotent by id and saves before it returns', () => {
    const ledger = new TaskNotificationLedger(file);
    const a = reg(ledger, 'task-a:c1:result');
    expect(a).toMatchObject({ id: 'task-a:c1:result', state: 'pending', attempts: 0, ...TARGET });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).entries).toHaveLength(1);
    const mtime = fs.statSync(file).mtimeMs;
    const again = reg(ledger, 'task-a:c1:result');
    expect(again).toBe(ledger.get('task-a:c1:result'));
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
  });

  it('L2 — the state machine: claim before the post, then posted with its ts', () => {
    const ledger = new TaskNotificationLedger(file);
    reg(ledger, 'n1');
    expect(ledger.claim('n1')).toMatchObject({ state: 'unknown', attempts: 1 });
    expect(ledger.markPosted('n1', '1700000001.000200')).toMatchObject({
      state: 'posted',
      messageTs: '1700000001.000200',
    });
    // Disk agrees.
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')).entries[0];
    expect(saved).toMatchObject({ id: 'n1', state: 'posted', messageTs: '1700000001.000200' });
  });

  it('L2b — a retryable failure goes back to pending; a final one is failed with its reason', () => {
    const ledger = new TaskNotificationLedger(file);
    reg(ledger, 'n1');
    ledger.claim('n1');
    expect(ledger.markFailed('n1', 'ratelimited', { final: false })).toMatchObject({
      state: 'pending',
      error: 'ratelimited',
    });
    ledger.claim('n1');
    expect(ledger.markFailed('n1', 'channel_not_found', { final: true })).toMatchObject({
      state: 'failed',
      error: 'channel_not_found',
      attempts: 2,
    });
  });

  it('L2c — closing: pending, unknown or failed can be resolved or superseded', () => {
    const ledger = new TaskNotificationLedger(file);
    reg(ledger, 'a');
    reg(ledger, 'b');
    reg(ledger, 'c');
    ledger.claim('b');
    ledger.claim('c');
    ledger.markFailed('c', 'x', { final: true });
    expect(ledger.close('a', 'resolved').state).toBe('resolved');
    expect(ledger.close('b', 'superseded').state).toBe('superseded');
    expect(ledger.close('c', 'resolved').state).toBe('resolved');
  });

  it('L2d — anything else is refused, and changes nothing', () => {
    const ledger = new TaskNotificationLedger(file);
    reg(ledger, 'n1');
    expect(() => ledger.markPosted('n1', 'ts')).toThrow(LedgerTransitionError); // pending → posted skips the claim
    expect(() => ledger.markFailed('n1', 'x', { final: false })).toThrow(LedgerTransitionError);
    expect(() => ledger.claim('missing')).toThrow(LedgerTransitionError);
    ledger.claim('n1');
    ledger.markPosted('n1', 'ts');
    expect(() => ledger.close('n1', 'resolved')).toThrow(LedgerTransitionError);
    expect(ledger.get('n1')?.state).toBe('posted');
  });

  it('L3 — a posted key is never claimed again', () => {
    const ledger = new TaskNotificationLedger(file);
    reg(ledger, 'n1');
    ledger.claim('n1');
    ledger.markPosted('n1', 'ts1');
    expect(() => ledger.claim('n1')).toThrow(LedgerTransitionError);
    // A re-register after posting changes nothing.
    expect(reg(ledger, 'n1').state).toBe('posted');
  });

  it('L3b — an unknown entry (claimed, process died before the mark) can be claimed again: at least once', () => {
    const ledger = new TaskNotificationLedger(file);
    reg(ledger, 'n1');
    ledger.claim('n1');
    const after = new TaskNotificationLedger(file);
    after.load();
    expect(after.get('n1')?.state).toBe('unknown');
    expect(after.claim('n1')).toMatchObject({ state: 'unknown', attempts: 2 });
  });

  it('L4 — a failed write leaves memory and disk as they were, and throws', () => {
    const ledger = new TaskNotificationLedger(file);
    reg(ledger, 'n1');
    const before = fs.readFileSync(file, 'utf8');
    const restore = failNextWrite();
    try {
      expect(() => ledger.claim('n1')).toThrow(/disk full/);
      expect(() => reg(ledger, 'n2')).toThrow(/disk full/);
    } finally {
      restore();
    }
    expect(ledger.get('n1')?.state).toBe('pending');
    expect(ledger.get('n1')?.attempts).toBe(0);
    expect(ledger.get('n2')).toBeUndefined();
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('L5 — a restart reads it back; the scan returns what is still owed, a task’s link first', () => {
    const ledger = new TaskNotificationLedger(file);
    reg(ledger, 'a:res', 'result', 'task-a');
    reg(ledger, 'b:link', 'link', 'task-b');
    reg(ledger, 'a:link', 'link', 'task-a');
    reg(ledger, 'done', 'result', 'task-c');
    ledger.claim('done');
    ledger.markPosted('done', 'ts');
    reg(ledger, 'gone', 'question', 'task-c');
    ledger.close('gone', 'resolved');
    reg(ledger, 'bad', 'failure', 'task-c');
    ledger.claim('bad');
    ledger.markFailed('bad', 'x', { final: true });

    const after = new TaskNotificationLedger(file);
    after.load();
    expect(after.owed().map((e) => e.id)).toEqual(['a:link', 'a:res', 'b:link', 'bad']);
  });

  it('L6 — no file is an empty ledger; a corrupt live file falls back to its backup', () => {
    const fresh = new TaskNotificationLedger(file);
    fresh.load();
    expect(fresh.owed()).toEqual([]);

    const ledger = new TaskNotificationLedger(file);
    reg(ledger, 'n1');
    reg(ledger, 'n2'); // the second write promotes the first to the backup
    fs.writeFileSync(file, '{ not json');
    const after = new TaskNotificationLedger(file);
    after.load();
    expect(after.get('n1')?.state).toBe('pending');
  });

  it('L6b — a file with a malformed entry is refused, not half-loaded', () => {
    const good = {
      id: 'x',
      taskId: 't',
      kind: 'result',
      channel: 'C1',
      threadTs: '1.0',
      state: 'pending',
      attempts: 0,
      intent: {},
      createdAt: 1,
      updatedAt: 1,
    };
    for (const bad of [
      { ...good, state: 'bogus' },
      { ...good, kind: 'bogus' },
      { ...good, channel: 7 },
      { ...good, id: '' },
    ]) {
      fs.writeFileSync(file, JSON.stringify({ version: 1, entries: [good, { ...bad, id: bad.id === '' ? '' : 'y' }] }));
      const ledger = new TaskNotificationLedger(file);
      expect(() => ledger.load()).toThrow();
    }
    fs.writeFileSync(file, JSON.stringify({ version: 1, entries: [good] }));
    const ok = new TaskNotificationLedger(file);
    ok.load();
    expect(ok.get('x')?.state).toBe('pending');
  });
});
