/**
 * Environment work, one run at a time per environment user (SSOT 2026-11-19, owner: "QA든 배포든 큐가 있는 것들은
 * 자동으로 기다리게 — 입력 대기가 아니라 실행 중, 큐 대기로 표시").
 *
 * An environment user's skills (deploy, QA lane, …) share one lane on their host, guarded there by a lock: a second
 * run that starts while one holds it finds the lock taken and ends without doing anything. Before this queue the
 * requester was told "ended", so its model waited on its own — a background poll, a cron per task — and the goal loop
 * read the wait as a stall and asked the owner (a dev host, 2026-11-18/19: six NEEDS YOU cards, two runaway crons).
 *
 * Now every hand-off (`SkillForceHandler.runAsEnvironmentUser`: typed `$<env>:<skill>`, a model's RUN_ENV_SKILL, a
 * cron's forced skill) goes through {@link EnvRunQueue.run}: a run starts only when no other run of that environment
 * user is in flight — neither one this queue started nor (the busy probe) a turn of that user that started elsewhere
 * (its own cron, a restart resume). The rest wait in arrival order and start by themselves; the requester hears the
 * outcome when its run ended, exactly as before. While a request waits or runs, its requester's session is waiting on
 * the host, not on a person: the goal loop does not judge it, no follow-up question is asked, and the board shows it
 * in RUNNING (`queued` tinted apart from `running`).
 *
 * In memory only: a restart drops the waiting requests (their requesters are not woken). Known limit — follow-up.
 */
import { Logger } from '../logger';

const logger = new Logger('EnvRunQueue');

/** How often a waiting head re-checks an environment the busy probe reported busy. */
export const ENV_RUN_QUEUE_POLL_MS = 15_000;

/** One hand-off: whose environment, and the thread that asked (the requester's session). */
export interface EnvRunTicket {
  owner: string;
  channel: string;
  threadTs: string;
  /** What runs, for people (`` `full-deploy-dev2` ``). */
  skills: string;
}

/** A requester thread's place: its run waits (`queued`) or is in flight (`running`). */
export interface EnvRunStatus {
  state: 'queued' | 'running';
  owner: string;
  skills: string;
  /** Epoch ms it entered the state it is in now. */
  since: number;
  /** `queued` only — its place among the waiting runs of that environment: 1 starts next. */
  position?: number;
}

interface Entry extends EnvRunTicket {
  enqueuedAt: number;
  startedAt?: number;
  start: () => Promise<unknown>;
  settle: (outcome: { ok: true; value: unknown } | { ok: false; error: unknown }) => void;
}

export interface EnvRunQueueOptions {
  now?: () => number;
  /** Schedules a re-check of a busy environment (production: an unref'd `setTimeout`). */
  schedule?: (fn: () => void, delayMs: number) => void;
  pollMs?: number;
}

