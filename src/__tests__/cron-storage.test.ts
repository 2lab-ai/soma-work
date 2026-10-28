/**
 * CronStorage — Contract tests
 * Trace: docs/archive/features/cron-scheduler/trace.md, Scenarios 2-3
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CronStorage } from 'somalib/cron/cron-storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('CronStorage', () => {
  let storage: CronStorage;
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `cron-test-${Date.now()}.json`);
    storage = new CronStorage(tmpFile);
  });

  afterEach(() => {
    try {
      fs.unlinkSync(tmpFile);
    } catch {}
    try {
      fs.unlinkSync(tmpFile + '.tmp');
    } catch {}
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

    expect(() =>
      storage.addJob({
        name: 'dup-test',
        expression: '0 10 * * *',
        prompt: 'second',
        owner: 'U123',
        channel: 'C789',
        threadTs: null,
      }),
    ).toThrow('DUPLICATE_NAME');
  });

  // Trace: S2, Section 5 — Different owners can have same name
  it('allows same name for different owners', () => {
    storage.addJob({
      name: 'report',
      expression: '0 9 * * *',
      prompt: 'a',
      owner: 'U1',
      channel: 'C1',
      threadTs: null,
    });
    const job2 = storage.addJob({
      name: 'report',
      expression: '0 9 * * *',
      prompt: 'b',
      owner: 'U2',
      channel: 'C1',
      threadTs: null,
    });
    expect(job2.owner).toBe('U2');
  });

  // Trace: S2, Section 4 — Side-Effect
  it('persists to JSON file', () => {
    storage.addJob({
      name: 'persist-test',
      expression: '* * * * *',
      prompt: 'test',
      owner: 'U1',
      channel: 'C1',
      threadTs: null,
    });

    const raw = JSON.parse(fs.readFileSync(tmpFile, 'utf-8'));
    expect(raw.jobs).toHaveLength(1);
    expect(raw.jobs[0].name).toBe('persist-test');
  });

  // Trace: S2, Section 3 — Contract: field mapping
  it('request.name → CronJob.name → jobs[].name transformation', () => {
    storage.addJob({
      name: 'my-cron',
      expression: '0 9 * * *',
      prompt: 'hello',
      owner: 'UABC',
      channel: 'CXYZ',
      threadTs: null,
    });

    const raw = JSON.parse(fs.readFileSync(tmpFile, 'utf-8'));
    expect(raw.jobs[0].name).toBe('my-cron');
    expect(raw.jobs[0].owner).toBe('UABC');
    expect(raw.jobs[0].channel).toBe('CXYZ');
  });

  // --- Scenario 3: cron_delete ---

  // Trace: S3, Section 3a — Happy Path
  it('removes existing job', () => {
    storage.addJob({
      name: 'to-delete',
      expression: '0 9 * * *',
      prompt: 'x',
      owner: 'U1',
      channel: 'C1',
      threadTs: null,
    });
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
    storage.addJob({
      name: 'protected',
      expression: '0 9 * * *',
      prompt: 'x',
      owner: 'U1',
      channel: 'C1',
      threadTs: null,
    });
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
    expect(u1Jobs.map((j) => j.name).sort()).toEqual(['a', 'c']);
  });

  // Trace: S3, Section 3b — Sad Path
  it('returns empty array for no jobs', () => {
    const jobs = storage.getJobsByOwner('NOBODY');
    expect(jobs).toEqual([]);
  });

  // --- updateLastRun ---

  it('updates lastRunAt and lastRunMinute', () => {
    const job = storage.addJob({
      name: 'run-test',
      expression: '* * * * *',
      prompt: 'x',
      owner: 'U1',
      channel: 'C1',
      threadTs: null,
    });
    const now = new Date('2026-03-28T09:00:00Z');
    storage.updateLastRun(job.id, now);

    const updated = storage.getAll()[0];
    expect(updated.lastRunAt).toBe('2026-03-28T09:00:00.000Z');
    expect(updated.lastRunMinute).toBe('2026-03-28T09:00');
  });
});

// matchesCronExpression / isValidCronExpression / isValidCronName are soma-lib's
// (re-exported by somalib/cron/cron-storage); soma-lib's cron-expression suite pins them.

// --- updateJob — cron manage UI (T2.1) ---
// Trace: cron/schedule 관리 UI — 모델·출력 대상 변경은 updateJob 경유
describe('CronStorage.updateJob', () => {
  let storage: CronStorage;
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `cron-update-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    storage = new CronStorage(tmpFile);
  });

  afterEach(() => {
    try {
      fs.unlinkSync(tmpFile);
    } catch {}
    try {
      fs.unlinkSync(tmpFile + '.tmp');
    } catch {}
  });

  function seed(over: Partial<Parameters<CronStorage['addJob']>[0]> = {}) {
    return storage.addJob({
      name: 'job-a',
      expression: '0 9 * * *',
      prompt: 'hello',
      owner: 'U_OWNER',
      channel: 'C111',
      threadTs: null,
      ...over,
    });
  }

  it('patches modelConfig and leaves other fields untouched', () => {
    const created = seed();
    const updated = storage.updateJob('U_OWNER', 'job-a', {
      modelConfig: { type: 'custom', model: 'gpt-5.5' },
    });
    expect(updated).not.toBeNull();
    expect(updated!.modelConfig).toEqual({ type: 'custom', model: 'gpt-5.5' });
    expect(updated!.expression).toBe('0 9 * * *');
    expect(updated!.prompt).toBe('hello');
    expect(updated!.id).toBe(created.id);
    expect(updated!.createdAt).toBe(created.createdAt);
    // persisted
    const reloaded = storage.getJobsByOwner('U_OWNER')[0];
    expect(reloaded.modelConfig).toEqual({ type: 'custom', model: 'gpt-5.5' });
  });

  it('stamps scheduleChangedAt only when the expression actually changes', () => {
    seed();
    expect(storage.updateJob('U_OWNER', 'job-a', { prompt: 'new' })!.scheduleChangedAt).toBeUndefined();
    expect(storage.updateJob('U_OWNER', 'job-a', { expression: '0 9 * * *' })!.scheduleChangedAt).toBeUndefined();
    const edited = storage.updateJob('U_OWNER', 'job-a', { expression: '30 9 * * *' })!;
    expect(edited.scheduleChangedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(storage.getJobsByOwner('U_OWNER')[0].scheduleChangedAt).toBe(edited.scheduleChangedAt);
  });

  it('clears modelConfig with null (default = creator current model)', () => {
    seed({ modelConfig: { type: 'fast' } });
    const updated = storage.updateJob('U_OWNER', 'job-a', { modelConfig: null });
    expect(updated!.modelConfig).toBeUndefined();
    const reloaded = storage.getJobsByOwner('U_OWNER')[0];
    expect('modelConfig' in reloaded).toBe(false);
  });

  it('patches target and clears with null', () => {
    seed({ target: 'dm' });
    const t = storage.updateJob('U_OWNER', 'job-a', { target: 'thread', threadTs: '1.2' });
    expect(t!.target).toBe('thread');
    expect(t!.threadTs).toBe('1.2');
    const cleared = storage.updateJob('U_OWNER', 'job-a', { target: null, threadTs: null });
    expect(cleared!.target).toBeUndefined();
    expect(cleared!.threadTs).toBeNull();
  });

  it('clears mode with null and sets fastlane', () => {
    seed({ mode: 'fastlane' });
    const cleared = storage.updateJob('U_OWNER', 'job-a', { mode: null });
    expect(cleared!.mode).toBeUndefined();
    const set = storage.updateJob('U_OWNER', 'job-a', { mode: 'fastlane' });
    expect(set!.mode).toBe('fastlane');
  });

  it('returns null for wrong owner or unknown name', () => {
    seed();
    expect(storage.updateJob('U_OTHER', 'job-a', { prompt: 'x' })).toBeNull();
    expect(storage.updateJob('U_OWNER', 'nope', { prompt: 'x' })).toBeNull();
  });

  it('renames a job and rejects duplicate names', () => {
    seed();
    const renamed = storage.updateJob('U_OWNER', 'job-a', { name: 'job-b' });
    expect(renamed!.name).toBe('job-b');
    expect(storage.getJobsByOwner('U_OWNER').map((j) => j.name)).toEqual(['job-b']);

    storage.addJob({
      name: 'job-c',
      expression: '0 9 * * *',
      prompt: 'x',
      owner: 'U_OWNER',
      channel: 'C1',
      threadTs: null,
    });
    expect(() => storage.updateJob('U_OWNER', 'job-b', { name: 'job-c' })).toThrow(/DUPLICATE_NAME/);
  });

  it('renames a job; duplicate rename throws DUPLICATE_NAME', () => {
    seed();
    const renamed = storage.updateJob('U_OWNER', 'job-a', { name: 'job-b' });
    expect(renamed!.name).toBe('job-b');
    expect(storage.getJobsByOwner('U_OWNER').map((j) => j.name)).toEqual(['job-b']);

    seed(); // job-a again
    expect(() => storage.updateJob('U_OWNER', 'job-a', { name: 'job-b' })).toThrow(/DUPLICATE_NAME/);
  });

  it('preserves lastRun bookkeeping fields across update', () => {
    const created = seed();
    storage.updateLastRun(created.id, new Date('2026-01-02T03:04:00Z'));
    const updated = storage.updateJob('U_OWNER', 'job-a', { expression: '*/5 * * * *' });
    expect(updated!.lastRunAt).toBe('2026-01-02T03:04:00.000Z');
    expect(updated!.lastRunMinute).toBe('2026-01-02T03:04');
    expect(updated!.expression).toBe('*/5 * * * *');
  });
});

