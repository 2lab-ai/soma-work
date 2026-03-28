/**
 * CronScheduler — Polls every 60s, matches cron expressions, injects synthetic messages.
 * Trace: docs/cron-scheduler/trace.md, Scenarios 4-6
 *
 * Pattern: src/metrics/report-scheduler.ts (setInterval polling)
 * Pattern: src/slack-handler.ts:745-762 (autoResumeSession synthetic message)
 */

import { Logger } from './logger';
import { CronStorage, CronJob, matchesCronExpression } from './cron-storage';
import { SessionRegistry } from './session-registry';
import { ConversationSession } from './types';

const logger = new Logger('CronScheduler');
const POLL_INTERVAL_MS = 60_000; // 1 minute

/** Synthetic message event matching slack-handler's MessageEvent shape */
export interface SyntheticMessageEvent {
  user: string;
  channel: string;
  thread_ts?: string;
  ts: string;
  text: string;
}

/** Callback type for injecting messages into the handleMessage pipeline */
export type MessageInjector = (event: SyntheticMessageEvent) => Promise<void>;

/** Callback type for creating a new bot-initiated thread */
export type ThreadCreator = (channel: string, text: string) => Promise<string | undefined>;

export interface CronSchedulerDeps {
  storage: CronStorage;
  sessionRegistry: SessionRegistry;
  messageInjector: MessageInjector;
  threadCreator: ThreadCreator;
}

// Get current minute string in YYYY-MM-DDTHH:mm format for dedup.
// Prevents re-fire within the same calendar minute while allowing
// multi-fire-per-day crons (e.g. every 15 min).
function currentMinuteStr(): string {
  return new Date().toISOString().slice(0, 16);
}

export class CronScheduler {
  private deps: CronSchedulerDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pendingCronQueue: Map<string, CronJob[]> = new Map();
  private isRunning = false;

  constructor(deps: CronSchedulerDeps) {
    this.deps = deps;
  }

  /**
   * Start the scheduler. Polls every 60 seconds.
   * Pattern: src/metrics/report-scheduler.ts:95-105
   */
  start(): void {
    if (this.timer) return;
    logger.info('CronScheduler started');
    // Fire immediately on start, then every 60s
    this.tick().catch(err => logger.error('Initial tick failed', { error: err?.message }));
    this.timer = setInterval(() => this.tick(), POLL_INTERVAL_MS);
  }