export class EnvRunQueue {
  private readonly byOwner = new Map<string, Entry[]>();
  private readonly recheckArmed = new Set<string>();
  private busyProbe?: (owner: string) => boolean;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, delayMs: number) => void;
  private readonly pollMs: number;

  constructor(options: EnvRunQueueOptions = {}) {
    this.now = options.now ?? Date.now;
    this.schedule =
      options.schedule ??
      ((fn, delayMs) => {
        const timer = setTimeout(fn, delayMs);
        (timer as { unref?: () => void }).unref?.();
      });
    this.pollMs = options.pollMs ?? ENV_RUN_QUEUE_POLL_MS;
  }

  /**
   * True while a turn of `owner` that this queue did not start is in flight (wired in `src/index.ts`: a session of
   * that environment user working). A probe that throws reads as not busy — the lane's own lock still guards it.
   */
  setBusyProbe(probe: ((owner: string) => boolean) | undefined): void {
    this.busyProbe = probe;
  }

  /**
   * Run `start` once the environment is free. `ahead` is what waits before it now (runs in flight or queued, or 1
   * when only a busy environment holds it back) — 0 means it started at once. `result` settles with `start`'s.
   */
  run<T>(ticket: EnvRunTicket, start: () => Promise<T>): { ahead: number; result: Promise<T> } {
    const list = this.byOwner.get(ticket.owner) ?? [];
    let settle!: Entry['settle'];
    const result = new Promise<T>((resolve, reject) => {
      settle = (outcome) => (outcome.ok ? resolve(outcome.value as T) : reject(outcome.error));
    });
    const entry: Entry = { ...ticket, enqueuedAt: this.now(), start, settle };
    list.push(entry);
    this.byOwner.set(ticket.owner, list);
    this.pump(ticket.owner);
    const ahead = entry.startedAt !== undefined ? 0 : Math.max(1, list.indexOf(entry));
    if (ahead > 0) {
      logger.info('Environment run queued', { owner: ticket.owner, ahead, skills: ticket.skills });
    }
    return { ahead, result };
  }

  /** Where the run a requester thread asked for stands; undefined when it has none waiting or in flight. */
  statusFor(channel: string | undefined, threadTs: string | undefined): EnvRunStatus | undefined {
    if (!channel || !threadTs) return undefined;
    let queued: EnvRunStatus | undefined;
    for (const list of this.byOwner.values()) {
      let waitingBefore = 0;
      for (const e of list) {
        const mine = e.channel === channel && e.threadTs === threadTs;
        if (e.startedAt !== undefined) {
          if (mine) return { state: 'running', owner: e.owner, skills: e.skills, since: e.startedAt };
          continue;
        }
        waitingBefore++;
        if (mine && !queued) {
          queued = {
            state: 'queued',
            owner: e.owner,
            skills: e.skills,
            since: e.enqueuedAt,
            position: waitingBefore,
          };
        }
      }
    }
    return queued;
  }

  /** True while a run this thread asked for waits or is in flight: its session waits on the host, not a person. */
  isPending(channel: string | undefined, threadTs: string | undefined): boolean {
    return this.statusFor(channel, threadTs) !== undefined;
  }

  private isBusy(owner: string): boolean {
    try {
      return this.busyProbe?.(owner) === true;
    } catch (error) {
      logger.warn('Environment busy probe failed — treated as free', {
        owner,
        error: (error as Error)?.message ?? String(error),
      });
      return false;
    }
  }

  /** Start the owner's head when nothing of that environment is in flight; re-check later when it is busy. */
  private pump(owner: string): void {
    const list = this.byOwner.get(owner);
    const head = list?.[0];
    if (!list || !head) {
      this.byOwner.delete(owner);
      return;
    }
    if (head.startedAt !== undefined) return;
    if (this.isBusy(owner)) {
      if (!this.recheckArmed.has(owner)) {
        this.recheckArmed.add(owner);
        this.schedule(() => {
          this.recheckArmed.delete(owner);
          this.pump(owner);
        }, this.pollMs);
      }
      return;
    }
    head.startedAt = this.now();
    if (head.startedAt - head.enqueuedAt > 0) {
      logger.info('Queued environment run starting', {
        owner,
        skills: head.skills,
        waitedMs: head.startedAt - head.enqueuedAt,
      });
    }
    const finish = (outcome: Parameters<Entry['settle']>[0]): void => {
      const live = this.byOwner.get(owner);
      const at = live ? live.indexOf(head) : -1;
      if (live && at >= 0) live.splice(at, 1);
      head.settle(outcome);
      this.pump(owner);
    };
    let started: Promise<unknown>;
    try {
      started = Promise.resolve(head.start());
    } catch (error) {
      started = Promise.reject(error);
    }
    started.then(
      (value) => finish({ ok: true, value }),
      (error: unknown) => finish({ ok: false, error }),
    );
  }
}

/** A turn of an environment user older than this reads as stale, not busy (a session left `working` by a crash). */
export const ENV_BUSY_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** The session fields {@link environmentBusy} reads. */
export interface EnvBusySession {
  ownerId?: string;
  activityState?: string;
  activityStateChangedAt?: number;
  terminated?: boolean;
  state?: string;
}

/**
 * The busy probe's rule: a live session of `owner` is working a turn that began within {@link ENV_BUSY_MAX_AGE_MS}.
 * That is a run this queue did not start — the environment user's own cron, a restart resume — whose lane lock a run
 * started now would find taken.
 */
export function environmentBusy(
  owner: string,
  sessions: Iterable<EnvBusySession>,
  now: number,
  maxAgeMs = ENV_BUSY_MAX_AGE_MS,
): boolean {
  for (const s of sessions) {
    if (s.ownerId !== owner || s.terminated || s.state === 'SLEEPING') continue;
    if (s.activityState !== 'working') continue;
    const since = Number(s.activityStateChangedAt);
    if (Number.isFinite(since) && now - since <= maxAgeMs) return true;
  }
  return false;
}

/** The host's queue (one per process): the hand-off path, the goal loop, the follow-up question and the board read it. */
export const envRunQueue = new EnvRunQueue();
