/**
 * An in-process ledger store with the same contract as {@link WorkQueueStore} (read · mutate · stamp): the host and
 * MCP tests run on it, so the queue's rules are checked on every runtime — `node:sqlite` exists only from Node 22.5.
 * Not shared between processes: never a runtime fallback.
 */
import { emptyLedger, type WorkQueueLedger } from './ledger';

export class MemoryWorkQueueStore {
  private ledger: WorkQueueLedger = emptyLedger();
  private rev = 0;

  read(): WorkQueueLedger {
    return this.ledger;
  }

  stamp(): string | undefined {
    return this.rev === 0 ? undefined : String(this.rev);
  }

  mutate<T>(fn: (ledger: WorkQueueLedger) => { ledger: WorkQueueLedger; result: T }): T {
    const { ledger, result } = fn(this.ledger);
    if (ledger !== this.ledger) {
      this.ledger = ledger;
      this.rev += 1;
    }
    return result;
  }

  close(): void {}
}
