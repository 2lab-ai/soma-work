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
 *   L0 nothing is written before the file is read (a write would replace it with less).
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

/** A ledger read from its file, as the host opens it. */
function open(): TaskNotificationLedger {
  const ledger = new TaskNotificationLedger(file);
  ledger.load();
  return ledger;
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

  it('L0 — a ledger not yet read refuses to write, and the live file keeps what it owed; it is read once', () => {
    const first = open();
    reg(first, 'a');
    reg(first, 'b');
    const before = fs.readFileSync(file, 'utf8');
    const unread = new TaskNotificationLedger(file);
    expect(() => reg(unread, 'c')).toThrow(/before it was loaded/);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    const read = open();
    expect(read.owed().map((e) => e.id)).toEqual(['a', 'b']);
    expect(() => read.load()).toThrow(/already loaded/);
  });

  it('L1 — register is idempotent by id and saves before it returns', () => {
    const ledger = open();
    const a = reg(ledger, 'task-a:c1:result');
    expect(a).toMatchObject({ id: 'task-a:c1:result', state: 'pending', attempts: 0, ...TARGET });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).entries).toHaveLength(1);
    const mtime = fs.statSync(file).mtimeMs;
    const again = reg(ledger, 'task-a:c1:result');
    expect(again).toBe(ledger.get('task-a:c1:result'));
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
  });

  it('L2 — the state machine: claim before the post, then posted with its ts', () => {
    const ledger = open();
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
    const ledger = open();
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
    const ledger = open();
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
    const ledger = open();
    reg(ledger, 'n1');
    expect(() => ledger.markPosted('n1', 'ts')).toThrow(LedgerTransitionError); // pending → posted skips the claim
    expect(() => ledger.markFailed('n1', 'x', { final: false })).toThrow(LedgerTransitionError);
    expect(() => ledger.claim('missing')).toThrow(LedgerTransitionError);
    ledger.claim('n1');
    ledger.markPosted('n1', 'ts');
    expect(() => ledger.close('n1', 'resolved')).toThrow(LedgerTransitionError);
    expect(ledger.get('n1')?.state).toBe('posted');
  });

  it('L2e — a failed entry is still owed: it can be claimed again (the restart re-send, D13), one more attempt', () => {
    const ledger = open();
    reg(ledger, 'n1');
    ledger.claim('n1');
    ledger.markFailed('n1', 'channel_not_found', { final: true });
    expect(ledger.claim('n1')).toMatchObject({ state: 'unknown', attempts: 2 });
    expect(ledger.markPosted('n1', 'ts').error).toBeUndefined();
  });

  it('L2f — a post that succeeds after a retry clears the earlier error', () => {
    const ledger = open();
    reg(ledger, 'n1');
    ledger.claim('n1');
    ledger.markFailed('n1', 'ratelimited', { final: false });
    expect(ledger.get('n1')?.error).toBe('ratelimited');
    ledger.claim('n1');
    expect(ledger.markPosted('n1', 'ts')).toMatchObject({ state: 'posted', messageTs: 'ts', error: undefined });
  });

  it('L3 — a posted key is never claimed again', () => {
    const ledger = open();
    reg(ledger, 'n1');
    ledger.claim('n1');
    ledger.markPosted('n1', 'ts1');
    expect(() => ledger.claim('n1')).toThrow(LedgerTransitionError);
    // A re-register after posting changes nothing.
    expect(reg(ledger, 'n1').state).toBe('posted');
  });

  it('L3b — an unknown entry (claimed, process died before the mark) can be claimed again: at least once', () => {
    const ledger = open();
    reg(ledger, 'n1');
    ledger.claim('n1');
    const after = new TaskNotificationLedger(file);
    after.load();
    expect(after.get('n1')?.state).toBe('unknown');
    expect(after.claim('n1')).toMatchObject({ state: 'unknown', attempts: 2 });
  });

  it('L4 — a failed write leaves memory and disk as they were, and throws', () => {
    const ledger = open();
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
    const ledger = open();
    reg(ledger, 'a:res', 'result', 'task-a');
    reg(ledger, 'b:link', 'link', 'task-b');
    reg(ledger, 'a:link', 'link', 'task-a');
    reg(ledger, 'a:fail', 'failure', 'task-a');
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
    // A task's link first, then its notices by creation; tasks by their first owed entry.
    expect(after.owed().map((e) => e.id)).toEqual(['a:link', 'a:res', 'a:fail', 'b:link', 'bad']);
    // What rendering needs once the task is gone comes back as it was handed over.
    expect(after.get('a:res')).toMatchObject({
      taskId: 'task-a',
      kind: 'result',
      ...TARGET,
      intent: { outcome: 'completed', reason: 'done' },
    });
    expect(after.claim('bad')).toMatchObject({ state: 'unknown', attempts: 2 });
  });

  it('L6 — no file is an empty ledger; a corrupt live file falls back to its backup', () => {
    const fresh = new TaskNotificationLedger(file);
    fresh.load();
    expect(fresh.owed()).toEqual([]);

    const ledger = open();
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
      { ...good, attempts: 'x' },
      { ...good, createdAt: null },
      { ...good, intent: 'str' },
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
