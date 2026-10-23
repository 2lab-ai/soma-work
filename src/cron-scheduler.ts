/**
 * CronScheduler — Polls every 60s, matches cron expressions for every minute since
 * the last evaluated one (bounded catch-up), injects synthetic messages.
 * Trace: docs/archive/features/cron-scheduler/trace.md, Scenarios 4-6
 *
 * Pattern: src/metrics/report-scheduler.ts (setInterval polling)
 * Pattern: src/slack-handler.ts:745-762 (autoResumeSession synthetic message)
 */

import {
  type CronExecutionRecord,
  type CronJob,
  type CronModelConfig,
  type CronStorage,
  matchesCronExpression,
} from 'somalib/cron/cron-storage';
import { Logger } from './logger';
import { buildWorkSessionKey } from './session-identity';
import type { SessionRegistry } from './session-registry';
import type { ConversationSession } from './types';
import { MODEL_ALIASES } from './user-settings-store';

const logger = new Logger('CronScheduler');
const POLL_INTERVAL_MS = 60_000; // 1 minute
/**
 * How far back a tick catches up on minutes it did not evaluate (a tick dropped
 * while the previous one was still running, or a timer that fired late across a
 * minute boundary). Bounded so a host that slept for hours does not replay the
 * whole gap.
 */
const MAX_CATCH_UP_MINUTES = 60;
const MINUTE_MS = 60_000;

/** Synthetic message event matching slack-handler's MessageEvent shape */
export interface SyntheticMessageEvent {
  user: string;
  channel: string;
  thread_ts?: string;
  ts: string;
  text: string;
  /** Marks as synthetic — treated as direct command not user input */
  synthetic?: boolean;
  /** Skip dispatch (workflow classification) — go straight to default workflow */
  skipDispatch?: boolean;
  /** Model override for cron jobs with non-default model config */
  modelOverride?: string;
  /** Route context — skipAutoBotThread prevents duplicate root message creation */
  routeContext?: {
    skipAutoBotThread?: boolean;
    /** Goal auto-continuation marker — never supersede a live turn (M2). */
    goalContinuation?: boolean;
  };
}

/** Callback type for injecting messages into the handleMessage pipeline */
export type MessageInjector = (event: SyntheticMessageEvent) => Promise<void>;

/** Callback type for creating a new bot-initiated thread */
export type ThreadCreator = (channel: string, text: string) => Promise<string | undefined>;

/** Callback type for sending a DM to a user */
export type DmSender = (userId: string, text: string) => Promise<void>;

/** Callback type for posting a reply in an existing thread */
export type ThreadReplier = (channel: string, threadTs: string, text: string) => Promise<void>;

export interface CronSchedulerDeps {
  storage: CronStorage;
  sessionRegistry: SessionRegistry;
  messageInjector: MessageInjector;
  threadCreator: ThreadCreator;
  /** Optional: sends DM to user. Required for target='dm'. */
  dmSender?: DmSender;
  /** Optional: posts reply in existing thread. Required for target='thread'. */
  threadReplier?: ThreadReplier;
}

// Get current minute string in YYYY-MM-DDTHH:mm format for dedup.
// Prevents re-fire within the same calendar minute while allowing
// multi-fire-per-day crons (e.g. every 15 min).
function minuteKey(epochMinute: number): string {
  return new Date(epochMinute * MINUTE_MS).toISOString().slice(0, 16);
}

const FAST_MODEL = 'claude-sonnet-4-20250514';

/**
 * Resolve model override string from CronModelConfig. undefined = use session default.
 * `opus` / `fable` read MODEL_ALIASES on every fire, so they follow the latest
 * generation without rewriting stored jobs.
 */
export function resolveModelOverride(config?: CronModelConfig): string | undefined {
  if (!config || config.type === 'default') return undefined;
  if (config.type === 'opus') return MODEL_ALIASES.opus;
  if (config.type === 'fable') return MODEL_ALIASES.fable;
  if (config.type === 'fast') return FAST_MODEL;
  if (config.type === 'custom' && config.model) return config.model;
  return undefined;
}

