import { DATA_DIR } from '@soma/common/env-paths';
import { Logger } from '@soma/common/logger';
import * as fs from 'fs';
import * as path from 'path';
import type { FeedbackSentiment } from './turn-feedback-block-builder';

export type { FeedbackSentiment };

let getDataDir: () => string = () => DATA_DIR;

/** Override the DATA_DIR source (tests inject a temp dir). */
export function setTurnFeedbackStoreDataDirProvider(provider: () => string): void {
  getDataDir = provider;
}

function storeFile(): string {
  return path.join(getDataDir(), 'turn-feedback.json');
}

/** Records older than this are dropped — feedback is short-lived signal. */
const FEEDBACK_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * One feedback record. Primary key is `(turnId, userId)` — a given user may
 * flip 👍↔👎 on the same turn (the record is upserted, not appended), but two
 * users react independently.
 *
 * Minimal-data principle (codex c411a78a): identifiers + sentiment only. No raw
 * prompt/response text, no profile data, no channel names.
 */
export interface TurnFeedbackRecord {
  turnId: string;
  userId: string;
  channel: string;
  threadTs: string;
  /** ts of the completion-card message the buttons were attached to. */
  messageTs?: string;
  /** Turn category the feedback applies to (currently always WorkflowComplete). */
  category: string;
  sentiment: FeedbackSentiment;
  /** First time this (turnId, userId) was recorded. */
  createdAt: number;
  /** Last time the sentiment was written (changes on 👍→👎 flip). */
  updatedAt: number;
}

function compositeKey(turnId: string, userId: string): string {
  // NUL separator can't appear in Slack ids, so the join is unambiguous.
  return `${turnId}\u0000${userId}`;
}

export class TurnFeedbackStore {
  private byKey: Map<string, TurnFeedbackRecord> = new Map();
  private logger = new Logger('TurnFeedbackStore');

  /**
   * Upsert feedback for `(turnId, userId)`. Idempotent: a repeated click with
   * the same sentiment is a no-op write; a flipped sentiment updates in place
   * and bumps `updatedAt`. Returns the stored record.
   */
  record(input: {
    turnId: string;
    userId: string;
    channel: string;
    threadTs: string;
    messageTs?: string;
    category: string;
    sentiment: FeedbackSentiment;
  }): TurnFeedbackRecord {
    const key = compositeKey(input.turnId, input.userId);
    const now = Date.now();
    const existing = this.byKey.get(key);

    const record: TurnFeedbackRecord = existing
      ? {
          ...existing,
          // Refresh routing identifiers in case the message was re-posted.
          channel: input.channel,
          threadTs: input.threadTs,
          messageTs: input.messageTs ?? existing.messageTs,
          category: input.category,
          sentiment: input.sentiment,
          updatedAt: now,
        }
      : {
          turnId: input.turnId,
          userId: input.userId,
          channel: input.channel,
          threadTs: input.threadTs,
          messageTs: input.messageTs,
          category: input.category,
          sentiment: input.sentiment,
          createdAt: now,
          updatedAt: now,
        };

    this.byKey.set(key, record);
    // Opportunistic prune so a long-uptime process sheds expired records (the
    // file is rewritten in full on every write — without this it would only
    // shrink at restart). One O(n) pass over a human-paced write is cheap.
    this.pruneExpired();
    this.save();
    return record;
  }

  /** Drop expired records from the in-memory map. Caller persists afterward. */
  private pruneExpired(): void {
    for (const [key, record] of this.byKey) {
      if (this.isExpired(record)) this.byKey.delete(key);
    }
  }

  get(turnId: string, userId: string): TurnFeedbackRecord | undefined {
    return this.byKey.get(compositeKey(turnId, userId));
  }

  /** All feedback recorded for a turn (across users). */
  listForTurn(turnId: string): TurnFeedbackRecord[] {
    return Array.from(this.byKey.values()).filter((r) => r.turnId === turnId);
  }

  /** Shallow snapshot for tests/diagnostics. */
  list(): TurnFeedbackRecord[] {
    return Array.from(this.byKey.values());
  }

  private isExpired(record: TurnFeedbackRecord): boolean {
    return Date.now() - (record.createdAt || 0) > FEEDBACK_TTL_MS;
  }

  save(): void {
    try {
      fs.mkdirSync(getDataDir(), { recursive: true });
      const arr = Array.from(this.byKey.values());
      fs.writeFileSync(storeFile(), JSON.stringify(arr, null, 2));
      this.logger.debug(`Saved ${arr.length} turn-feedback records`);
    } catch (err) {
      this.logger.error('Failed to persist turn feedback', err);
    }
  }

  /** Rehydrate from disk, dropping malformed or expired records. */
  load(): number {
    const file = storeFile();
    if (!fs.existsSync(file)) return 0;
    try {
      const raw = fs.readFileSync(file, 'utf-8');
      const arr: TurnFeedbackRecord[] = JSON.parse(raw);
      let restored = 0;
      for (const record of arr) {
        if (!record || typeof record !== 'object') continue;
        if (!record.turnId || !record.userId) continue;
        if (record.sentiment !== 'positive' && record.sentiment !== 'negative') continue;
        if (this.isExpired(record)) continue;
        this.byKey.set(compositeKey(record.turnId, record.userId), record);
        restored += 1;
      }
      this.logger.info(`Loaded ${restored} turn-feedback records (${arr.length - restored} dropped)`);
      if (restored !== arr.length) this.save();
      return restored;
    } catch (err) {
      this.logger.error('Failed to load turn feedback', err);
      return 0;
    }
  }
}
