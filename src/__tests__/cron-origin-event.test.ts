/**
 * T1/T5 (SSOT 2026-10-23) — every cron fire tells the pipeline which job it
 * is (so the new session can be named and grouped), and a fire that opens a
 * new thread records the session it opened (so the run history can link it).
 */
import * as os from 'os';
import * as path from 'path';
import { CronStorage } from 'somalib/cron/cron-storage';
import { describe, expect, it, vi } from 'vitest';
import { CronScheduler, type CronSchedulerDeps, type SyntheticMessageEvent } from '../cron-scheduler';
import { SessionRegistry } from '../session-registry';

function setup(storage: CronStorage) {
  const injected: SyntheticMessageEvent[] = [];
  const deps: CronSchedulerDeps = {
    storage,
    sessionRegistry: new SessionRegistry(),
    messageInjector: vi.fn(async (event: SyntheticMessageEvent) => {
      injected.push(event);
    }),
    threadCreator: vi.fn(async () => '1792728682.496489'),
  };
  return { deps, injected };
}

function tmpStorage(tag: string): CronStorage {
  return new CronStorage(path.join(os.tmpdir(), `cron-origin-${tag}-${Date.now()}-${Math.random()}`, 'cron-jobs.json'));
}

describe('cron fire → structured cron origin', () => {
  it('a new-thread fire carries {jobId, jobName} and records the opened session key', async () => {
    const storage = tmpStorage('new');
    const job = storage.addJob({
      name: 'nightly-qa',
      expression: '* * * * *',
      prompt: '$full-deploy',
      owner: 'U1',
      channel: 'C1',
      threadTs: null,
    });
    const { deps, injected } = setup(storage);

    await new CronScheduler(deps).tick();

    expect(injected).toHaveLength(1);
    expect(injected[0].cron).toEqual({ jobId: job.id, jobName: 'nightly-qa' });
    const [record] = storage.getExecutionHistory('nightly-qa');
    expect(record.executionPath).toBe('new_thread');
    // Same shape idle_inject records (`${channel}-${threadTs}`).
    expect(record.sessionKey).toBe('C1-1792728682.496489');
  });

  it('an idle-session injection carries the cron origin too', async () => {
    const storage = tmpStorage('idle');
    const job = storage.addJob({
      name: 'nightly',
      expression: '* * * * *',
      prompt: 'go',
      owner: 'U1',
      channel: 'C1',
      threadTs: null,
    });
    const { deps, injected } = setup(storage);
    deps.sessionRegistry.createSession('U1', 'Z', 'C1', 't-1');
    deps.sessionRegistry.transitionToMain('C1', 't-1', 'default');
    deps.sessionRegistry.setActivityState('C1', 't-1', 'idle');

    await new CronScheduler(deps).tick();

    expect(injected[0].cron).toEqual({ jobId: job.id, jobName: 'nightly' });
  });

  it('a new-thread fire that fails after opening its thread records the failure against that session', async () => {
    const storage = tmpStorage('fail');
    storage.addJob({
      name: 'nightly',
      expression: '* * * * *',
      prompt: 'go',
      owner: 'U1',
      channel: 'C1',
      threadTs: null,
    });
    const { deps } = setup(storage);
    deps.messageInjector = vi.fn(async () => {
      throw new Error('turn crashed');
    });

    await new CronScheduler(deps).tick();

    expect(storage.getExecutionHistory('nightly')[0]).toMatchObject({
      status: 'failed',
      executionPath: 'new_thread',
      sessionKey: 'C1-1792728682.496489',
      error: 'turn crashed',
    });
  });

  // trinity round 4 (fable P3): a deploy lane is not a cron job — its session
  // must not be named after a job or filed in the CRON lane, and it writes no
  // cron history.
  it('a deploy-lane fire carries no cron origin and records no cron history', async () => {
    const storage = tmpStorage('lane');
    const { deps, injected } = setup(storage);

    const result = await new CronScheduler(deps).fireDeployLane(
      { name: 'dev-qa', owner: 'U1', channel: 'C1', prompt: 'qa' },
      { rootText: 'deploy lane dev-qa' },
    );

    expect(result).toEqual({ ok: true, message: 'new_thread' });
    expect(injected).toHaveLength(1);
    expect(injected[0].cron).toBeUndefined();
    expect(storage.getExecutionHistory('dev-qa')).toEqual([]);
  });
});
