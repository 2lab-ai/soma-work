import { afterEach, describe, expect, it, vi } from 'vitest';
import { PollScheduler } from '../poll-scheduler';

describe('PollScheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('on start: resumes expired deliveries once, then ticks immediately and every interval', async () => {
    vi.useFakeTimers();
    const service = {
      closeDue: vi.fn(async () => ({ closed: 0, retried: 0, expired: 0 })),
      resumeExpiredDeliveries: vi.fn(() => 0),
    };
    const scheduler = new PollScheduler({ getService: () => service, intervalMs: 60_000 });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.resumeExpiredDeliveries).toHaveBeenCalledTimes(1);
    expect(service.closeDue).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(service.closeDue).toHaveBeenCalledTimes(2);
    expect(service.resumeExpiredDeliveries).toHaveBeenCalledTimes(1);
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(service.closeDue).toHaveBeenCalledTimes(2);
  });

  it('never overlaps ticks while a previous closeDue is still running', async () => {
    let release: () => void = () => {};
    const service = {
      closeDue: vi.fn(
        () =>
          new Promise<{ closed: number; retried: number; expired: number }>((r) => {
            release = () => r({ closed: 0, retried: 0, expired: 0 });
          }),
      ),
      resumeExpiredDeliveries: vi.fn(() => 0),
    };
    const scheduler = new PollScheduler({ getService: () => service, intervalMs: 60_000 });
    const first = scheduler.tick();
    await scheduler.tick();
    expect(service.closeDue).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it('waits for the service to exist and resumes on the first tick that has it', async () => {
    let service: any;
    const scheduler = new PollScheduler({ getService: () => service, intervalMs: 60_000 });
    await scheduler.tick();
    service = {
      closeDue: vi.fn(async () => ({ closed: 0, retried: 0, expired: 0 })),
      resumeExpiredDeliveries: vi.fn(() => 2),
    };
    await scheduler.tick();
    expect(service.resumeExpiredDeliveries).toHaveBeenCalledTimes(1);
    expect(service.closeDue).toHaveBeenCalledTimes(1);
  });

  it('a throwing closeDue is logged, not propagated', async () => {
    const service = {
      closeDue: vi.fn(async () => {
        throw new Error('boom');
      }),
      resumeExpiredDeliveries: vi.fn(() => 0),
    };
    const scheduler = new PollScheduler({ getService: () => service, intervalMs: 60_000 });
    await expect(scheduler.tick()).resolves.toBeUndefined();
  });
});
