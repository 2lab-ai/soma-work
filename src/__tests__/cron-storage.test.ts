/**
 * CronStorage — Contract tests
 * Trace: docs/archive/features/cron-scheduler/trace.md, Scenarios 2-3
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { type CronJob, CronStorage, jobMatchesDeploy } from 'somalib/cron/cron-storage';
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

// --- onDeploy — deploy-triggered lanes ---
// The owner's opt-in: "fire me when a deploy of `repo` into branch `target` completes".
describe('CronStorage onDeploy', () => {
  let storage: CronStorage;
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `cron-ondeploy-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    storage = new CronStorage(tmpFile);
  });

  afterEach(() => {
    for (const f of [tmpFile, tmpFile + '.tmp']) {
      try {
        fs.unlinkSync(f);
      } catch {}
    }
  });

  function seed(onDeploy?: Array<{ repo: string; target: string }>) {
    return storage.addJob({
      name: 'qa-lane',
      expression: '0 0 31 2 *',
      prompt: 'QA',
      owner: 'U_OWNER',
      channel: 'C1',
      threadTs: null,
      ...(onDeploy ? { onDeploy } : {}),
    });
  }

  it('round-trips onDeploy through the file, normalized (repo lower-cased, refs/heads/ stripped)', () => {
    seed([
      { repo: 'Acme/App', target: 'refs/heads/deploy/dev2' },
      { repo: 'acme/api', target: 'develop' },
    ]);
    const raw = JSON.parse(fs.readFileSync(tmpFile, 'utf-8'));
    expect(raw.jobs[0].onDeploy).toEqual([
      { repo: 'acme/app', target: 'deploy/dev2' },
      { repo: 'acme/api', target: 'develop' },
    ]);
    expect(new CronStorage(tmpFile).getAll()[0].onDeploy).toEqual(raw.jobs[0].onDeploy);
  });

  it('collapses duplicate entries after normalization', () => {
    const job = seed([
      { repo: 'acme/app', target: 'deploy/dev2' },
      { repo: 'ACME/APP', target: 'refs/heads/deploy/dev2' },
    ]);
    expect(job.onDeploy).toEqual([{ repo: 'acme/app', target: 'deploy/dev2' }]);
  });

  it('omits the field for a job without triggers (and for an empty list)', () => {
    seed();
    storage.addJob({
      name: 'b',
      expression: '0 9 * * *',
      prompt: 'x',
      owner: 'U_OWNER',
      channel: 'C1',
      threadTs: null,
      onDeploy: [],
    });
    for (const job of JSON.parse(fs.readFileSync(tmpFile, 'utf-8')).jobs) {
      expect('onDeploy' in job).toBe(false);
    }
  });

  it.each([
    ['repo without owner', { repo: 'app', target: 'deploy/dev2' }],
    ['repo with a space', { repo: 'acme/my app', target: 'deploy/dev2' }],
    ['repo with two slashes', { repo: 'acme/app/x', target: 'deploy/dev2' }],
    ['empty target', { repo: 'acme/app', target: '   ' }],
    ['bare refs/heads/ target', { repo: 'acme/app', target: 'refs/heads/' }],
    ['target with whitespace', { repo: 'acme/app', target: 'deploy dev2' }],
  ])('addJob rejects an invalid trigger (%s)', (_label, trigger) => {
    expect(() => seed([trigger])).toThrow(/INVALID_ON_DEPLOY/);
    expect(storage.getAll()).toHaveLength(0);
  });

  it('updateJob sets, replaces and (with null) clears onDeploy', () => {
    seed();
    const set = storage.updateJob('U_OWNER', 'qa-lane', { onDeploy: [{ repo: 'Acme/App', target: 'deploy/dev2' }] });
    expect(set!.onDeploy).toEqual([{ repo: 'acme/app', target: 'deploy/dev2' }]);

    const replaced = storage.updateJob('U_OWNER', 'qa-lane', { onDeploy: [{ repo: 'acme/api', target: 'develop' }] });
    expect(replaced!.onDeploy).toEqual([{ repo: 'acme/api', target: 'develop' }]);

    const cleared = storage.updateJob('U_OWNER', 'qa-lane', { onDeploy: null });
    expect(cleared!.onDeploy).toBeUndefined();
    expect('onDeploy' in storage.getJobsByOwner('U_OWNER')[0]).toBe(false);
  });

  it('updateJob rejects an invalid trigger and leaves the job unchanged', () => {
    seed([{ repo: 'acme/app', target: 'deploy/dev2' }]);
    expect(() => storage.updateJob('U_OWNER', 'qa-lane', { onDeploy: [{ repo: 'nope', target: 'x' }] })).toThrow(
      /INVALID_ON_DEPLOY/,
    );
    expect(storage.getJobsByOwner('U_OWNER')[0].onDeploy).toEqual([{ repo: 'acme/app', target: 'deploy/dev2' }]);
  });

  it('other patches keep onDeploy', () => {
    seed([{ repo: 'acme/app', target: 'deploy/dev2' }]);
    const updated = storage.updateJob('U_OWNER', 'qa-lane', { prompt: 'new' });
    expect(updated!.onDeploy).toEqual([{ repo: 'acme/app', target: 'deploy/dev2' }]);
  });
});

describe('jobMatchesDeploy', () => {
  const job = (onDeploy?: Array<{ repo: string; target: string }>) =>
    ({ id: 'j', name: 'n', owner: 'U', onDeploy }) as unknown as CronJob;

  it('matches repo case-insensitively and target exactly after stripping refs/heads/', () => {
    const lane = job([{ repo: 'acme/app', target: 'deploy/dev2' }]);
    expect(jobMatchesDeploy(lane, 'ACME/App', 'deploy/dev2')).toBe(true);
    expect(jobMatchesDeploy(lane, 'acme/app', 'refs/heads/deploy/dev2')).toBe(true);
    expect(jobMatchesDeploy(lane, 'acme/app', 'dev2')).toBe(false);
    expect(jobMatchesDeploy(lane, 'acme/app', 'Deploy/Dev2')).toBe(false);
    expect(jobMatchesDeploy(lane, 'acme/api', 'deploy/dev2')).toBe(false);
  });

  it('never matches a job without triggers or with a malformed stored list', () => {
    expect(jobMatchesDeploy(job(), 'acme/app', 'deploy/dev2')).toBe(false);
    expect(jobMatchesDeploy(job('garbage' as any), 'acme/app', 'deploy/dev2')).toBe(false);
    expect(jobMatchesDeploy(job([null as any, { repo: 'acme/app' } as any]), 'acme/app', 'deploy/dev2')).toBe(false);
  });
});

// getAllStrict — for callers that must tell "no jobs" from "could not read the jobs".
// getAll() swallows a parse error and returns [], which is right for the scheduler
// tick and wrong for a deploy lane that would then report "no lane registered".
describe('CronStorage.getAllStrict', () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `cron-strict-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  });

  afterEach(() => {
    try {
      fs.unlinkSync(tmpFile);
    } catch {}
  });

  it('returns [] when the file does not exist yet', () => {
    expect(new CronStorage(tmpFile).getAllStrict()).toEqual([]);
  });

  it('returns the jobs of a valid file', () => {
    const storage = new CronStorage(tmpFile);
    storage.addJob({ name: 'a', expression: '0 9 * * *', prompt: 'x', owner: 'U1', channel: 'C1', threadTs: null });
    expect(storage.getAllStrict().map((j) => j.name)).toEqual(['a']);
  });

  it('throws on an unparseable file instead of returning []', () => {
    fs.writeFileSync(tmpFile, '{ not json');
    const storage = new CronStorage(tmpFile);
    expect(storage.getAll()).toEqual([]);
    expect(() => storage.getAllStrict()).toThrow();
  });

  it('throws on a file without a jobs array', () => {
    fs.writeFileSync(tmpFile, JSON.stringify({ history: [] }));
    expect(() => new CronStorage(tmpFile).getAllStrict()).toThrow(/jobs array/);
  });

  // Only a missing file is "no jobs". existsSync() also says false when the
  // lookup itself fails (EACCES on a parent dir, ELOOP, ENOTDIR) — that file is
  // unreadable, not absent.
  it('throws when the path cannot be looked up (ENOTDIR) instead of returning []', () => {
    fs.writeFileSync(tmpFile, '');
    expect(() => new CronStorage(path.join(tmpFile, 'cron-jobs.json')).getAllStrict()).toThrow(
      expect.objectContaining({ code: 'ENOTDIR' }),
    );
  });

  it('returns [] when a parent directory does not exist yet (ENOENT)', () => {
    expect(new CronStorage(path.join(`${tmpFile}.dir`, 'cron-jobs.json')).getAllStrict()).toEqual([]);
  });
});
