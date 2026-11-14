/**
 * A cron fire that opens a new thread runs a whole model turn. The scheduler used to await that turn inside its
 * tick, so one long job (a daily run of several hours) held every other job: their minutes fell outside the
 * 60-minute catch-up window and were dropped without a trace beyond one warning. On a customer dev host a nightly
 * run of 6–8 hours dropped about ten other daily jobs every night.
 *
 * The tick now launches each due fire and moves on; it never waits for a turn to end. A job whose earlier fire is
 * still running is not fired again on top of itself.
 */

import * as os from 'os';
import * as path from 'path';
import { CronStorage } from 'somalib/cron/cron-storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CronScheduler, type CronSchedulerDeps, type SyntheticMessageEvent } from '../cron-scheduler';
import { SessionRegistry } from '../session-registry';

const at = (iso: string) => vi.setSystemTime(new Date(iso));

function setup(jobs: Array<{ name: string; expression: string }>) {
  const file = path.join(os.tmpdir(), `cron-long-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const storage = new CronStorage(file);
  for (const j of jobs) {
    storage.addJob({ ...j, prompt: `run ${j.name}`, owner: 'U1', channel: 'C1', threadTs: null });
  }
  const injected: SyntheticMessageEvent[] = [];
  const releases: Array<() => void> = [];
  const deps: CronSchedulerDeps = {
    storage,
    sessionRegistry: new SessionRegistry(),
    // Every turn of a job named "slow…" stays open until the test releases it.
    messageInjector: vi.fn(async (e: SyntheticMessageEvent) => {
      injected.push(e);
      if (/^\[cron:slow/.test(e.text)) await new Promise<void>((r) => releases.push(r));
    }),
    threadCreator: vi.fn(async () => `thread-${injected.length}`),
  };
  const fired = () => injected.map((e) => /^\[cron:([^\]]+)\]/.exec(e.text)?.[1]);
  const releaseAll = () => {
    for (const r of releases.splice(0)) r();
  };
  return { storage, deps, fired, releaseAll };
}

const TIMED_OUT = Symbol('timed out');
const within = <T>(p: Promise<T>, ms = 200) =>
  Promise.race([p, new Promise<typeof TIMED_OUT>((r) => setTimeout(() => r(TIMED_OUT), ms))]);

describe('CronScheduler — a long turn does not hold the other jobs', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-19T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('the tick returns once the fires are launched, not when their turns end', async () => {
    const { deps, fired, releaseAll } = setup([{ name: 'slow', expression: '0 12 * * *' }]);
    const scheduler = new CronScheduler(deps);

    at('2026-10-19T12:00:30Z');
    expect(await within(scheduler.tick())).not.toBe(TIMED_OUT);
    await vi.waitFor(() => expect(fired()).toEqual(['slow']));
    releaseAll();
  });

  it('a job due while another turn runs longer than the catch-up window still fires', async () => {
    const { deps, fired, releaseAll } = setup([
      { name: 'slow-nightly', expression: '0 20 * * *' },
      { name: 'scan', expression: '0 21 * * *' },
      { name: 'feed', expression: '40 23 * * *' },
    ]);
    const scheduler = new CronScheduler(deps);

    at('2026-10-19T20:00:20Z');
    void within(scheduler.tick());
    await vi.waitFor(() => expect(fired()).toEqual(['slow-nightly']));

    at('2026-10-19T21:00:20Z');
    await within(scheduler.tick());
    await vi.waitFor(() => expect(fired()).toEqual(['slow-nightly', 'scan']));

    at('2026-10-19T23:40:20Z');
    await within(scheduler.tick());
    await vi.waitFor(() => expect(fired()).toEqual(['slow-nightly', 'scan', 'feed']));
    releaseAll();
  });

  it('a job whose earlier fire is still running is not fired again on top of it', async () => {
    const { deps, fired, releaseAll } = setup([{ name: 'slow-hourly', expression: '0 * * * *' }]);
    const scheduler = new CronScheduler(deps);

    at('2026-10-19T12:00:30Z');
    await within(scheduler.tick());
    await vi.waitFor(() => expect(fired()).toEqual(['slow-hourly']));

    at('2026-10-19T13:00:30Z');
    await within(scheduler.tick());
    await new Promise((r) => setTimeout(r, 20));
    expect(fired()).toEqual(['slow-hourly']);

    // Once that turn ends, the next hour fires as usual.
    releaseAll();
    await new Promise((r) => setTimeout(r, 20));
    at('2026-10-19T14:00:30Z');
    await within(scheduler.tick());
    await vi.waitFor(() => expect(fired()).toEqual(['slow-hourly', 'slow-hourly']));
    releaseAll();
  });
});