// --- A job stored by an older build -------------------------------------------
// Older builds stored deploy triggers on a job (deploy-triggered fires, since
// removed); the fixture below keeps that key verbatim.
// Nothing reads the key any more; a file that still has it must load and edit
// like any other.
describe('CronStorage — a stored job with a key this build does not know', () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `cron-legacy-key-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    const legacyJob = {
      id: 'job-legacy',
      name: 'qa-lane',
      expression: '0 9 * * *',
      prompt: 'QA',
      owner: 'U_OWNER',
      channel: 'C1',
      threadTs: null,
      createdAt: '2026-10-21T00:00:00.000Z',
      lastRunAt: null,
      lastRunMinute: null,
      onDeploy: [{ repo: 'acme/app', target: 'deploy/dev2' }],
    };
    fs.writeFileSync(tmpFile, JSON.stringify({ jobs: [legacyJob] }, null, 2), 'utf-8');
  });

  afterEach(() => {
    for (const f of [tmpFile, `${tmpFile}.tmp`]) {
      try {
        fs.unlinkSync(f);
      } catch {}
    }
  });

  it('loads, lists and updates the job', () => {
    const storage = new CronStorage(tmpFile);

    expect(storage.getAll().map((j) => j.name)).toEqual(['qa-lane']);
    expect(storage.getJobsByOwner('U_OWNER')).toHaveLength(1);

    const updated = storage.updateJob('U_OWNER', 'qa-lane', { prompt: 'QA again' });
    expect(updated).toMatchObject({ id: 'job-legacy', name: 'qa-lane', prompt: 'QA again' });
    expect(new CronStorage(tmpFile).getJobsByOwner('U_OWNER')[0].prompt).toBe('QA again');
  });
});
