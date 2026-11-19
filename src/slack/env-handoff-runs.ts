/**
 * Environment hand-offs in flight, per requester thread (.prd/37 §5). `SkillForceHandler.runAsEnvironmentUser` starts
 * one when it hands a skill to an environment user, notes the environment user's thread once it opened, and ends it
 * when that run's work is over (its first turn ended and its thread holds no work-queue entry). While one runs, the
 * requester waits on the host, not on a person: no goal judgement, no follow-up question, RUNNING on the board.
 *
 * In memory: a restart cuts the hand-off anyway (the requester does not hear the end — a known limit).
 */

export interface EnvHandoffStatus {
  owner: string;
  since: number;
  /** The environment user's thread, once opened. */
  envThread?: { channel: string; threadTs: string };
}

export interface EnvHandoffRun {
  opened(channel: string, threadTs: string): void;
  /** Idempotent. */
  end(): void;
}

export class EnvHandoffRuns {
  private readonly byThread = new Map<string, EnvHandoffStatus[]>();

  constructor(private readonly now: () => number = Date.now) {}

  start(requester: { channel: string; threadTs: string }, owner: string): EnvHandoffRun {
    const key = `${requester.channel}\u0000${requester.threadTs}`;
    const status: EnvHandoffStatus = { owner, since: this.now() };
    const list = this.byThread.get(key) ?? [];
    list.push(status);
    this.byThread.set(key, list);
    return {
      opened: (channel, threadTs) => {
        status.envThread = { channel, threadTs };
      },
      end: () => {
        const live = this.byThread.get(key);
        if (!live) return;
        const at = live.indexOf(status);
        if (at >= 0) live.splice(at, 1);
        if (live.length === 0) this.byThread.delete(key);
      },
    };
  }

  /** The oldest run this thread still waits on. */
  statusFor(channel: string | undefined, threadTs: string | undefined): EnvHandoffStatus | undefined {
    if (!channel || !threadTs) return undefined;
    const first = this.byThread.get(`${channel}\u0000${threadTs}`)?.[0];
    return first ? { ...first, ...(first.envThread ? { envThread: { ...first.envThread } } : {}) } : undefined;
  }

  isRunning(channel: string | undefined, threadTs: string | undefined): boolean {
    return this.statusFor(channel, threadTs) !== undefined;
  }
}

/** The process's hand-offs (one per process). */
export const envHandoffRuns = new EnvHandoffRuns();
