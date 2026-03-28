/**
 * CronStorage — Contract tests
 * Trace: docs/cron-scheduler/trace.md, Scenarios 2-3
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CronStorage, matchesCronExpression, isValidCronExpression, isValidCronName } from './cron-storage';

describe('CronStorage', () => {
  let storage: CronStorage;
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `cron-test-${Date.now()}.json`);
    storage = new CronStorage(tmpFile);
  });

  afterEach(() => {
    try { fs.unlinkSync(tmpFile); } catch {}
    try { fs.unlinkSync(tmpFile + '.tmp'); } catch {}
  });

  // --- Scenario 2: cron_create ---

  // Trace: S2, Section 3 — Happy Path
  it('stores job with correct fields', () => {
    const job = storage.addJob({
      name: 'daily-standup',
      expression: '0 9 * * 1-5',
      prompt: 'Run standup',
      owner: 'U123',
      channel: 'C456',
      threadTs: null,
    });

    expect(job.id).toBeDefined();
    expect(job.name).toBe('daily-standup');
    expect(job.expression).toBe('0 9 * * 1-5');
    expect(job.prompt).toBe('Run standup');
    expect(job.owner).toBe('U123');
    expect(job.channel).toBe('C456');
    expect(job.threadTs).toBeNull();
    expect(job.createdAt).toBeDefined();
    expect(job.lastRunAt).toBeNull();
    expect(job.lastRunMinute).toBeNull();
  });

  // Trace: S2, Section 5 — Sad Path (duplicate)
  it('rejects duplicate name for same owner', () => {
    storage.addJob({
      name: 'dup-test',
      expression: '0 9 * * *',
      prompt: 'first',
      owner: 'U123',
      channel: 'C456',
      threadTs: null,
    });

    expect(() => storage.addJob({
      name: 'dup-test',
      expression: '0 10 * * *',
      prompt: 'second',
      owner: 'U123',
      channel: 'C789',
      threadTs: null,
    })).toThrow('DUPLICATE_NAME');
  });

  // Trace: S2, Section 5 — Different owners can have same name
  it('allows same name for different owners', () => {
    storage.addJob({ name: 'report', expression: '0 9 * * *', prompt: 'a', owner: 'U1', channel: 'C1', threadTs: null });
    const job2 = storage.addJob({ name: 'report', expression: '0 9 * * *', prompt: 'b', owner: 'U2', channel: 'C1', threadTs: null });
    expect(job2.owner).toBe('U2');
  });

  // Trace: S2, Section 4 — Side-Effect
  it('persists to JSON file', () => {
    storage.addJob({ name: 'persist-test', expression: '* * * * *', prompt: 'test', owner: 'U1', channel: 'C1', threadTs: null });

    const raw = JSON.parse(fs.readFileSync(tmpFile, 'utf-8'));
    expect(raw.jobs).toHaveLength(1);
    expect(raw.jobs[0].name).toBe('persist-test');
  });

  // Trace: S2, Section 3 — Contract: field mapping
  it('request.name → CronJob.name → jobs[].name transformation', () => {
    storage.addJob({ name: 'my-cron', expression: '0 9 * * *', prompt: 'hello', owner: 'UABC', channel: 'CXYZ', threadTs: null });

    const raw = JSON.parse(fs.readFileSync(tmpFile, 'utf-8'));
    expect(raw.jobs[0].name).toBe('my-cron');
    expect(raw.jobs[0].owner).toBe('UABC');
    expect(raw.jobs[0].channel).toBe('CXYZ');
  });

  // --- Scenario 3: cron_delete ---

  // Trace: S3, Section 3a — Happy Path
  it('removes existing job', () => {
    storage.addJob({ name: 'to-delete', expression: '0 9 * * *', prompt: 'x', owner: 'U1', channel: 'C1', threadTs: null });
    const removed = storage.removeJob('U1', 'to-delete');
    expect(removed).toBe(true);
    expect(storage.getAll()).toHaveLength(0);
  });

  // Trace: S3, Section 5 — Sad Path
  it('returns false for non-existent job', () => {
    const removed = storage.removeJob('U1', 'nonexistent');
    expect(removed).toBe(false);
  });

  // Trace: S3, Section 3a — Contract (owner isolation)
  it('cannot delete other user cron', () => {
    storage.addJob({ name: 'protected', expression: '0 9 * * *', prompt: 'x', owner: 'U1', channel: 'C1', threadTs: null });
    const removed = storage.removeJob('U_OTHER', 'protected');
    expect(removed).toBe(false);
    expect(storage.getAll()).toHaveLength(1);
  });

  // --- Scenario 3: cron_list ---

  // Trace: S3, Section 3b — Happy Path
  it('returns only owner jobs', () => {
    storage.addJob({ name: 'a', expression: '0 9 * * *', prompt: 'x', owner: 'U1', channel: 'C1', threadTs: null });
    storage.addJob({ name: 'b', expression: '0 9 * * *', prompt: 'y', owner: 'U2', channel: 'C1', threadTs: null });
    storage.addJob({ name: 'c', expression: '0 9 * * *', prompt: 'z', owner: 'U1', channel: 'C2', threadTs: null });

    const u1Jobs = storage.getJobsByOwner('U1');
    expect(u1Jobs).toHaveLength(2);
    expect(u1Jobs.map(j => j.name).sort()).toEqual(['a', 'c']);
  });

  // Trace: S3, Section 3b — Sad Path
  it('returns empty array for no jobs', () => {
    const jobs = storage.getJobsByOwner('NOBODY');
    expect(jobs).toEqual([]);
  });

  // --- updateLastRun ---

  it('updates lastRunAt and lastRunMinute', () => {
    const job = storage.addJob({ name: 'run-test', expression: '* * * * *', prompt: 'x', owner: 'U1', channel: 'C1', threadTs: null });
    const now = new Date('2026-03-28T09:00:00Z');
    storage.updateLastRun(job.id, now);

    const updated = storage.getAll()[0];
    expect(updated.lastRunAt).toBe('2026-03-28T09:00:00.000Z');
    expect(updated.lastRunMinute).toBe('2026-03-28T09:00');
  });
});

// --- Cron expression matching ---

describe('matchesCronExpression', () => {
  it('matches exact minute and hour', () => {
    const date = new Date('2026-03-28T09:30:00');
    expect(matchesCronExpression('30 9 * * *', date)).toBe(true);
    expect(matchesCronExpression('31 9 * * *', date)).toBe(false);
  });

  it('matches day-of-week range', () => {
    // 2026-03-28 is Saturday (dow=6)
    const sat = new Date('2026-03-28T09:00:00');
    expect(matchesCronExpression('0 9 * * 1-5', sat)).toBe(false); // Mon-Fri
    expect(matchesCronExpression('0 9 * * 6', sat)).toBe(true);
  });

  it('matches wildcard', () => {
    const date = new Date('2026-03-28T09:30:00');
    expect(matchesCronExpression('* * * * *', date)).toBe(true);
  });

  it('matches step values', () => {
    const date = new Date('2026-03-28T09:30:00');
    expect(matchesCronExpression('*/15 * * * *', date)).toBe(true); // 30 % 15 === 0
    expect(matchesCronExpression('*/7 * * * *', date)).toBe(false); // 30 % 7 !== 0 (0,7,14,21,28)
  });

  it('rejects invalid expression', () => {
    const date = new Date();
    expect(matchesCronExpression('invalid', date)).toBe(false);
    expect(matchesCronExpression('', date)).toBe(false);
  });
});