/**
 * Per-fire options beyond the job itself. `note` is appended to the injected
 * prompt on every delivery path (queued entries keep it), so a fire can carry
 * context the job definition does not — e.g. which deploy triggered it.
 * `forceNewThread` takes the fastlane path whatever the job's mode/target say.
 */
export interface CronFireOptions {
  note?: string;
  forceNewThread?: boolean;
}

/** A fire waiting for its session to go idle. */
interface QueuedCron {
  job: CronJob;
  note?: string;
}

/** The text a fire injects / posts. */
function cronText(job: CronJob, note?: string): string {
  return `[cron:${job.name}] ${job.prompt}${note ?? ''}`;
}

/**
 * What {@link CronScheduler.fireDeployLane} runs: a deploy-only lane
 * (src/deploy-lanes.ts) — the parts of a cron job a fire needs, without being one.
 */
export type DeployLaneSpec = Pick<CronJob, 'name' | 'owner' | 'channel' | 'prompt' | 'modelConfig'>;

export class CronScheduler {
  private deps: CronSchedulerDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pendingCronQueue: Map<string, QueuedCron[]> = new Map();
  private isRunning = false;
  /** Last epoch minute a completed tick evaluated; null until the first tick. */
  private lastEvaluatedMinute: number | null = null;

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
    this.tick().catch((err) => logger.error('Initial tick failed', { error: err?.message }));
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
   * Manually fire a job NOW through the exact same execution path a scheduled
   * fire takes (target/mode/model resolution, session inject/queue/new-thread,
   * execution history, lastRun bookkeeping). Used by the cron card's ▶ button —
   * this is a REAL cron firing, not a model-side simulation.
   *
   * `triggeredBy` names the user who pulled the trigger when that is NOT the
   * owner (an allowlisted user, or an owner-approved one-off). The job still
   * runs with the owner's identity; the attribution exists so cron history can
   * answer "who fired this" — the one question a permission feature must not
   * leave to the log file.
   *
   * `forceNewThread` / `note`: see {@link CronFireOptions}. A deploy-triggered
   * fire uses both — it must start now in its own thread (queued behind the
   * owner's busy session it would only claim to have started), and it must know
   * which deploy fired it.
   */
  async runJobNow(
    owner: string,
    name: string,
    opts?: { triggeredBy?: string } & CronFireOptions,
  ): Promise<{ ok: boolean; message: string }> {
    let job: CronJob | undefined;
    try {
      job = this.deps.storage.getJobsByOwner(owner).find((j) => j.name === name);
    } catch (error: any) {
      return { ok: false, message: `storage read failed: ${error?.message}` };
    }
    if (!job) {
      return { ok: false, message: `Cron job '${name}' not found` };
    }
    const now = new Date();
    try {
      logger.info('Manual cron fire', { name: job.name, owner: job.owner, triggeredBy: opts?.triggeredBy });
      // Delivery helpers record failures internally and report via the return
      // status — surface that here so the ▶ button never claims success on a
      // swallowed Slack delivery error.
      const result = await this.executeJob(job, now, opts?.triggeredBy, {
        note: opts?.note,
        forceNewThread: opts?.forceNewThread,
      });
      return result.ok
        ? { ok: true, message: result.detail }
        : { ok: false, message: `delivery failed (${result.detail}) — cron history 확인` };
    } catch (error: any) {
      logger.error('Manual cron fire failed', { name: job.name, error: error?.message });
      this.recordExecution(job, 'failed', 'idle_inject', undefined, error?.message, opts?.triggeredBy);
      return { ok: false, message: error?.message ?? 'unknown error' };
    }
  }

  /**
   * Start a deploy-only lane (src/deploy-lanes.ts) in a new thread of its
   * channel: the new-thread path of a cron fire — owner identity, the lane's
   * model, never queued behind a busy session — for something that is not a
   * cron job. So it touches neither cron storage nor cron history; the log is
   * its only record. The thread's root is `rootText`, the injected prompt
   * `[deploy-lane:<name>] <prompt><note>`.
   *
   * Same contract as {@link runJobNow}: resolves when the injected turn ends,
   * `{ ok: false }` when the thread could not be created or the fire threw.
   */
  async fireDeployLane(
    lane: DeployLaneSpec,
    opts: { triggeredBy?: string; note?: string; rootText: string },
  ): Promise<{ ok: boolean; message: string }> {
    logger.info('Deploy lane fire', { name: lane.name, owner: lane.owner, triggeredBy: opts.triggeredBy });
    try {
      const rootTs = await this.injectInNewThread(
        lane,
        opts.rootText,
        `[deploy-lane:${lane.name}] ${lane.prompt}${opts.note ?? ''}`,
      );
      if (!rootTs) {
        logger.error('Deploy lane thread not created (no ts returned)', { name: lane.name, channel: lane.channel });
        return { ok: false, message: 'thread creation returned no ts' };
      }
      logger.info('Deploy lane turn ended', { name: lane.name, owner: lane.owner, channel: lane.channel, rootTs });
      return { ok: true, message: 'new_thread' };
    } catch (error: any) {
      logger.error('Deploy lane fire failed', { name: lane.name, error: error?.message });
      return { ok: false, message: error?.message ?? 'unknown error' };
    }
  }

  /**
   * Main tick: evaluate all cron jobs against every minute since the last
   * evaluated one, up to now. A job whose minute fell between two ticks (the
   * previous tick was still awaiting a turn, or the timer fired late across a
   * minute boundary) fires late instead of never. Several missed minutes of one
   * job coalesce into a single fire.
   * Trace: docs/archive/features/cron-scheduler/trace.md, Scenario 4, Section 3a
   */
  async tick(): Promise<void> {
    // Guard against overlapping ticks (setInterval can fire while previous tick is still running).
    // The dropped tick's minutes are caught up by the next tick that runs.
    if (this.isRunning) {
      logger.debug('Tick skipped — previous tick still running');
      return;
    }
    this.isRunning = true;

    const now = new Date();
    const nowMinute = Math.floor(now.getTime() / MINUTE_MS);
    const oldestAllowed = nowMinute - MAX_CATCH_UP_MINUTES + 1;
    const firstMinute =
      this.lastEvaluatedMinute === null ? nowMinute : Math.max(this.lastEvaluatedMinute + 1, oldestAllowed);
    if (this.lastEvaluatedMinute !== null && this.lastEvaluatedMinute + 1 < oldestAllowed) {
      logger.warn('Cron catch-up window exceeded — older minutes not replayed', {
        from: minuteKey(this.lastEvaluatedMinute + 1),
        to: minuteKey(oldestAllowed - 1),
      });
    }

    try {
      let jobs: CronJob[];
      try {
        jobs = this.deps.storage.getAll();
      } catch (error: any) {
        logger.error('Failed to load cron jobs', { error: error?.message });
        return;
      }

      for (const listed of jobs) {
        let job = listed;
        try {
          if (this.findDueMinute(job, firstMinute, nowMinute) === null) continue;
          // Re-read before firing: an earlier job of this tick may have awaited
          // a whole turn, long enough for a run-now, an edit or a delete to land.
          const current = this.deps.storage.getAll().find((j) => j.id === listed.id);
          if (!current) continue;
          job = current;
          const dueMinute = this.findDueMinute(job, firstMinute, nowMinute);
          if (dueMinute === null) continue;

          logger.info('Cron job due', {
            name: job.name,
            owner: job.owner,
            channel: job.channel,
            ...(dueMinute < nowMinute ? { scheduledMinute: minuteKey(dueMinute) } : {}),
          });

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
          this.recordExecution(job, 'failed', 'idle_inject', undefined, error?.message);
        }
      }
      this.lastEvaluatedMinute = nowMinute;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * First minute in [fromMinute, toMinute] at which the job is due, existed,
   * and has not already run (scheduled or run-now), or null.
   * Trace: S4, Section 3a — lastRunMinute dedup
   */
  private findDueMinute(job: CronJob, fromMinute: number, toMinute: number): number | null {
    // Catch-up never reaches before the job, or its current schedule, existed.
    const createdMinute = [job.createdAt, job.scheduleChangedAt]
      .filter((t): t is string => typeof t === 'string')
      .map((t) => t.slice(0, 16))
      .reduce((a, b) => (b > a ? b : a), '');
    for (let m = fromMinute; m <= toMinute; m++) {
      const key = minuteKey(m);
      if (key < createdMinute) continue;
      if (job.lastRunMinute && job.lastRunMinute >= key) continue;
      if (matchesCronExpression(job.expression, new Date(m * MINUTE_MS))) return m;
    }
    return null;
  }

  /**
   * Execute a single cron job: check session state and inject or queue.
   * Fastlane mode always creates a new thread regardless of session state.
   * Target determines delivery: channel (default), thread (reply), or dm.
   */
  private async executeJob(
    job: CronJob,
    now: Date,
    triggeredBy?: string,
    fire: CronFireOptions = {},
  ): Promise<{ ok: boolean; detail: string }> {
    const { note } = fire;

    // Forced: always a new thread in the job channel, whatever mode/target say.
    if (fire.forceNewThread) {
      return { ok: await this.executeWithNewThread(job, now, triggeredBy, note), detail: 'new_thread' };
    }

    const target = job.target || 'channel';

    // DM target: send directly to user, no session interaction
    if (target === 'dm') {
      return { ok: await this.executeWithDm(job, now, triggeredBy, note), detail: 'dm' };
    }

    // Thread target: post reply in existing thread, no session interaction
    if (target === 'thread') {
      return { ok: await this.executeWithThreadReply(job, now, triggeredBy, note), detail: 'thread_reply' };
    }

    // Channel target (default): original behavior
    // Fastlane: always new thread, skip session lookup
    if (job.mode === 'fastlane') {
      return { ok: await this.executeWithNewThread(job, now, triggeredBy, note), detail: 'new_thread' };
    }

    const session = this.findSession(job.owner, job.channel, job.threadTs);

    if (!session) {
      // Scenario 6: No session → create new thread
      return { ok: await this.executeWithNewThread(job, now, triggeredBy, note), detail: 'new_thread' };
    }
    if (session.activityState === 'idle') {
      // Scenario 4: Idle → inject immediately
      await this.injectMessage(job, session, now, triggeredBy, note);
      return { ok: true, detail: 'idle_inject' };
    }
    // Scenario 5: Busy → queue and wait for idle
    this.enqueueForIdle(job, session, now, triggeredBy, note);
    return { ok: true, detail: 'busy_queue' };
  }

  /**
   * Find an active session for the given owner+channel.
   * Trace: docs/archive/features/cron-scheduler/trace.md, Scenario 4, Section 3b
   */
  private findSession(owner: string, channel: string, threadTs?: string | null): ConversationSession | undefined {
    const sessions = this.deps.sessionRegistry.getAllSessions();

    const isEligible = (s: ConversationSession) =>
      s.ownerId === owner && s.channelId === channel && s.isActive && s.state !== 'SLEEPING'; // Sleeping sessions should not receive cron injections

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
   * Trace: docs/archive/features/cron-scheduler/trace.md, Scenario 4, Section 3c
   * Pattern: src/slack-handler.ts:745-762 (autoResumeSession)
   */
  private async injectMessage(
    job: CronJob,
    session: ConversationSession,
    now: Date,
    triggeredBy?: string,
    note?: string,
  ): Promise<void> {
    const syntheticEvent: SyntheticMessageEvent = {
      user: job.owner,
      channel: session.channelId,
      thread_ts: session.threadTs,
      ts: `${Date.now() / 1000}`,
      text: cronText(job, note),
      synthetic: true,
      skipDispatch: true,
      modelOverride: resolveModelOverride(job.modelConfig),
      routeContext: { skipAutoBotThread: true },
    };

    logger.info('Injecting cron message', {
      name: job.name,
      sessionKey: `${session.channelId}-${session.threadTs}`,
    });

    await this.deps.messageInjector(syntheticEvent);
    this.deps.storage.updateLastRun(job.id, now);
    this.recordExecution(
      job,
      'success',
      'idle_inject',
      `${session.channelId}-${session.threadTs}`,
      undefined,
      triggeredBy,
    );
  }

  /**
   * Queue a cron job for later execution when session becomes idle.
   * Trace: docs/archive/features/cron-scheduler/trace.md, Scenario 5, Section 3a
   */
  private enqueueForIdle(
    job: CronJob,
    session: ConversationSession,
    now: Date,
    triggeredBy?: string,
    note?: string,
  ): void {
    const sessionKey = buildWorkSessionKey(session.channelId, session.threadTs);
    const queue = this.pendingCronQueue.get(sessionKey) || [];
    const isFirstInQueue = queue.length === 0;
    queue.push({ job, note });
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
        this.drainQueue(sessionKey, new Date());
      });
    }

    // Mark as run to prevent re-queueing next tick
    this.deps.storage.updateLastRun(job.id, now);
    this.recordExecution(job, 'queued', 'busy_queue', sessionKey, undefined, triggeredBy);
  }

  /**
   * Drain one job from the pending queue for a session.
   * If more remain, re-register for next idle.
   * Trace: docs/archive/features/cron-scheduler/trace.md, Scenario 5, Section 3d
   */
  private drainQueue(sessionKey: string, now: Date): void {
    const queue = this.pendingCronQueue.get(sessionKey);
    if (!queue || queue.length === 0) {
      this.pendingCronQueue.delete(sessionKey);
      return;
    }

    const { job, note } = queue.shift()!;
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
      text: cronText(job, note),
      synthetic: true,
      skipDispatch: true,
      modelOverride: resolveModelOverride(job.modelConfig),
      routeContext: { skipAutoBotThread: true },
    };

    this.deps.messageInjector(syntheticEvent).catch((err: any) => {
      logger.error('Drain inject failed', { name: job.name, error: err?.message });
    });

    // If more jobs remain, re-register for next idle cycle
    if (queue.length > 0) {
      this.deps.sessionRegistry.registerOnIdle(sessionKey, () => {
        this.drainQueue(sessionKey, new Date());
      });
    } else {
      this.pendingCronQueue.delete(sessionKey);
    }
  }

