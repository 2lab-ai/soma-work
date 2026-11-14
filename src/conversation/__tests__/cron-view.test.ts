/**
 * cron-view — the CRON lane's runs. A run fired by hand keeps that fact (manual), so the drawer never labels
 * somebody's press 예약 실행 (scheduled); a scheduled run carries no mark.
 */
import type { CronExecutionRecord, CronJob } from 'somalib/cron/cron-storage';
import { describe, expect, it } from 'vitest';
import { buildCronJobsView } from '../cron-view';

const JOB: CronJob = {
  id: 'job-1',
  name: 'nightly',
  expression: '0 9 * * *',
  prompt: 'p',
  owner: 'U1',
  channel: 'C1',
  threadTs: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  lastRunAt: null,
  lastRunMinute: null,
};
const record = (at: string, over: Partial<CronExecutionRecord> = {}): CronExecutionRecord => ({
  jobId: 'job-1',
  jobName: 'nightly',
  executedAt: at,
  status: 'success',
  executionPath: 'dm',
  ...over,
});

describe('buildCronJobsView — manual runs', () => {
  it('a run fired by hand is marked manual (with or without who pressed it); a scheduled run is not', () => {
    const [view] = buildCronJobsView({
      jobs: [JOB],
      history: [
        record('2026-11-13T09:00:00.000Z'),
        record('2026-11-13T10:00:00.000Z', { manual: true }),
        record('2026-11-13T11:00:00.000Z', { manual: true, triggeredBy: 'U_ADMIN' }),
      ],
      nowMs: Date.parse('2026-11-14T00:00:00.000Z'),
      findSession: () => undefined,
    });
    const [byAdmin, byOwner, scheduled] = view.runs;
    expect(byAdmin).toMatchObject({ manual: true, triggeredBy: 'U_ADMIN' });
    expect(byOwner).toMatchObject({ manual: true });
    expect(byOwner.triggeredBy).toBeUndefined();
    expect(scheduled.manual).toBeUndefined();
  });
});
