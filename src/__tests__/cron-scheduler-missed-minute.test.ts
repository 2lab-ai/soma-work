/**
 * CronScheduler must not lose a scheduled minute.
 *
 * The scheduler polls once a minute and drops a tick while the previous tick is
 * still awaiting a job (an idle-session inject awaits the whole model turn). It
 * also evaluated only the minute the tick happened to land in. Either way a job
 * whose minute fell between two evaluated ticks never fired.
 */

import * as os from 'os';
import * as path from 'path';
import { CronStorage } from 'somalib/cron/cron-storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CronScheduler, type CronSchedulerDeps, type SyntheticMessageEvent } from '../cron-scheduler';
import { SessionRegistry } from '../session-registry';

const at = (iso: string) => vi.setSystemTime(new Date(iso));

function setup(jobs: Array<{ name: string; expression: string }>) {
  const file = path.join(os.tmpdir(), `cron-missed-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const storage = new CronStorage(file);
  for (const j of jobs) {
    storage.addJob({ ...j, prompt: `run ${j.name}`, owner: 'U1', channel: 'C1', threadTs: null });
  }
  const injected: SyntheticMessageEvent[] = [];
  const deps: CronSchedulerDeps = {
    storage,
    sessionRegistry: new SessionRegistry(),
    messageInjector: vi.fn(async (e: SyntheticMessageEvent) => {
      injected.push(e);
    }),
    threadCreator: vi.fn(async () => 'thread-ts'),
  };
  const fired = () => injected.map((e) => /^\[cron:([^\]]+)\]/.exec(e.text)?.[1]);
  return { storage, deps, fired, injected };
}

describe('CronScheduler — no lost minutes', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // Jobs are created by setup() at this instant, before every scenario minute.
    vi.setSystemTime(new Date('2026-10-19T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires a job whose minute passed while the previous tick was still running', async () => {
    const { deps, fired, injected } = setup([
      { name: 'slow', expression: '0 12 * * *' },
      { name: 'next-minute', expression: '1 12 * * *' },
    ]);
    let release!: () => void;
    deps.messageInjector = vi.fn(async (e: SyntheticMessageEvent) => {
      injected.push(e);
      if (e.text.startsWith('[cron:slow]')) await new Promise<void>((r) => (release = r));
    });
    const scheduler = new CronScheduler(deps);

    at('2026-10-19T12:00:30Z');
    const first = scheduler.tick(); // blocks on the slow job's turn
    await vi.waitFor(() => expect(fired()).toEqual(['slow']));

    at('2026-10-19T12:01:30Z');
    await scheduler.tick(); // dropped: previous tick still running

    release();
    await first;

    at('2026-10-19T12:02:30Z');
    await scheduler.tick();

    expect(fired()).toEqual(['slow', 'next-minute']);
  });

  it('does not lose the minute when a late timer jumps over it', async () => {
    const { deps, fired } = setup([{ name: 'job', expression: '1 12 * * *' }]);
    const scheduler = new CronScheduler(deps);

    at('2026-10-19T12:00:59.900Z');
    await scheduler.tick();
    at('2026-10-19T12:02:00.100Z');
    await scheduler.tick();

    expect(fired()).toEqual(['job']);
  });

  it('fires a caught-up job once, not again on later ticks', async () => {
    const { deps, fired } = setup([{ name: 'job', expression: '1 12 * * *' }]);
    const scheduler = new CronScheduler(deps);

    at('2026-10-19T12:00:59.900Z');
    await scheduler.tick();
    at('2026-10-19T12:02:00.100Z');
    await scheduler.tick();
    at('2026-10-19T12:03:00.100Z');
    await scheduler.tick();

    expect(fired()).toEqual(['job']);
  });

  it('coalesces several missed minutes of one job into a single fire', async () => {
    const { deps, fired } = setup([{ name: 'every-minute', expression: '* * * * *' }]);
    const scheduler = new CronScheduler(deps);

    at('2026-10-19T12:00:10Z');
    await scheduler.tick();
    at('2026-10-19T12:04:10Z');
    await scheduler.tick();

    expect(fired()).toEqual(['every-minute', 'every-minute']);
  });

  // Guard for the catch-up design (not a RED case): a failed fire must not be
  // retried by every later tick inside the catch-up window.
  it('does not retry a failed fire on every later tick', async () => {
    const { deps } = setup([{ name: 'job', expression: '1 12 * * *' }]);
    deps.threadCreator = vi.fn(async () => undefined); // Slack returned no ts
    const scheduler = new CronScheduler(deps);

    at('2026-10-19T12:00:30Z');
    await scheduler.tick();
    at('2026-10-19T12:01:30Z');
    await scheduler.tick(); // due → fails
    at('2026-10-19T12:02:30Z');
    await scheduler.tick();
    at('2026-10-19T12:03:30Z');
    await scheduler.tick();

    expect(deps.threadCreator).toHaveBeenCalledTimes(1);
  });

  it('does not replay minutes from before the scheduler started', async () => {
    const { deps, fired } = setup([{ name: 'job', expression: '1 12 * * *' }]);
    const scheduler = new CronScheduler(deps);

    at('2026-10-19T12:05:10Z'); // first tick ever
    await scheduler.tick();

    expect(fired()).toEqual([]);
  });

  it('caps catch-up at 60 minutes so a long host sleep does not replay the whole gap', async () => {
    const { deps, fired } = setup([
      { name: 'too-old', expression: '30 10 * * *' },
      { name: 'recent', expression: '30 11 * * *' },
    ]);
    const scheduler = new CronScheduler(deps);

    at('2026-10-19T10:00:10Z');
    await scheduler.tick();
    at('2026-10-19T12:05:10Z'); // host was asleep for two hours
    await scheduler.tick();

    expect(fired()).toEqual(['recent']);
  });

  it('does not catch up an occurrence from before the job existed', async () => {
    const { storage, deps, fired } = setup([]);
    const scheduler = new CronScheduler(deps);

    at('2026-10-19T12:00:10Z');
    await scheduler.tick();
    at('2026-10-19T12:09:00Z');
    storage.addJob({ name: 'new', expression: '5 12 * * *', prompt: 'p', owner: 'U1', channel: 'C1', threadTs: null });
    at('2026-10-19T12:10:10Z'); // window 12:01–12:10 includes 12:05, before creation
    await scheduler.tick();

    expect(fired()).toEqual([]);
  });

  it('does not re-fire a job that a run-now covered while an earlier job of the tick awaited', async () => {
    const { deps, fired, injected } = setup([
      { name: 'slow', expression: '0 12 * * *' },
      { name: 'other', expression: '0 12 * * *' },
    ]);
    let release!: () => void;
    deps.messageInjector = vi.fn(async (e: SyntheticMessageEvent) => {
      injected.push(e);
      if (e.text.startsWith('[cron:slow]')) await new Promise<void>((r) => (release = r));
    });
    const scheduler = new CronScheduler(deps);

    at('2026-10-19T12:00:30Z');
    const ticking = scheduler.tick(); // snapshot [slow, other]; blocks on slow
    await vi.waitFor(() => expect(fired()).toEqual(['slow']));
    await scheduler.runJobNow('U1', 'other'); // manual fire, same minute
    release();
    await ticking;

    expect(fired()).toEqual(['slow', 'other']);
  });

  it('skips a minute already covered by a manual run-now', async () => {
    const { deps, fired } = setup([{ name: 'job', expression: '0 12 * * *' }]);
    const scheduler = new CronScheduler(deps);

    at('2026-10-19T11:59:30Z');
    await scheduler.tick();
    at('2026-10-19T12:00:05Z');
    await scheduler.runJobNow('U1', 'job');
    at('2026-10-19T12:00:40Z');
    await scheduler.tick();

    expect(fired()).toEqual(['job']);
  });
});