  /**
   * Stop the scheduler.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('CronScheduler stopped');
    }
  }

  /**
   * Main tick: evaluate all cron jobs against current time.
   * Trace: docs/cron-scheduler/trace.md, Scenario 4, Section 3a
   */
  async tick(): Promise<void> {
    // Guard against overlapping ticks (setInterval can fire while previous tick is still running)
    if (this.isRunning) {
      logger.debug('Tick skipped — previous tick still running');
      return;
    }
    this.isRunning = true;

    const now = new Date();
    const currentMinute = currentMinuteStr();

    try {
      let jobs: CronJob[];
      try {
        jobs = this.deps.storage.getAll();
      } catch (error: any) {
        logger.error('Failed to load cron jobs', { error: error?.message });
        return;
      }

      for (const job of jobs) {
        try {
          // Dedup: skip if already run this minute
          // Trace: S4, Section 3a — lastRunMinute dedup
          if (job.lastRunMinute === currentMinute) continue;

          // Check if cron expression matches current time
          if (!matchesCronExpression(job.expression, now)) continue;

          logger.info('Cron job due', { name: job.name, owner: job.owner, channel: job.channel });

          await this.executeJob(job, now);
        } catch (error: any) {
          logger.error('Cron job execution failed', {
            name: job.name,
            error: error?.message,
          });
          // Mark as run to prevent retry storm
          try {
            this.deps.storage.updateLastRun(job.id, now);
          } catch {}
        }
      }
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Execute a single cron job: check session state and inject or queue.
   */
  private async executeJob(job: CronJob, now: Date): Promise<void> {
    const session = this.findSession(job.owner, job.channel, job.threadTs);

    if (!session) {
      // Scenario 6: No session → create new thread
      await this.executeWithNewThread(job, now);
    } else if (session.activityState === 'idle') {
      // Scenario 4: Idle → inject immediately
      await this.injectMessage(job, session, now);
    } else {
      // Scenario 5: Busy → queue and wait for idle
      this.enqueueForIdle(job, session, now);
    }
  }

  /**
   * Find an active session for the given owner+channel.
   * Trace: docs/cron-scheduler/trace.md, Scenario 4, Section 3b
   */
  private findSession(owner: string, channel: string, threadTs?: string | null): ConversationSession | undefined {
    const sessions = this.deps.sessionRegistry.getAllSessions();

    const isEligible = (s: ConversationSession) =>
      s.ownerId === owner &&
      s.channelId === channel &&
      s.isActive &&
      s.state !== 'SLEEPING'; // Sleeping sessions should not receive cron injections

    // If threadTs specified, match exactly
    if (threadTs) {
      for (const [, session] of sessions) {
        if (isEligible(session) && session.threadTs === threadTs) {
          return session;
        }
      }
    }

    // Fallback: match owner+channel (any thread)
    for (const [, session] of sessions) {
      if (isEligible(session)) {
        return session;
      }
    }
    return undefined;
  }

  /**
   * Inject a synthetic message into an idle session.
   * Trace: docs/cron-scheduler/trace.md, Scenario 4, Section 3c
   * Pattern: src/slack-handler.ts:745-762 (autoResumeSession)
   */
  private async injectMessage(job: CronJob, session: ConversationSession, now: Date): Promise<void> {
    const syntheticEvent: SyntheticMessageEvent = {
      user: job.owner,
      channel: session.channelId,
      thread_ts: session.threadTs,
      ts: `${Date.now() / 1000}`,
      text: `[cron:${job.name}] ${job.prompt}`,
    };

    logger.info('Injecting cron message', {
      name: job.name,
      sessionKey: `${session.channelId}-${session.threadTs}`,
    });

    await this.deps.messageInjector(syntheticEvent);
    this.deps.storage.updateLastRun(job.id, now);
  }

  /**
   * Queue a cron job for later execution when session becomes idle.
   * Trace: docs/cron-scheduler/trace.md, Scenario 5, Section 3a
   */
  private enqueueForIdle(job: CronJob, session: ConversationSession, now: Date): void {
    const sessionKey = `${session.channelId}-${session.threadTs || 'direct'}`;
    const queue = this.pendingCronQueue.get(sessionKey) || [];
    const isFirstInQueue = queue.length === 0;
    queue.push(job);
    this.pendingCronQueue.set(sessionKey, queue);

    logger.info('Queued cron for idle', {
      name: job.name,
      sessionKey,
      queueSize: queue.length,
    });

    // Only register onIdle callback for the FIRST job in queue.
    // Subsequent jobs piggyback on the existing callback.
    // drainQueue() pops one and re-registers if more remain.
    if (isFirstInQueue) {
      this.deps.sessionRegistry.registerOnIdle(sessionKey, () => {
        this.drainQueue(sessionKey, now);
      });
    }

    // Mark as run to prevent re-queueing next tick
    this.deps.storage.updateLastRun(job.id, now);
  }

  /**
   * Drain one job from the pending queue for a session.
   * If more remain, re-register for next idle.
   * Trace: docs/cron-scheduler/trace.md, Scenario 5, Section 3d
   */
  private drainQueue(sessionKey: string, now: Date): void {
    const queue = this.pendingCronQueue.get(sessionKey);
    if (!queue || queue.length === 0) {
      this.pendingCronQueue.delete(sessionKey);
      return;
    }

    const job = queue.shift()!;
    logger.info('Draining queued cron on idle', { name: job.name, sessionKey, remaining: queue.length });

    // Find session again (it may have changed)
    const session = this.findSession(job.owner, job.channel);
    if (!session) {
      logger.warn('Session gone before drain, skipping', { name: job.name });
      if (queue.length === 0) this.pendingCronQueue.delete(sessionKey);
      return;
    }

    // Fire-and-forget injection
    const syntheticEvent: SyntheticMessageEvent = {
      user: job.owner,
      channel: session.channelId,
      thread_ts: session.threadTs,
      ts: `${Date.now() / 1000}`,
      text: `[cron:${job.name}] ${job.prompt}`,
    };

    this.deps.messageInjector(syntheticEvent).catch((err: any) => {
      logger.error('Drain inject failed', { name: job.name, error: err?.message });
    });

    // If more jobs remain, re-register for next idle cycle
    if (queue.length > 0) {
      this.deps.sessionRegistry.registerOnIdle(sessionKey, () => {
        this.drainQueue(sessionKey, now);
      });
    } else {
      this.pendingCronQueue.delete(sessionKey);
    }
  }

  /**
   * Create a new bot-initiated thread and inject the cron message.
   * Trace: docs/cron-scheduler/trace.md, Scenario 6, Section 3b-3c
   */
  private async executeWithNewThread(job: CronJob, now: Date): Promise<void> {
    logger.info('No session found, creating new thread', { name: job.name, channel: job.channel });

    try {
      const rootTs = await this.deps.threadCreator(job.channel, `[cron:${job.name}] Scheduled task`);
      if (!rootTs) {
        logger.warn('Failed to create thread (no ts returned)', { name: job.name });
        return;
      }

      const syntheticEvent: SyntheticMessageEvent = {
        user: job.owner,
        channel: job.channel,
        thread_ts: rootTs,
        ts: `${Date.now() / 1000}`,
        text: `[cron:${job.name}] ${job.prompt}`,
      };

      await this.deps.messageInjector(syntheticEvent);
      this.deps.storage.updateLastRun(job.id, now);
    } catch (error: any) {
      logger.error('New thread creation failed', { name: job.name, error: error?.message });
    }
  }

  /**
   * Clear pending queue for a session (cleanup on session removal).
   * Trace: docs/cron-scheduler/trace.md, Scenario 5, Section 5
   */
  clearPendingQueue(sessionKey: string): void {
    this.pendingCronQueue.delete(sessionKey);
  }

  /** Get pending queue size for a session (testing). */
  getPendingQueueSize(sessionKey: string): number {
    return this.pendingCronQueue.get(sessionKey)?.length || 0;
  }
}
