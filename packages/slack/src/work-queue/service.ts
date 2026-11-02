/**
 * The work queue as Slack sees it: the session gate, the busy card and its
 * buttons, the 10-minute auto-cancel, and the replay of a queued request.
 *
 * Wiring (composition root): `SessionInitializer` calls `decide` right before
 * `handleConcurrency` (synchronously — the slot is taken in the same tick the
 * turn's AbortController is registered) and `notifyBlocked` when it halts;
 * the action router calls `handleClick`; the registry's before-delete seam
 * calls `onSessionDeleted`; `start()` runs the sweep.
 */
import { Logger } from '@soma/common/logger';
import {
  alreadyWaitingText,
  buildBusyCard,
  buildClosedCard,
  buildWaitingCard,
  cancelledText,
  EXPIRED_CLICK_TEXT,
  type HolderLine,
  NOT_REQUESTER_TEXT,
  slotReturnedText,
  startedText,
  WORK_QUEUE_CANCEL_ACTION,
  WORK_QUEUE_WAIT_ACTION,
} from './blocks';
import type { WorkQueueDef } from './config';
import {
  type SessionProbe,
  type WorkQueueEvent,
  type WorkQueueHolder,
  WorkQueueManager,
  type WorkQueueWaiter,
} from './manager';
import { matchWorkQueue } from './trigger';

export interface WorkQueueSlackApi {
  postMessage(channel: string, text: string, options?: { threadTs?: string; blocks?: any[] }): Promise<{ ts?: string }>;
  updateMessage(channel: string, ts: string, text: string, blocks?: any[]): Promise<unknown>;
  getPermalink?(channel: string, ts: string): Promise<string | null | undefined>;
}

/** The session fields the gate reads and writes (a `ConversationSession`). */
export interface GatedSession {
  workflow?: string;
  /** Persisted binding: later turns of a deploy session stay in its queue. */
  workQueueId?: string;
  /** Set once the session has run an SDK turn. */
  sessionId?: string;
}

export interface GateInput {
  session: GatedSession;
  sessionKey: string;
  channel: string;
  threadTs: string;
  user: string;
  text: string;
}

export type GateDecision =
  | { kind: 'pass' }
  | { kind: 'blocked'; queue: WorkQueueDef; waiter: WorkQueueWaiter; holders: WorkQueueHolder[] }
  | { kind: 'already-waiting'; queue: WorkQueueDef; waiter: WorkQueueWaiter };

export interface ReplayEvent {
  user: string;
  channel: string;
  thread_ts: string;
  ts: string;
  text: string;
  routeContext: { skipAutoBotThread: true };
}

export type ReplayFn = (event: ReplayEvent, say: (msg: any) => Promise<any>) => Promise<void>;
export type RespondFn = (msg: any) => Promise<unknown>;

export interface WorkQueueServiceDeps {
  slackApi: WorkQueueSlackApi;
  getQueues: () => readonly WorkQueueDef[];
  probe: (sessionKey: string) => SessionProbe;
  registerOnIdle?: (sessionKey: string, cb: () => void) => void;
  terminateSession?: (sessionKey: string) => void;
  now?: () => number;
  graceMs?: number;
  /** Runs the idle re-check later (default: an unref'd `setTimeout`). */
  defer?: (fn: () => void, ms: number) => void;
}

export const WORK_QUEUE_SWEEP_MS = 15_000;
/** How long after a holder goes idle its slot is re-checked (turn teardown removes the controller). */
export const IDLE_RECHECK_MS = 3_000;

function defaultDefer(fn: () => void, ms: number): void {
  setTimeout(fn, ms).unref?.();
}

export class WorkQueueService {
  readonly manager: WorkQueueManager;
  private readonly logger = new Logger('WorkQueue');
  private readonly now: () => number;
  private replay?: ReplayFn;
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private sweepMs: number | undefined;
  private readonly idleWatched = new Set<string>();