describe('isValidCronExpression', () => {
  it('validates 5-field expressions', () => {
    expect(isValidCronExpression('0 9 * * 1-5')).toBe(true);
    expect(isValidCronExpression('*/15 * * * *')).toBe(true);
    expect(isValidCronExpression('0 9 * * *')).toBe(true);
    expect(isValidCronExpression('bad')).toBe(false);
    expect(isValidCronExpression('0 9 * *')).toBe(false); // only 4 fields
  });

  it('rejects out-of-range values', () => {
    expect(isValidCronExpression('61 * * * *')).toBe(false);   // minute > 59
    expect(isValidCronExpression('* 25 * * *')).toBe(false);   // hour > 23
    expect(isValidCronExpression('* * 32 * *')).toBe(false);   // dom > 31
    expect(isValidCronExpression('* * * 13 *')).toBe(false);   // month > 12
    expect(isValidCronExpression('* * * * 8')).toBe(false);    // dow > 7
    expect(isValidCronExpression('99 99 * * *')).toBe(false);  // both out of range
  });

  it('rejects zero step and reversed ranges', () => {
    expect(isValidCronExpression('*/0 * * * *')).toBe(false);  // step 0
    expect(isValidCronExpression('5-1 * * * *')).toBe(false);  // reversed range
    expect(isValidCronExpression('* 10-1/2 * * *')).toBe(false); // reversed range with step
  });
});

describe('isValidCronName', () => {
  it('validates cron names', () => {
    expect(isValidCronName('daily-standup')).toBe(true);
    expect(isValidCronName('my_cron_123')).toBe(true);
    expect(isValidCronName('')).toBe(false);
    expect(isValidCronName('has spaces')).toBe(false);
    expect(isValidCronName('a'.repeat(65))).toBe(false);
  });
});