  /**
   * Create a new bot-initiated thread and inject the cron message.
   * Trace: docs/archive/features/cron-scheduler/trace.md, Scenario 6, Section 3b-3c
   */
  private async executeWithNewThread(job: CronJob, now: Date, triggeredBy?: string, note?: string): Promise<boolean> {
    logger.info('No session found, creating new thread', { name: job.name, channel: job.channel });

    try {
      const rootTs = await this.injectInNewThread(job, `[cron:${job.name}] Scheduled task`, cronText(job, note));
      if (!rootTs) {
        logger.warn('Failed to create thread (no ts returned)', { name: job.name });
        this.recordExecution(job, 'failed', 'new_thread', undefined, 'thread creation returned no ts', triggeredBy);
        return false;
      }

      this.deps.storage.updateLastRun(job.id, now);
      this.recordExecution(job, 'success', 'new_thread', undefined, undefined, triggeredBy);
      return true;
    } catch (error: any) {
      logger.error('New thread creation failed', { name: job.name, error: error?.message });
      this.recordExecution(job, 'failed', 'new_thread', undefined, error?.message, triggeredBy);
      return false;
    }
  }

  /**
   * Open a bot thread in `fire.channel` with `rootText` and inject `text` into
   * it as `fire.owner`, on the fire's model. Resolves with the root ts once the
   * injected turn ends, or undefined when Slack returned no ts (nothing
   * injected). Throws what the thread creator or the injector throws.
   */
  private async injectInNewThread(fire: DeployLaneSpec, rootText: string, text: string): Promise<string | undefined> {
    const rootTs = await this.deps.threadCreator(fire.channel, rootText);
    if (!rootTs) return undefined;

    const syntheticEvent: SyntheticMessageEvent = {
      user: fire.owner,
      channel: fire.channel,
      thread_ts: rootTs,
      ts: `${Date.now() / 1000}`,
      text,
      synthetic: true,
      skipDispatch: true,
      modelOverride: resolveModelOverride(fire.modelConfig),
      routeContext: { skipAutoBotThread: true },
    };

    await this.deps.messageInjector(syntheticEvent);
    return rootTs;
  }

