import { Logger } from '../logger.js';

const logger = new Logger('CompletionMessageTracker');

/** Turn completion categories - matches TurnCategory from turn-notifier */
type TurnCategory = 'UIUserAskQuestion' | 'WorkflowComplete' | 'Exception';

/**
 * Tracks turn completion message timestamps for later bulk deletion.
 * Error (Exception) messages are NOT tracked — they persist.
 * Trace: docs/turn-summary-lifecycle/trace.md, S6-S9
 */
export class CompletionMessageTracker {
  private tracked = new Map<string, Set<string>>();

  /**
   * Track a completion message for later deletion.
   * Exception category is excluded — error messages persist.
   * Trace: S6, Section 3b
   */
  track(sessionKey: string, messageTs: string, category: TurnCategory): void {
    if (category === 'Exception') return; // S9: errors persist
    let set = this.tracked.get(sessionKey);
    if (!set) {
      set = new Set();
      this.tracked.set(sessionKey, set);
    }
    set.add(messageTs);
    logger.debug('Tracked completion message', { sessionKey, messageTs, category });
  }

  /**
   * Delete all tracked messages for a session via Slack API.
   * Uses Promise.allSettled to tolerate individual failures.
   * Trace: S7, Section 3b
   */
  async deleteAll(
    sessionKey: string,
    deleteMessage: (channel: string, ts: string) => Promise<void>,
    channel: string,
  ): Promise<void> {
    const set = this.tracked.get(sessionKey);
    if (!set || set.size === 0) return;

    const timestamps = [...set];
    logger.info('Deleting completion messages', { sessionKey, count: timestamps.length });

    await Promise.allSettled(
      timestamps.map(ts => deleteMessage(channel, ts))
    );

    this.tracked.delete(sessionKey);
  }

  /** Check if there are tracked messages for a session */
  has(sessionKey: string): boolean {
    const set = this.tracked.get(sessionKey);
    return !!set && set.size > 0;
  }

  /** Get count of tracked messages for a session */
  count(sessionKey: string): number {
    return this.tracked.get(sessionKey)?.size ?? 0;
  }
}
