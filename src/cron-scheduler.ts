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
import { auxModelFor } from './agent-runtime/aux-model';
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
  /** Effort that goes with `modelOverride` (Grok's `fast` tier lowers effort instead of the model). */
  effortOverride?: string;
  /**
   * The job behind this fire (SSOT 2026-10-23 T1): a session the fire creates
   * is named after it and filed under it on the dashboard.
   */
  cron?: { jobId: string; jobName: string };
  /** Route context — skipAutoBotThread prevents duplicate root message creation */
  routeContext?: {
    skipAutoBotThread?: boolean;
    /** Goal auto-continuation marker — never supersede a live turn (M2). */
    goalContinuation?: boolean;
    /**
     * #893 — this continuation spent one of this goal's continuations (a
     * `continue` verdict) at this intent epoch. A continuation the busy slot
     * drops gives it back while that goal and epoch are still live.
     */
    goalContinuationSpent?: { goalId: string; epoch: number };
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

/**
 * Resolve model override string from CronModelConfig. undefined = use session default.
 * `opus` / `fable` read MODEL_ALIASES on every fire, so they follow the latest
 * generation without rewriting stored jobs. `fast` is the `sonnet` aux tier of
 * the job creator's (`owner`) default model, also resolved on every fire:
 * Claude → `sonnet`, Codex → `terra`, Grok → `grok` (agent-runtime/aux-model.ts).
 * Grok has one model line, so its tier lowers effort instead — see
 * `resolveEffortOverride`, which every fire sends beside this override.
 */
export function resolveModelOverride(config?: CronModelConfig, owner?: string): string | undefined {
  if (!config || config.type === 'default') return undefined;
  if (config.type === 'opus') return MODEL_ALIASES.opus;
  if (config.type === 'fable') return MODEL_ALIASES.fable;
  if (config.type === 'fast') return auxModelFor('sonnet', { userId: owner }).model;
  if (config.type === 'custom' && config.model) return config.model;
  return undefined;
}

/**
 * The effort that goes with `resolveModelOverride`. Only the `fast` tier sets
 * one, and only when the tier is served by lowering effort (Grok → `medium`);
 * Claude and Codex tiers are smaller models and keep the session's effort.
 */
export function resolveEffortOverride(config?: CronModelConfig, owner?: string): string | undefined {
  return config?.type === 'fast' ? auxModelFor('sonnet', { userId: owner }).effort : undefined;
}

/** The structured origin every injected fire carries. */
function cronOrigin(job: CronJob): { jobId: string; jobName: string } {
  return { jobId: job.id, jobName: job.name };
}

/** A session a fire may be injected into: live and not sleeping. */
function isAwake(session: ConversationSession): boolean {
  return session.isActive && session.state !== 'SLEEPING';
}

/** The session was opened by an earlier fire of this job (the dashboard's CRON-lane rule, cron-view.ts). */
function openedByJob(session: ConversationSession, job: CronJob): boolean {
  const stamp = session.cronJob;
  if (!stamp) return false;
  return stamp.id ? stamp.id === job.id : stamp.name === job.name;
}

function activityMs(session: ConversationSession): number {
  const t =
    session.lastActivity instanceof Date ? session.lastActivity.getTime() : Date.parse(String(session.lastActivity));
  return Number.isFinite(t) ? t : 0;
}

/** The text a fire injects / posts. */
function cronText(job: CronJob): string {
  return `[cron:${job.name}] ${job.prompt}`;
}

export class CronScheduler {
  private deps: CronSchedulerDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pendingCronQueue: Map<string, CronJob[]> = new Map();
  private isRunning = false;
  /**
   * Jobs whose scheduled fire is still running (its turn has not ended). A tick launches a fire and moves on — it
   * never waits for the turn — so one long job cannot hold the others past the catch-up window; this set keeps a
   * job from being fired again on top of its own running turn.
   */
  private inFlight: Set<string> = new Set();
  /** Fires launched by ticks whose turns have not ended yet. */
  private runs: Set<Promise<void>> = new Set();
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
   */
  async runJobNow(
    owner: string,
    name: string,
    opts?: { triggeredBy?: string },
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
      // A fire by hand always carries who pressed it (the owner when the caller did not say), so the history
      // marks it manual; recordExecution keeps the name only when it is not the owner.
      const pressedBy = opts?.triggeredBy ?? job.owner;
      // Delivery helpers record failures internally and report via the return
      // status — surface that here so the ▶ button never claims success on a
      // swallowed Slack delivery error.
      const result = await this.executeJob(job, now, pressedBy);
      return result.ok
        ? { ok: true, message: result.detail }
        : { ok: false, message: `delivery failed (${result.detail}) — cron history 확인` };
    } catch (error: any) {
      logger.error('Manual cron fire failed', { name: job.name, error: error?.message });
      this.recordExecution(job, 'failed', 'idle_inject', undefined, error?.message, opts?.triggeredBy ?? job.owner);
      return { ok: false, message: error?.message ?? 'unknown error' };
    }
  }

  /**
   * Open a bot thread in `channel` and run `text` there as `owner` — the path a scheduled fire takes, so the
   * session is the owner's. An environment user's skill that another user asked for (and an admin approved) runs
   * this way (env-access). `onOpened` gets the root ts as soon as the thread exists; resolves with it once the
   * turn ends, or undefined when Slack returned no ts.
   */
  async runAsUserInNewThread(input: {
    owner: string;
    channel: string;
    rootText: string;
    text: string;
    onOpened?: (rootTs: string) => void;
  }): Promise<string | undefined> {
    const rootTs = await this.deps.threadCreator(input.channel, input.rootText);
    if (!rootTs) return undefined;
    input.onOpened?.(rootTs);
    await this.deps.messageInjector({
      user: input.owner,
      channel: input.channel,
      thread_ts: rootTs,
      ts: `${Date.now() / 1000}`,
      text: input.text,
      synthetic: true,
      skipDispatch: true,
      routeContext: { skipAutoBotThread: true },
    });
    return rootTs;
  }

  /**
   * Main tick: evaluate all cron jobs against every minute since the last
   * evaluated one, up to now. A job whose minute fell between two ticks (the
   * timer fired late across a minute boundary) fires late instead of never.
   * Several missed minutes of one job coalesce into a single fire. Due fires are
   * launched, not awaited: a long turn never holds the other jobs (see `launch`).
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

          if (this.inFlight.has(job.id)) {
            logger.warn('Cron job still running from an earlier fire — this fire is skipped', {
              name: job.name,
              owner: job.owner,
              scheduledMinute: minuteKey(dueMinute),
            });
            continue;
          }

          logger.info('Cron job due', {
            name: job.name,
            owner: job.owner,
            channel: job.channel,
            ...(dueMinute < nowMinute ? { scheduledMinute: minuteKey(dueMinute) } : {}),
          });

          // Launch, do not wait: a fire into a new thread resolves only when its turn ends (hours, for a long
          // daily job), and waiting here would hold every other job past the catch-up window.
          this.launch(job, now);
        } catch (error: any) {
          this.recordTickFailure(job, now, error);
        }
      }
      this.lastEvaluatedMinute = nowMinute;
    } finally {
      this.isRunning = false;
    }
  }

  /** Run one scheduled fire in the background; the job counts as running until its turn ends. */
  private launch(job: CronJob, now: Date): void {
    this.inFlight.add(job.id);
    const run: Promise<void> = this.executeJob(job, now)
      .then(() => undefined)
      .catch((error: any) => this.recordTickFailure(job, now, error))
      .finally(() => {
        this.inFlight.delete(job.id);
        this.runs.delete(run);
      });
    this.runs.add(run);
  }

  /** Resolves once every fire launched by a tick so far has finished its turn. */
  async settled(): Promise<void> {
    while (this.runs.size > 0) await Promise.allSettled([...this.runs]);
  }

  private recordTickFailure(job: CronJob, now: Date, error: any): void {
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
  private async executeJob(job: CronJob, now: Date, triggeredBy?: string): Promise<{ ok: boolean; detail: string }> {
    const target = job.target || 'channel';

    // DM target: send directly to user, no session interaction
    if (target === 'dm') {
      return { ok: await this.executeWithDm(job, now, triggeredBy), detail: 'dm' };
    }

    // Thread target: post reply in existing thread, no session interaction
    if (target === 'thread') {
      return { ok: await this.executeWithThreadReply(job, now, triggeredBy), detail: 'thread_reply' };
    }

    // Channel target (default): original behavior
    // Fastlane: always new thread, skip session lookup
    if (job.mode === 'fastlane') {
      return { ok: await this.executeWithNewThread(job, now, triggeredBy), detail: 'new_thread' };
    }

    const session = this.findSession(job);

    if (!session) {
      // Scenario 6: No session → create new thread
      return { ok: await this.executeWithNewThread(job, now, triggeredBy), detail: 'new_thread' };
    }
    if (session.activityState === 'idle') {
      // Scenario 4: Idle → inject immediately
      await this.injectMessage(job, session, now, triggeredBy);
      return { ok: true, detail: 'idle_inject' };
    }
    // Scenario 5: Busy → queue and wait for idle
    this.enqueueForIdle(job, session, now, triggeredBy);
    return { ok: true, detail: 'busy_queue' };
  }

  /**
   * The job's own awake session, or undefined (→ a new thread). A job that names
   * a thread owns the session in that thread; a job with no thread owns the
   * sessions its earlier fires opened (stamped `cronJob`), the most recently
   * active first. Never another of the owner's sessions in the channel: a job
   * with no thread used to land in whichever one the registry listed first, so
   * a daily job ran inside an unrelated old session and the dashboard linked
   * the run to that session's card.
   * Trace: docs/archive/features/cron-scheduler/trace.md, Scenario 4, Section 3b
   */
  private findSession(job: CronJob): ConversationSession | undefined {
    let own: ConversationSession | undefined;
    for (const [, session] of this.deps.sessionRegistry.getAllSessions()) {
      if (session.ownerId !== job.owner || session.channelId !== job.channel || !isAwake(session)) continue;
      if (job.threadTs) {
        if (session.threadTs === job.threadTs) return session;
      } else if (openedByJob(session, job) && (!own || activityMs(session) > activityMs(own))) {
        own = session;
      }
    }
    return own;
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
  ): Promise<void> {
    const syntheticEvent: SyntheticMessageEvent = {
      user: job.owner,
      channel: session.channelId,
      thread_ts: session.threadTs,
      ts: `${Date.now() / 1000}`,
      text: cronText(job),
      synthetic: true,
      skipDispatch: true,
      modelOverride: resolveModelOverride(job.modelConfig, job.owner),
      effortOverride: resolveEffortOverride(job.modelConfig, job.owner),
      cron: cronOrigin(job),
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
  private enqueueForIdle(job: CronJob, session: ConversationSession, now: Date, triggeredBy?: string): void {
    const sessionKey = buildWorkSessionKey(session.channelId, session.threadTs);
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

    // The job as it is now: one deleted while its fire waited does not run (the next queued one does), and an
    // edited one runs as edited. A storage that cannot be read keeps the queued copy — a read error drops nothing.
    let job: CronJob | undefined;
    while (!job && queue.length > 0) {
      const queued = queue.shift()!;
      job = this.currentJob(queued);
      if (!job)
        logger.info('Queued cron dropped — the job was deleted while it waited', { name: queued.name, sessionKey });
    }
    if (!job) {
      this.pendingCronQueue.delete(sessionKey);
      return;
    }
    logger.info('Draining queued cron on idle', { name: job.name, sessionKey, remaining: queue.length });

    // The session this fire was queued behind — the one its history row links
    // to. Re-searching the channel here used to hand the fire to whichever of
    // the owner's sessions came first, not the one that just went idle.
    const session = this.deps.sessionRegistry.getSessionByKey(sessionKey);
    if (!session || !isAwake(session)) {
      // Every fire still queued here waited for this same session: none of
      // them can run, and with no idle hook left they would sit forever.
      logger.warn('Session gone before drain, dropping its queued fires', {
        names: [job.name, ...queue.map((queued) => queued.name)],
        sessionKey,
      });
      this.pendingCronQueue.delete(sessionKey);
      return;
    }

    // Fire-and-forget injection
    const syntheticEvent: SyntheticMessageEvent = {
      user: job.owner,
      channel: session.channelId,
      thread_ts: session.threadTs,
      ts: `${Date.now() / 1000}`,
      text: cronText(job),
      synthetic: true,
      skipDispatch: true,
      modelOverride: resolveModelOverride(job.modelConfig, job.owner),
      effortOverride: resolveEffortOverride(job.modelConfig, job.owner),
      cron: cronOrigin(job),
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

  /** The stored job a queued fire belongs to, as it is now; undefined when it was deleted. */
  private currentJob(queued: CronJob): CronJob | undefined {
    try {
      return this.deps.storage.getAll().find((j) => j.id === queued.id);
    } catch (error: any) {
      logger.warn('Cron storage unreadable at drain — running the queued copy', {
        name: queued.name,
        error: error?.message,
      });
      return queued;
    }
  }

  /**
   * Create a new bot-initiated thread and inject the cron message.
   * Trace: docs/archive/features/cron-scheduler/trace.md, Scenario 6, Section 3b-3c
   */
  private async executeWithNewThread(job: CronJob, now: Date, triggeredBy?: string): Promise<boolean> {
    logger.info('No session found, creating new thread', { name: job.name, channel: job.channel });

    let openedTs: string | undefined;
    try {
      const rootTs = await this.injectInNewThread(job, `[cron:${job.name}] Scheduled task`, cronText(job), (ts) => {
        openedTs = ts;
      });
      if (!rootTs) {
        logger.warn('Failed to create thread (no ts returned)', { name: job.name });
        this.recordExecution(job, 'failed', 'new_thread', undefined, 'thread creation returned no ts', triggeredBy);
        return false;
      }

      this.deps.storage.updateLastRun(job.id, now);
      // The session this fire opened, in the same shape idle_inject records —
      // the dashboard's run history links the run to it (SSOT 2026-10-23 T5).
      this.recordExecution(job, 'success', 'new_thread', `${job.channel}-${rootTs}`, undefined, triggeredBy);
      return true;
    } catch (error: any) {
      logger.error('New thread creation failed', { name: job.name, error: error?.message });
      // When the thread was opened, the failure belongs to that session too —
      // the dashboard must not read its card as a separate, successful run.
      this.recordExecution(
        job,
        'failed',
        'new_thread',
        openedTs ? `${job.channel}-${openedTs}` : undefined,
        error?.message,
        triggeredBy,
      );
      return false;
    }
  }

  /**
   * Open a bot thread in `job.channel` with `rootText` and inject `text` into
   * it as `job.owner`, on the job's model. The fire names and files the session
   * it opens (SSOT 2026-10-23 T1). `onOpened` is told the root ts as soon as the
   * thread exists, before the turn runs. Resolves with the root ts once the
   * injected turn ends, or undefined when Slack returned no ts (nothing
   * injected). Throws what the thread creator or the injector throws.
   */
  private async injectInNewThread(
    job: CronJob,
    rootText: string,
    text: string,
    onOpened?: (rootTs: string) => void,
  ): Promise<string | undefined> {
    const rootTs = await this.deps.threadCreator(job.channel, rootText);
    if (!rootTs) return undefined;
    onOpened?.(rootTs);

    const syntheticEvent: SyntheticMessageEvent = {
      user: job.owner,
      channel: job.channel,
      thread_ts: rootTs,
      ts: `${Date.now() / 1000}`,
      text,
      synthetic: true,
      skipDispatch: true,
      modelOverride: resolveModelOverride(job.modelConfig, job.owner),
      effortOverride: resolveEffortOverride(job.modelConfig, job.owner),
      cron: cronOrigin(job),
      routeContext: { skipAutoBotThread: true },
    };

    await this.deps.messageInjector(syntheticEvent);
    return rootTs;
  }

  /**
   * Send cron result as a DM to the job owner.
   */
  private async executeWithDm(job: CronJob, now: Date, triggeredBy?: string): Promise<boolean> {
    if (!this.deps.dmSender) {
      logger.warn('DM sender not configured, falling back to new thread', { name: job.name });
      return this.executeWithNewThread(job, now, triggeredBy);
    }

    try {
      const text = cronText(job);
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
  private async executeWithThreadReply(job: CronJob, now: Date, triggeredBy?: string): Promise<boolean> {
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
      return this.executeWithNewThread(job, now, triggeredBy);
    }

    try {
      const text = cronText(job);
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
        // A fire with a presser is a fire by hand (runJobNow always passes one); a scheduled fire has none.
        ...(triggeredBy !== undefined ? { manual: true as const } : {}),
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
