/**
 * PollScheduler — closes due native polls and retries pending result delivery.
 *
 * Same lifecycle shape as CronScheduler: a 60s `setInterval` with an
 * `isRunning` guard so ticks never overlap, started and stopped from
 * `src/index.ts`. The poll service is read lazily on every tick (it is built by
 * the action-delegate composition), and the restart recovery
 * (`resumeExpiredDeliveries`) runs once, on the first tick that sees it.
 */

import type { PollService } from '@soma/slack/poll/poll-service';
import { Logger } from './logger';

const DEFAULT_INTERVAL_MS = 60_000;

export interface PollSchedulerDeps {
  getService: () => Pick<PollService, 'closeDue' | 'resumeExpiredDeliveries'> | undefined;
  intervalMs?: number;
}

export class PollScheduler {
  private logger = new Logger('PollScheduler');
  private timer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private resumed = false;

  constructor(private deps: PollSchedulerDeps) {}

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.deps.intervalMs ?? DEFAULT_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    if (this.isRunning) return;
    const service = this.deps.getService();
    if (!service) return;
    this.isRunning = true;
    try {
      if (!this.resumed) {
        this.resumed = true;
        const resumed = service.resumeExpiredDeliveries();
        if (resumed > 0) this.logger.info('Resumed expired poll deliveries after restart', { resumed });
      }
      const result = await service.closeDue();
      if (result.closed || result.retried || result.expired) {
        this.logger.info('Poll scheduler tick', result);
      }
    } catch (error) {
      this.logger.error('Poll scheduler tick failed', { error: (error as Error)?.message ?? String(error) });
    } finally {
      this.isRunning = false;
    }
  }
}
