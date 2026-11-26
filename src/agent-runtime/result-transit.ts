/**
 * How long a turn `result` waits between the read-ahead seeing it and the
 * frame loop handling it (`pumpFrames` → the loop in `claude-handler.ts`).
 *
 * WHY: for that whole gap a message pushed into the turn is refused (#1227),
 * and the turn's end, its settlement and the next queued message all wait for
 * the loop, which waits for Slack rendering. On a busy host the gap reached
 * about an hour (#1470) and the log never said so. This makes it a number:
 * the warning that decides whether turn control must stop waiting on Slack
 * (#1473) sooner.
 *
 * Neutral zone: no SDK import, no logger — the caller words the warning.
 */

/** A wait at or above this is worth a warning. */
export const HOST_LAG_WARN_MS = 5_000;

export interface HandledLag {
  /** How long the result just handled waited for the host. */
  waitedMs: number;
  /** Results that arrived after it and still wait. */
  stillInTransit: number;
  /** How long the oldest of those has waited (0 when none). */
  oldestInTransitMs: number;
}

export interface BehindLag {
  /** How long the oldest result still waiting has waited. */
  oldestInTransitMs: number;
  stillInTransit: number;
}

/** Every result of one run, fast ones included — what a p95 is read from. */
export interface TransitSummary {
  count: number;
  p95WaitMs: number;
  maxWaitMs: number;
}

export class ResultTransit {
  /** Arrival times of the results the loop has not handled yet, oldest first. */
  private readonly arrivals: number[] = [];
  /** How long each handled result waited, in handling order. */
  private readonly waits: number[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  get inTransit(): number {
    return this.arrivals.length;
  }

  /** The read-ahead saw a `result`. */
  arrived(): void {
    this.arrivals.push(this.now());
  }

  /**
   * The loop handled the oldest `result` in transit. Returns the numbers when
   * it waited {@link HOST_LAG_WARN_MS} or more, else `undefined`.
   */
  handled(): HandledLag | undefined {
    const at = this.arrivals.shift();
    if (at === undefined) return undefined;
    const now = this.now();
    const waitedMs = now - at;
    this.waits.push(waitedMs);
    if (waitedMs < HOST_LAG_WARN_MS) return undefined;
    const oldest = this.arrivals[0];
    return {
      waitedMs,
      stillInTransit: this.arrivals.length,
      oldestInTransitMs: oldest === undefined ? 0 : now - oldest,
    };
  }

  /** While a result has waited {@link HOST_LAG_WARN_MS} or more and is still not handled: the numbers. */
  behind(): BehindLag | undefined {
    const oldest = this.arrivals[0];
    if (oldest === undefined) return undefined;
    const oldestInTransitMs = this.now() - oldest;
    if (oldestInTransitMs < HOST_LAG_WARN_MS) return undefined;
    return { oldestInTransitMs, stillInTransit: this.arrivals.length };
  }

  /** The waits of every result handled so far, or `undefined` when none was. */
  summary(): TransitSummary | undefined {
    if (this.waits.length === 0) return undefined;
    const sorted = [...this.waits].sort((a, b) => a - b);
    return {
      count: sorted.length,
      p95WaitMs: sorted[Math.ceil(sorted.length * 0.95) - 1],
      maxWaitMs: sorted[sorted.length - 1],
    };
  }
}