  /**
   * Send cron result as a DM to the job owner.
   */
  private async executeWithDm(job: CronJob, now: Date, triggeredBy?: string, note?: string): Promise<boolean> {
    if (!this.deps.dmSender) {
      logger.warn('DM sender not configured, falling back to new thread', { name: job.name });
      return this.executeWithNewThread(job, now, triggeredBy, note);
    }

    try {
      const text = cronText(job, note);
      await this.deps.dmSender(job.owner, text);
      this.deps.storage.updateLastRun(job.id, now);
      this.recordExecution(job, 'success', 'dm', undefined, undefined, triggeredBy);
      logger.info('Cron DM sent', { name: job.name, owner: job.owner });
      return true;
    } catch (error: any) {
      logger.error('Cron DM failed', { name: job.name, error: error?.message });
      this.recordExecution(job, 'failed', 'dm', undefined, error?.message, triggeredBy);
      return false;
    }
  }

  /**
   * Post cron result as a reply in an existing thread.
   */
  private async executeWithThreadReply(job: CronJob, now: Date, triggeredBy?: string, note?: string): Promise<boolean> {
    if (!job.threadTs) {
      logger.error('Thread target requires threadTs — cannot deliver', { name: job.name });
      this.deps.storage.updateLastRun(job.id, now);
      this.recordExecution(
        job,
        'failed',
        'thread_reply',
        undefined,
        'threadTs required for thread target',
        triggeredBy,
      );
      return false;
    }
    if (!this.deps.threadReplier) {
      logger.warn('Thread replier not configured, falling back to new thread', { name: job.name });
      return this.executeWithNewThread(job, now, triggeredBy, note);
    }

    try {
      const text = cronText(job, note);
      await this.deps.threadReplier(job.channel, job.threadTs, text);
      this.deps.storage.updateLastRun(job.id, now);
      this.recordExecution(job, 'success', 'thread_reply', undefined, undefined, triggeredBy);
      logger.info('Cron thread reply sent', { name: job.name, channel: job.channel, threadTs: job.threadTs });
      return true;
    } catch (error: any) {
      logger.error('Cron thread reply failed', { name: job.name, error: error?.message });
      this.recordExecution(job, 'failed', 'thread_reply', undefined, error?.message, triggeredBy);
      return false;
    }
  }