  constructor(private readonly deps: WorkQueueServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.manager = new WorkQueueManager({
      getQueues: deps.getQueues,
      probe: deps.probe,
      now: this.now,
      graceMs: deps.graceMs,
    });
  }

  /** The host's message entry — set after the handler exists. */
  setReplay(fn: ReplayFn): void {
    this.replay = fn;
  }

  /**
   * Turn the sweep on. The interval itself runs only while something is held
   * or waiting — an idle queue keeps no timer.
   */
  start(intervalMs = WORK_QUEUE_SWEEP_MS): void {
    this.sweepMs = intervalMs;
    this.armSweep();
  }

  stop(): void {
    this.sweepMs = undefined;
    this.disarmSweep();
  }

  private armSweep(): void {
    if (this.sweepMs === undefined || this.timer || this.manager.isIdle()) return;
    this.timer = setInterval(() => void this.runTick(), this.sweepMs);
    this.timer.unref?.();
  }

  private disarmSweep(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Synchronous: the slot is taken (or refused) inside this call, so no other
   * request can claim it before the caller registers the turn. Only the
   * caller's own `await` lies between here and `handleConcurrency`; the
   * sweep's grace covers that window.
   */
  decide(input: GateInput): GateDecision {
    const { session, sessionKey } = input;
    const queues = this.deps.getQueues();
    const boundBefore = session.workQueueId;
    const bound = boundBefore ? queues.find((q) => q.id === boundBefore) : undefined;
    const queue =
      matchWorkQueue(queues, session.workflow, input.text) ??
      (bound && bound.workflow === session.workflow ? bound : undefined);
    if (!queue) return { kind: 'pass' };

    const pending = this.manager.waiterForSession(sessionKey);
    if (pending) {
      const pendingQueue = this.manager.getQueue(pending.queueId);
      if (pendingQueue && boundBefore === pending.queueId) {
        return { kind: 'already-waiting', queue: pendingQueue, waiter: pending };
      }
      // The session was reset (`new` clears the binding) since this request
      // was held: it belongs to the old conversation and must never run.
      void this.handle(this.manager.cancel(pending.id, 'session-reset'));
    }
    // Bound only once this request is going to acquire or wait — a held
    // request keeps the queue it is waiting in.
    session.workQueueId = queue.id;

    const party = { sessionKey, userId: input.user, channel: input.channel, threadTs: input.threadTs };
    const result = this.manager.tryAcquire(queue, party);
    if (result.ok) {
      this.watchIdle(sessionKey);
      this.armSweep();
      return { kind: 'pass' };
    }
    const waiter = this.manager.addWaiter(queue, { ...party, text: input.text, ranBefore: !!session.sessionId });
    this.armSweep();
    this.logger.info('Work queue full — request held', {
      queue: queue.id,
      sessionKey,
      holders: result.holders.map((h) => h.sessionKey),
    });
    return { kind: 'blocked', queue, waiter, holders: result.holders };
  }

  async notifyBlocked(decision: GateDecision): Promise<void> {
    if (decision.kind === 'pass') return;
    const { waiter, queue } = decision;
    if (decision.kind === 'already-waiting') {
      await this.post(waiter.channel, alreadyWaitingText(queue, this.manager.position(waiter.id)), waiter.threadTs);
      return;
    }
    const lines = await Promise.all(decision.holders.map((h) => this.holderLine(h)));
    const card = buildBusyCard(queue, lines, waiter.id);
    const posted = await this.deps.slackApi.postMessage(waiter.channel, card.text, {
      threadTs: waiter.threadTs,
      blocks: card.blocks,
    });
    if (posted?.ts) this.manager.setWaiterCard(waiter.id, posted.ts);
  }

  /** `work_queue_wait` / `work_queue_cancel` button. */
  async handleClick(body: any, respond: RespondFn): Promise<void> {
    const action = body?.actions?.[0];
    const waiterId = typeof action?.value === 'string' ? action.value : '';
    const userId = body?.user?.id;
    const waiter = this.manager.getWaiter(waiterId);
    if (!waiter) {
      await respond({ replace_original: true, text: EXPIRED_CLICK_TEXT }).catch(() => undefined);
      return;
    }
    if (userId !== waiter.userId) {
      await respond({ response_type: 'ephemeral', replace_original: false, text: NOT_REQUESTER_TEXT }).catch(
        () => undefined,
      );
      return;
    }
    if (action.action_id === WORK_QUEUE_CANCEL_ACTION) {
      await this.handle(this.manager.cancel(waiter.id, 'user'));
      return;
    }
    if (action.action_id === WORK_QUEUE_WAIT_ACTION) {
      const result = this.manager.chooseWait(waiter.id);
      if (result.outcome === 'queued') {
        const queue = this.manager.getQueue(waiter.queueId);
        if (queue) await this.updateCard(waiter, buildWaitingCard(queue, result.position ?? 1, waiter.id));
      }
      await this.handle(result.events);
    }
  }

  /** Registry before-delete seam. Synchronous and never throws. */
  onSessionDeleted(sessionKey: string): void {
    // The registry dropped the session's idle callbacks with it.
    this.idleWatched.delete(sessionKey);
    try {
      void this.handle(this.manager.forgetSession(sessionKey));
    } catch (error) {
      this.logger.warn('Work queue cleanup on session delete failed', { sessionKey, error: String(error) });
    }
  }

  async runTick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.handle(this.manager.tick());
    } catch (error) {
      this.logger.warn('Work queue sweep failed', { error: String(error) });
    } finally {
      this.ticking = false;
      if (this.manager.isIdle()) this.disarmSweep();
    }
  }

  /**
   * A turn of a holder went idle. Re-checked a moment later, because the
   * idle write alone is ambiguous: a turn's teardown removes its controller
   * after the write, and a turn aborted by the owner's newer message (a
   * supersede) writes idle while that newer turn is already registered.
   *   - waiting on its own question → keep (`holderIdleMinutes` applies);
   *   - a turn is running → keep, and listen for that turn's end;
   *   - otherwise the work is over → release.
   * A teardown slower than the re-check is left to the sweep.
   */
  private onHolderIdle(sessionKey: string): void {
    this.idleWatched.delete(sessionKey);
    (this.deps.defer ?? defaultDefer)(() => {
      const probe = this.deps.probe(sessionKey);
      if (probe.activity === 'waiting') return;
      if (probe.active) {
        this.watchIdle(sessionKey);
        return;
      }
      void this.handle(this.manager.releaseSession(sessionKey, 'ended'));
    }, IDLE_RECHECK_MS);
  }

  /** One idle hook per holder at a time (the registry drains them on idle). */
  private watchIdle(sessionKey: string): void {
    if (this.idleWatched.has(sessionKey)) return;
    this.idleWatched.add(sessionKey);
    this.deps.registerOnIdle?.(sessionKey, () => this.onHolderIdle(sessionKey));
  }

  private async handle(events: WorkQueueEvent[]): Promise<void> {
    for (const event of events) {
      try {
        await this.apply(event);
      } catch (error) {
        this.logger.warn('Work queue event failed', { type: event.type, error: String(error) });
      }
    }
  }

  private async apply(event: WorkQueueEvent): Promise<void> {
    if (event.type === 'released') {
      this.logger.info('Work queue slot released', {
        queue: event.queue.id,
        sessionKey: event.holder.sessionKey,
        reason: event.reason,
      });
      if (event.reason === 'unresponsive') {
        await this.post(event.holder.channel, slotReturnedText(event.queue), event.holder.threadTs);
      }
      return;
    }
    if (event.type === 'cancelled') {
      const { waiter, queue, reason } = event;
      this.logger.info('Work queue request cancelled', { queue: queue.id, sessionKey: waiter.sessionKey, reason });
      await this.updateCard(waiter, buildClosedCard(cancelledText(queue, reason)));
      if ((reason === 'ask-timeout' || reason === 'user') && !waiter.ranBefore) {
        // "해당 작업을 종료": the session made for this request never ran.
        try {
          this.deps.terminateSession?.(waiter.sessionKey);
        } catch (error) {
          this.logger.warn('Could not close the never-run session', {
            sessionKey: waiter.sessionKey,
            error: String(error),
          });
        }
      }
      return;
    }
    await this.startQueued(event.queue, event.waiter);
  }

  /** The slot is already reserved for `waiter`; run its request. */
  private async startQueued(queue: WorkQueueDef, waiter: WorkQueueWaiter): Promise<void> {
    const probe = this.deps.probe(waiter.sessionKey);
    // A session that is gone, or was reset (`new` clears the binding and the
    // workflow), is not the conversation that asked: never run the request in it.
    if (!probe.exists || probe.workflow !== queue.workflow || probe.workQueueId !== queue.id) {
      await this.updateCard(
        waiter,
        buildClosedCard(cancelledText(queue, probe.exists ? 'session-reset' : 'session-gone')),
      );
      await this.handle(this.manager.releaseSession(waiter.sessionKey, 'session-gone'));
      return;
    }
    const replay = this.replay;
    if (!replay) {
      this.logger.warn('Work queue cannot start a queued request — no replay handler', { queue: queue.id });
      await this.handle(this.manager.releaseSession(waiter.sessionKey, 'ended'));
      return;
    }
    this.logger.info('Work queue starting queued request', { queue: queue.id, sessionKey: waiter.sessionKey });
    const say = async (msg: any) =>
      this.deps.slackApi.postMessage(waiter.channel, msg?.text ?? '', {
        threadTs: waiter.threadTs,
        blocks: msg?.blocks,
      });
    // Same thread, no bot-thread migration: the slot is reserved for this key.
    void replay(
      {
        user: waiter.userId,
        channel: waiter.channel,
        thread_ts: waiter.threadTs,
        // No Slack message of its own: `handleMessage` mints the ts.
        ts: '',
        text: waiter.text,
        routeContext: { skipAutoBotThread: true },
      },
      say,
    ).catch((error) => {
      this.logger.warn('Queued request replay failed', { sessionKey: waiter.sessionKey, error: String(error) });
    });
    // After the replay is admitted — nothing awaits between the check above
    // and the admission, so a reset cannot slip in and receive the old request.
    await this.updateCard(waiter, buildClosedCard(startedText(queue)));
  }

  private async holderLine(holder: WorkQueueHolder): Promise<HolderLine> {
    const probe = this.deps.probe(holder.sessionKey);
    let permalink: string | undefined;
    try {
      permalink = (await this.deps.slackApi.getPermalink?.(holder.channel, holder.threadTs)) ?? undefined;
    } catch {
      permalink = undefined;
    }
    return {
      userId: holder.userId,
      permalink,
      minutes: Math.max(0, Math.floor((this.now() - holder.acquiredAt) / 60_000)),
      status: probe.active ? 'running' : probe.activity === 'waiting' ? 'waiting' : 'finishing',
    };
  }

  /**
   * Notices never throw: a card that cannot be edited (deleted, Slack down)
   * must not stop the queue's own effects — the replay, the session close.
   */
  private async updateCard(waiter: WorkQueueWaiter, card: { text: string; blocks: any[] }): Promise<void> {
    if (!waiter.cardTs) {
      await this.post(waiter.channel, card.text, waiter.threadTs);
      return;
    }
    try {
      await this.deps.slackApi.updateMessage(waiter.channel, waiter.cardTs, card.text, card.blocks);
    } catch (error) {
      this.logger.warn('Work queue card update failed', { sessionKey: waiter.sessionKey, error: String(error) });
    }
  }

  private async post(channel: string, text: string, threadTs: string): Promise<void> {
    try {
      await this.deps.slackApi.postMessage(channel, text, { threadTs });
    } catch (error) {
      this.logger.warn('Work queue notice failed', { channel, threadTs, error: String(error) });
    }
  }
}
