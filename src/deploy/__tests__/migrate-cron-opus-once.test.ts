/**
 * 2026-09-28 one-time cron model rewrite → `{ type: 'opus' }`.
 *
 * "Exactly once, ever": presence-only marker (corrupt still skips), and a job
 * switched back after the rewrite survives a second run.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CronStorage } from 'somalib/cron/cron-storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveModelOverride } from '../../cron-scheduler';
import { CRON_OPUS_ONCE_MARKER, migrateCronOpusOnce } from '../migrate-cron-opus-once';

function setup(): { dataDir: string; cronFile: string } {
  const dataDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cron-opus-once-')), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  return { dataDir, cronFile: path.join(dataDir, 'cron-jobs.json') };
}

/** The live shapes: absent, null, fast, custom (+ one already on opus). */
function seed(cronFile: string): void {
  const base = {
    expression: '0 9 * * *',
    prompt: 'p',
    channel: 'C1',
    threadTs: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastRunAt: '2026-09-27T09:00:00.000Z',
    lastRunMinute: '2026-09-27T09:00',
  };
  const jobs = [
    { ...base, id: '1', name: 'absent', owner: 'U1' },
    { ...base, id: '2', name: 'null', owner: 'U1', modelConfig: null },
    { ...base, id: '3', name: 'fast', owner: 'U2', modelConfig: { type: 'fast' } },
    { ...base, id: '4', name: 'custom', owner: 'U2', modelConfig: { type: 'custom', model: 'claude-fable-5' } },
    { ...base, id: '5', name: 'already', owner: 'U3', modelConfig: { type: 'opus' } },
  ];
  fs.writeFileSync(cronFile, JSON.stringify({ jobs }, null, 2), 'utf8');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('migrateCronOpusOnce', () => {
  it('rewrites every job to {type:"opus"} via CronStorage, preserving bookkeeping', () => {
    const { dataDir, cronFile } = setup();
    seed(cronFile);

    const result = migrateCronOpusOnce({ cronFile, dataDir });

    expect(result).toMatchObject({ status: 'applied', migrated: 4, total: 5 });
    const jobs = new CronStorage(cronFile).getAll();
    expect(jobs).toHaveLength(5);
    for (const job of jobs) {
      expect(job.modelConfig).toEqual({ type: 'opus' });
      expect(job.lastRunMinute).toBe('2026-09-27T09:00');
      expect(job.id).toBeDefined();
      // Fire-time resolution follows the latest opus.
      expect(resolveModelOverride(job.modelConfig)).toBe('claude-opus-5-5[1m]');
    }
  });

  it('records counts and each job’s previous modelConfig in the marker', () => {
    const { dataDir, cronFile } = setup();
    seed(cronFile);
    migrateCronOpusOnce({ cronFile, dataDir, now: () => new Date('2026-09-28T10:00:00.000Z') });
    const marker = JSON.parse(fs.readFileSync(path.join(dataDir, CRON_OPUS_ONCE_MARKER), 'utf8'));
    expect(marker.migratedAt).toBe('2026-09-28T10:00:00.000Z');
    expect(marker.migrated).toBe(4);
    expect(marker.total).toBe(5);
    expect(marker.previous).toEqual([
      { owner: 'U1', name: 'absent', modelConfig: null },
      { owner: 'U1', name: 'null', modelConfig: null },
      { owner: 'U2', name: 'fast', modelConfig: { type: 'fast' } },
      { owner: 'U2', name: 'custom', modelConfig: { type: 'custom', model: 'claude-fable-5' } },
    ]);
  });

  it('applies once: second run skips and leaves the file byte-identical', () => {
    const { dataDir, cronFile } = setup();
    seed(cronFile);
    migrateCronOpusOnce({ cronFile, dataDir });
    const afterFirst = fs.readFileSync(cronFile, 'utf8');

    expect(migrateCronOpusOnce({ cronFile, dataDir }).status).toBe('skipped');
    expect(fs.readFileSync(cronFile, 'utf8')).toBe(afterFirst);
  });

  it('a job switched back after the rewrite survives a second run', () => {
    const { dataDir, cronFile } = setup();
    seed(cronFile);
    migrateCronOpusOnce({ cronFile, dataDir });

    const storage = new CronStorage(cronFile);
    storage.updateJob('U2', 'fast', { modelConfig: { type: 'fast' } });
    expect(migrateCronOpusOnce({ cronFile, dataDir }).status).toBe('skipped');

    expect(new CronStorage(cronFile).getAll().find((j) => j.name === 'fast')?.modelConfig).toEqual({ type: 'fast' });
  });

  it('skips on an existing marker and on a CORRUPT marker (presence-only)', () => {
    for (const markerBody of ['{"migratedAt":"x"}', '{not json', '']) {
      const { dataDir, cronFile } = setup();
      seed(cronFile);
      fs.writeFileSync(path.join(dataDir, CRON_OPUS_ONCE_MARKER), markerBody, 'utf8');
      const before = fs.readFileSync(cronFile, 'utf8');

      expect(migrateCronOpusOnce({ cronFile, dataDir }).status).toBe('skipped');
      expect(fs.readFileSync(cronFile, 'utf8')).toBe(before);
    }
  });

  it('marks a host with no cron-jobs.json as done without creating the file', () => {
    const { dataDir, cronFile } = setup();
    const result = migrateCronOpusOnce({ cronFile, dataDir });
    expect(result).toMatchObject({ status: 'applied', migrated: 0, total: 0 });
    expect(fs.existsSync(cronFile)).toBe(false);
    expect(fs.existsSync(path.join(dataDir, CRON_OPUS_ONCE_MARKER))).toBe(true);
  });

  it('job write fails AFTER the marker: rethrows, next run skips, a later owner choice survives', () => {
    const { dataDir, cronFile } = setup();
    seed(cronFile);
    const before = fs.readFileSync(cronFile, 'utf8');

    const spy = vi.spyOn(CronStorage.prototype, 'updateJob').mockImplementation(() => {
      throw new Error('injected write failure');
    });
    expect(() => migrateCronOpusOnce({ cronFile, dataDir })).toThrow('injected write failure');
    spy.mockRestore();

    const marker = JSON.parse(fs.readFileSync(path.join(dataDir, CRON_OPUS_ONCE_MARKER), 'utf8'));
    expect(marker.previous).toHaveLength(4);
    expect(fs.readFileSync(cronFile, 'utf8')).toBe(before);

    new CronStorage(cronFile).updateJob('U2', 'custom', { modelConfig: { type: 'fable' } });
    expect(migrateCronOpusOnce({ cronFile, dataDir }).status).toBe('skipped');
    const jobs = new CronStorage(cronFile).getAll();
    expect(jobs.find((j) => j.name === 'custom')?.modelConfig).toEqual({ type: 'fable' });
    expect(jobs.find((j) => j.name === 'fast')?.modelConfig).toEqual({ type: 'fast' });
  });

  it.each([
    ['non-array jobs', '{"jobs": {"a": 1}}'],
    ['missing jobs', '{}'],
    ['a primitive job', '{"jobs": ["x"]}'],
    ['an array job', '{"jobs": [[1]]}'],
    ['an array root', '[]'],
  ])('throws on %s with no marker and no write', (_label, body) => {
    const { dataDir, cronFile } = setup();
    fs.writeFileSync(cronFile, body, 'utf8');
    expect(() => migrateCronOpusOnce({ cronFile, dataDir })).toThrow();
    expect(fs.existsSync(path.join(dataDir, CRON_OPUS_ONCE_MARKER))).toBe(false);
    expect(fs.readFileSync(cronFile, 'utf8')).toBe(body);
  });

  it('a corrupt cron-jobs.json throws BEFORE the marker is written (not burned)', () => {
    const { dataDir, cronFile } = setup();
    fs.writeFileSync(cronFile, '{broken', 'utf8');
    expect(() => migrateCronOpusOnce({ cronFile, dataDir })).toThrow();
    expect(fs.existsSync(path.join(dataDir, CRON_OPUS_ONCE_MARKER))).toBe(false);
    expect(fs.readFileSync(cronFile, 'utf8')).toBe('{broken');
  });

  it('CronStorage keeps opus/fable-typed jobs through a load/save round-trip', () => {
    const { cronFile } = setup();
    const storage = new CronStorage(cronFile);
    storage.addJob({
      name: 'a',
      expression: '* * * * *',
      prompt: 'p',
      owner: 'U1',
      channel: 'C1',
      threadTs: null,
      modelConfig: { type: 'fable' },
    });
    storage.addJob({
      name: 'b',
      expression: '* * * * *',
      prompt: 'p',
      owner: 'U1',
      channel: 'C1',
      threadTs: null,
      modelConfig: { type: 'opus' },
    });
    const reloaded = new CronStorage(cronFile).getAll();
    expect(reloaded.map((j) => j.modelConfig)).toEqual([{ type: 'fable' }, { type: 'opus' }]);
  });
});