  /**
   * Clear pending queue for a session (cleanup on session removal).
   * Trace: docs/archive/features/cron-scheduler/trace.md, Scenario 5, Section 5
   */
  clearPendingQueue(sessionKey: string): void {
    this.pendingCronQueue.delete(sessionKey);
  }

  /** Get pending queue size for a session (testing). */
  getPendingQueueSize(sessionKey: string): number {
    return this.pendingCronQueue.get(sessionKey)?.length || 0;
  }

  /**
   * Record an execution in history. Fire-and-forget — never blocks scheduling.
   * Trace: docs/current/plans/cron-execution-history/spec.md
   */
  private recordExecution(
    job: CronJob,
    status: CronExecutionRecord['status'],
    executionPath: CronExecutionRecord['executionPath'],
    sessionKey?: string,
    error?: string,
    triggeredBy?: string,
  ): void {
    try {
      this.deps.storage.addExecution({
        jobId: job.id,
        jobName: job.name,
        status,
        executionPath,
        sessionKey,
        error,
        // Only recorded for a non-owner fire — an owner firing their own job is
        // the default and needs no attribution noise.
        triggeredBy: triggeredBy && triggeredBy !== job.owner ? triggeredBy : undefined,
      });
    } catch (err: any) {
      logger.warn('Failed to record execution history', { name: job.name, error: err?.message });
    }
  }
}

// --- Active-instance registry ---------------------------------------------
// The scheduler is constructed deep in src/index.ts bootstrap; the cron card's
// ▶ run-now button (src/slack/actions/cron-action-handler.ts) needs to reach
// it without threading a new dependency through the whole action-handler
// context chain. Same singleton pattern as userSettingsStore/getTokenManager.

let activeCronScheduler: CronScheduler | null = null;

export function setActiveCronScheduler(scheduler: CronScheduler | null): void {
  activeCronScheduler = scheduler;
}

export function getActiveCronScheduler(): CronScheduler | null {
  return activeCronScheduler;
}
